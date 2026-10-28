// nvim-tour-axi: open Neovim beside the agent, load the tour plugin ad hoc, extend and check the
// course, and see where the learner is.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError, runAxiCli } from "axi-sdk-js";
import { addChapter, checkCourse } from "./course.js";
import {
  describeTransport,
  findOnPath,
  nvimLua,
  resolveTransport,
  socketExists,
  socketPath,
} from "./nvim.js";
import { setupCommand, SETUP_HELP } from "./setup.js";

// A command's structured result, rendered as TOON by the AXI runtime.
type Output = Record<string, unknown>;

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_DIR = resolve(PACKAGE_ROOT, "plugin");
export const SKILL_DIR = resolve(PACKAGE_ROOT, "skills", "nvim-tour");

const DESCRIPTION =
  "Guided code tours in the user's Neovim: the agent writes a course, the bundled plugin shows each step beside the code";

const TOP_LEVEL_HELP = `usage: nvim-tour-axi <command> [args] [flags]
commands:
  open [ROOT]                       open Neovim beside this agent (Rex or tmux), listening on the tour socket
  load COURSE [ROOT] [LANG]         load the plugin into that Neovim and start the course (LANG: en | tr)
  add COURSE CHAPTER [AFTER_ID]     add a chapter (atomic; skips known ids), after a step if given
  check COURSE [ROOT]               verify every step: file exists, lines in range, anchor present
  where                             the learner's current step
  go STEP                           jump to a step number or id
  unload                            close the panel, clear marks, stop watching
  setup [skill|hooks] [--remove]    install the bundled skill or session hooks for agent harnesses
ROOT defaults to the current directory.
env:
  NVIM_TOUR_SOCK       Neovim socket (default /tmp/nvim-tour-$USER.sock)
  NVIM_TOUR_TRANSPORT  where the learner's questions go: auto | rex:<block> | tmux:<pane> | file:<path> (default auto)
Run \`nvim-tour-axi <command> --help\` for one command.
`;

const COMMAND_HELP: Record<string, string> = {
  open: `usage: nvim-tour-axi open [ROOT]
Opens Neovim at ROOT beside this agent: inside Rex it splits your block, inside tmux it splits your pane.
Otherwise it prints the command for the user to run in another terminal.
If a Neovim already listens on the socket, it is reused.
`,
  load: `usage: nvim-tour-axi load COURSE [ROOT] [LANG]
Loads the bundled plugin into the Neovim on the socket (nothing is installed) and starts COURSE.
Step files are relative to ROOT (default: current directory). LANG is the UI language: en (default) or tr.
Loading again replaces the earlier instance: watcher, panel and highlights.
`,
  add: `usage: nvim-tour-axi add COURSE CHAPTER [AFTER_ID]
Adds CHAPTER's steps (a JSON array, or an object with \`steps\`) to COURSE, creating it if missing.
Steps whose id already exists are skipped; with AFTER_ID they are inserted after that step.
The write is atomic and a loaded Neovim reloads live, keeping the learner's place.
`,
  check: `usage: nvim-tour-axi check COURSE [ROOT]
Verifies every step: the file exists under ROOT, range and marks lie inside it, the anchor is on the range's first line.
Exits 1 when there is any problem.
`,
  where: `usage: nvim-tour-axi where
The learner's current step: idx, id and total.
`,
  go: `usage: nvim-tour-axi go STEP
Moves the learner to STEP, a step number (1-based) or a step id.
`,
  unload: `usage: nvim-tour-axi unload
Closes the panel, clears highlights and notes, and stops watching the course.
`,
  setup: SETUP_HELP,
};

interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
}

// Strict parsing: an unknown flag or a surplus argument fails loud instead of being ignored.
export function parseArgs(
  command: string,
  args: string[],
  spec: { min: number; max: number; flags?: string[] },
): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  for (const a of args) {
    if (a.startsWith("-") && !/^-\d+$/.test(a)) {
      if (!spec.flags?.includes(a)) {
        throw new AxiError(`unknown flag ${a} for \`${command}\``, "VALIDATION_ERROR", [
          `Run \`nvim-tour-axi ${command} --help\``,
        ]);
      }
      flags.add(a);
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length < spec.min || positionals.length > spec.max) {
    const usage = COMMAND_HELP[command]?.split("\n")[0] ?? command;
    throw new AxiError(`wrong number of arguments for \`${command}\``, "VALIDATION_ERROR", [usage]);
  }
  return { positionals, flags };
}

function directory(path: string): string {
  const abs = resolve(path);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new AxiError(`no directory ${abs}`, "NOT_FOUND");
  }
  return abs;
}

