// Talking to the learner's Neovim over its socket (`nvim --listen`), and finding the agent's
// terminal for the learner's questions.
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { AxiError } from "axi-sdk-js";

export function socketPath(): string {
  return process.env.NVIM_TOUR_SOCK || `/tmp/nvim-tour-${process.env.USER || "user"}.sock`;
}

export function socketExists(sock = socketPath()): boolean {
  try {
    return statSync(sock).isSocket();
  } catch {
    return false;
  }
}

export function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // not here
    }
  }
  return undefined;
}

// Vimscript single-quoted string: only `'` needs escaping, by doubling it.
function vimString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

export interface LuaOptions {
  sock?: string;
  timeoutMs?: number;
}

// Evaluates a Lua expression in the learner's Neovim; `_A` is the JSON-decoded argument.
// Uses `--remote-expr`, never `--remote-send`: users' mappings would turn sent keys into actions.
export function nvimLua(code: string, arg: unknown = null, options: LuaOptions = {}): string {
  const sock = options.sock ?? socketPath();
  if (!socketExists(sock)) {
    throw new AxiError(`no Neovim listening on ${sock}`, "NO_NEOVIM", [
      "Run `nvim-tour-axi open <root>` to open one beside you",
      `Or ask the user to start theirs with \`nvim --listen ${sock}\` (or set NVIM_TOUR_SOCK to their socket)`,
    ]);
  }
  const expr = `luaeval(${vimString(code)}, json_decode(${vimString(JSON.stringify(arg))}))`;
  const r = spawnSync("nvim", ["--server", sock, "--remote-expr", expr], {
    encoding: "utf-8",
    timeout: options.timeoutMs ?? 10_000,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new AxiError("nvim is not on PATH", "NO_NVIM_BINARY", ["Install Neovim 0.10 or newer"]);
    }
    throw new AxiError(`nvim --remote-expr failed: ${r.error.message}`, "NEOVIM_ERROR");
  }
  const stderr = (r.stderr ?? "").trim();
  if (r.status !== 0 || stderr !== "") {
    // The first line names the error; the rest is Neovim's stack traceback.
    throw new AxiError(stderr.split("\n")[0] || `nvim --remote-expr exited ${r.status}`, "NEOVIM_ERROR", [
      `Check that the Neovim on ${sock} is responsive`,
    ]);
  }
  return r.stdout ?? "";
}

export interface Transport {
  kind: "rex" | "tmux" | "file";
  target: string;
  bin?: string;
}

// Where the learner's messages go: this agent's own terminal (Rex block, tmux pane), else an inbox
// file next to the course. NVIM_TOUR_TRANSPORT = auto | rex:<block> | tmux:<pane> | file:<path>.
export function resolveTransport(course: string): Transport {
  let spec = process.env.NVIM_TOUR_TRANSPORT || "auto";
  if (spec === "auto") {
    if (process.env.REX_BLOCK && findOnPath("rex")) {
      spec = `rex:${process.env.REX_BLOCK}`;
    } else if (process.env.TMUX_PANE && findOnPath("tmux")) {
      spec = `tmux:${process.env.TMUX_PANE}`;
    } else {
      spec = `file:${course}.inbox`;
    }
  }
  const colon = spec.indexOf(":");
  const kind = colon < 0 ? spec : spec.slice(0, colon);
  const target = colon < 0 ? "" : spec.slice(colon + 1);
  if (kind === "rex" || kind === "tmux") {
    // Absolute path: a Neovim started by the multiplexer may not have the agent's PATH.
    const bin = findOnPath(kind);
    if (!bin) {
      throw new AxiError(`${kind} is not on PATH`, "VALIDATION_ERROR", [
        "Set NVIM_TOUR_TRANSPORT=file:<path> to collect questions in a file instead",
      ]);
    }
    return { kind, target, bin };
  }
  if (kind === "file") {
    return { kind, target };
  }
  throw new AxiError(`unknown transport \`${spec}\``, "VALIDATION_ERROR", [
    "Set NVIM_TOUR_TRANSPORT to auto, rex:<block>, tmux:<pane> or file:<path>",
  ]);
}

export function describeTransport(t: Transport): string {
  return `${t.kind}:${t.target}`;
}