// Lua expression returning the learner's position as JSON, or "" when no tour is loaded.
const WHERE_LUA = `(function()
  local S = rawget(_G, "__nvim_tour")
  if not S or not S.cfg or S.unloaded then return "" end
  local w = require("nvim_tour").where()
  local step = S.course.steps[S.idx]
  w.title = step and step.title or nil
  w.course = S.cfg.course
  return vim.json.encode(w)
end)()`;

interface Where {
  idx: number;
  id?: string;
  title?: string;
  total: number;
  course: string;
}

function readWhere(timeoutMs?: number): Where | undefined {
  const out = nvimLua(WHERE_LUA, null, { timeoutMs }).trim();
  return out === "" ? undefined : (JSON.parse(out) as Where);
}

function whereOutput(w: Where): Output {
  return { where: { idx: w.idx, total: w.total, id: w.id ?? null, title: w.title ?? null } };
}

function requireWhere(): Where {
  const w = readWhere();
  if (!w) {
    throw new AxiError("no tour is loaded in this Neovim", "NO_TOUR", [
      "Run `nvim-tour-axi load <course> <root>`",
    ]);
  }
  return w;
}

async function home(): Promise<Output> {
  const sock = socketPath();
  const out: Output = { socket: sock };
  if (!socketExists(sock)) {
    out.neovim = "not listening";
    out.help = [
      "Run `nvim-tour-axi open <root>` to open Neovim beside you, then `nvim-tour-axi load <course> <root>`",
    ];
    return out;
  }
  let w: Where | undefined;
  try {
    w = readWhere(2_000);
  } catch {
    out.neovim = "not responding";
    out.help = ["Run `nvim-tour-axi open <root>` to replace the stale socket"];
    return out;
  }
  out.neovim = "listening";
  if (!w) {
    out.tour = "none loaded";
    out.help = ["Run `nvim-tour-axi load <course> <root>`"];
    return out;
  }
  out.course = w.course;
  Object.assign(out, whereOutput(w));
  out.help = [
    "Run `nvim-tour-axi add <course> <chapter.json>` to write the next chapter",
    "Run `nvim-tour-axi go <step>` to move the learner",
  ];
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function open(args: string[]): Promise<Output> {
  const { positionals } = parseArgs("open", args, { min: 0, max: 1 });
  const root = directory(positionals[0] ?? ".");
  const sock = socketPath();
  if (socketExists(sock)) {
    try {
      nvimLua("1", null, { timeoutMs: 2_000 });
      return {
        neovim: "already listening",
        socket: sock,
        help: [`Run \`nvim-tour-axi load <course> ${root}\``],
      };
    } catch (error) {
      // Without an nvim binary the probe proves nothing about the socket; keep it.
      if (error instanceof AxiError && error.code === "NO_NVIM_BINARY") {
        throw error;
      }
      rmSync(sock, { force: true });
    }
  }
  const rex = process.env.REX_BLOCK ? findOnPath("rex") : undefined;
  const tmux = process.env.TMUX_PANE ? findOnPath("tmux") : undefined;
  let r;
  if (rex) {
    r = spawnSync(
      rex,
      [
        "run",
        "-b",
        process.env.REX_BLOCK!,
        "--split=right",
        "--ratio",
        "55",
        "--focus=false",
        "--label",
        "nvim-tour",
        "-c",
        root,
        "--",
        "nvim",
        "--listen",
        sock,
      ],
      { encoding: "utf-8" },
    );
  } else if (tmux) {
    r = spawnSync(
      tmux,
      [
        "split-window",
        "-h",
        "-d",
        "-l",
        "55%",
        "-t",
        process.env.TMUX_PANE!,
        "-c",
        root,
        `nvim --listen '${sock}'`,
      ],
      { encoding: "utf-8" },
    );
  } else {
    return {
      neovim: "not opened",
      reason: "no Rex or tmux here",
      run: `cd '${root}' && nvim --listen '${sock}'`,
      help: [
        "Ask the user to run the `run` command in another terminal, then `nvim-tour-axi load <course> <root>`",
      ],
    };
  }
  if (r.status !== 0) {
    throw new AxiError(
      `${rex ? "rex" : "tmux"} could not open Neovim: ${(r.stderr || r.error?.message || "").trim()}`,
      "OPEN_FAILED",
    );
  }
  for (let i = 0; i < 30; i += 1) {
    if (socketExists(sock)) {
      return {
        neovim: "listening",
        socket: sock,
        via: rex ? "rex" : "tmux",
        help: [`Run \`nvim-tour-axi load <course> ${root}\``],
      };
    }
    await sleep(200);
  }
  throw new AxiError(`Neovim did not open ${sock}`, "OPEN_FAILED");
}

async function load(args: string[]): Promise<Output> {
  const { positionals } = parseArgs("load", args, { min: 1, max: 3 });
  const course = resolve(positionals[0]);
  if (!existsSync(course)) {
    throw new AxiError(`no course file ${course}`, "NOT_FOUND", [
      "Run `nvim-tour-axi add <course> <chapter.json>` to create it",
    ]);
  }
  const root = directory(positionals[1] ?? ".");
  const lang = positionals[2] ?? "en";
  const transport = resolveTransport(course);
  nvimLua("vim.opt.rtp:append(_A)", PLUGIN_DIR);
  const errmsg = nvimLua(
    '(function(c) vim.v.errmsg = ""; package.loaded["nvim_tour"] = nil; require("nvim_tour").setup(c); return vim.v.errmsg end)(_A)',
    { course, root, lang, transport },
  ).trim();
  const out: Output = {
    loaded: { course, root, lang, transport: describeTransport(transport) },
  };
  if (errmsg !== "") {
    out.neovim_error = errmsg;
  }
  Object.assign(out, whereOutput(requireWhere()));
  out.help = [
    "Tell the user the keys: panel n next, p previous, l list, a ask, r reload, q close; in code <leader>kn/kp/ka/kk",
    transport.kind === "file"
      ? `The learner's questions go to ${transport.target}; read it when they say they asked`
      : "The learner's questions arrive in this terminal",
  ];
  return out;
}

async function add(args: string[]): Promise<Output> {
  const { positionals } = parseArgs("add", args, { min: 2, max: 3 });
  const [course, chapter, after] = positionals;
  const r = addChapter(resolve(course), resolve(chapter), after);
  return {
    added: r.added,
    skipped: r.skipped,
    steps: r.total,
    help: [`Run \`nvim-tour-axi check ${course} <root>\``],
  };
}

async function check(args: string[]): Promise<Output> {
  const { positionals } = parseArgs("check", args, { min: 1, max: 2 });
  const course = resolve(positionals[0]);
  const root = directory(positionals[1] ?? ".");
  const r = checkCourse(course, root);
  if (r.problems.length > 0) {
    process.exitCode = 1;
    return {
      steps: r.steps,
      problems: r.problems,
      help: ["Fix each problem in the course (or the chapter before adding it), then check again"],
    };
  }
  return { steps: r.steps, problems: 0 };
}

async function where(args: string[]): Promise<Output> {
  parseArgs("where", args, { min: 0, max: 0 });
  return whereOutput(requireWhere());
}

async function go(args: string[]): Promise<Output> {
  const { positionals } = parseArgs("go", args, { min: 1, max: 1 });
  const target = positionals[0];
  const result = nvimLua(
    `(function(s)
      local S = rawget(_G, "__nvim_tour")
      if not S or not S.cfg or S.unloaded then return "no-tour" end
      local n = tonumber(s)
      if not n then
        local found = false
        for _, st in ipairs(S.course.steps) do
          if st.id == s then found = true end
        end
        if not found then return "no-step" end
      end
      require("nvim_tour").go(n or s)
      return "ok"
    end)(_A)`,
    target,
  ).trim();
  if (result === "no-tour") {
    requireWhere();
  }
  if (result === "no-step") {
    throw new AxiError(`no step \`${target}\` in the course`, "NOT_FOUND", [
      "Run `nvim-tour-axi where` for the course's size",
    ]);
  }
  return whereOutput(requireWhere());
}

async function unload(args: string[]): Promise<Output> {
  parseArgs("unload", args, { min: 0, max: 0 });
  const result = nvimLua(`(function()
    local S = rawget(_G, "__nvim_tour")
    if not S or not S.cfg or S.unloaded then return "none" end
    if S.watcher and not S.watcher:is_closing() then S.watcher:stop(); S.watcher:close() end
    require("nvim_tour").close_panel()
    if S.marked_buf and vim.api.nvim_buf_is_valid(S.marked_buf) then
      vim.api.nvim_buf_clear_namespace(S.marked_buf, vim.api.nvim_create_namespace("nvim_tour"), 0, -1)
    end
    S.unloaded = true
    return "unloaded"
  end)()`).trim();
  return { tour: result === "none" ? "none loaded" : "unloaded" };
}

function packageVersion(): string | undefined {
  try {
    return (JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8")) as { version?: string })
      .version;
  } catch {
    return undefined;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: packageVersion(),
    argv,
    topLevelHelp: TOP_LEVEL_HELP,
    getCommandHelp: (command) => COMMAND_HELP[command],
    home,
    commands: {
      open,
      load,
      add,
      check,
      where,
      go,
      unload,
      setup: (args) => setupCommand(args, SKILL_DIR),
    },
  });
}
