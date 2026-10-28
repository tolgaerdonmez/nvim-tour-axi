// End-to-end tests of the built CLI (`npm test` builds first). The Neovim tests drive a real
// `nvim --headless --listen` and are skipped when nvim is not installed.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist", "bin", "nvim-tour-axi.js");
const EXAMPLE = join(ROOT, "examples", "course.json");
const HAS_NVIM = spawnSync("nvim", ["--version"]).status === 0;

// Short base path: Unix socket paths are limited to about 100 bytes.
const scratch = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ntx-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.REX_BLOCK;
  delete env.TMUX_PANE;
  return env;
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    env: baseEnv({ NVIM_TOUR_SOCK: join(scratch, "none.sock"), ...env }),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function writeJson(name, value) {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("without Neovim", () => {
  test("home view reports that no Neovim is listening", () => {
    const r = run([]);
    assert.equal(r.code, 0);
    assert.match(r.out, /^bin: /m);
    assert.match(r.out, /^description: /m);
    assert.match(r.out, /^neovim: not listening$/m);
    assert.match(r.out, /nvim-tour-axi open <root>/);
  });

  test("where fails with a structured error", () => {
    const r = run(["where"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /^error: no Neovim listening on /m);
    assert.match(r.out, /^code: NO_NEOVIM$/m);
  });

  test("unknown commands, flags and argument counts exit 2", () => {
    assert.equal(run(["nope"]).code, 2);
    const flag = run(["check", EXAMPLE, "--bogus"]);
    assert.equal(flag.code, 2);
    assert.match(flag.out, /unknown flag --bogus/);
    assert.equal(run(["go"]).code, 2);
    assert.equal(run(["where", "extra"]).code, 2);
  });

  test("--help and per-command help", () => {
    assert.match(run(["--help"]).out, /load COURSE \[ROOT\] \[LANG\]/);
    assert.match(run(["check", "--help"]).out, /^usage: nvim-tour-axi check COURSE \[ROOT\]/);
  });
});

describe("check", () => {
  test("the example course has no problems", () => {
    const r = run(["check", EXAMPLE, ROOT]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^steps: 5$/m);
    assert.match(r.out, /^problems: 0$/m);
  });

  test("ROOT defaults to the current directory", () => {
    assert.equal(run(["check", EXAMPLE]).code, 0);
  });

  test("reports every problem and exits 1", () => {
    const course = writeJson("broken.json", {
      steps: [
        { id: "text", title: "text only" },
        { id: "missing", title: "m", file: "no/such/file.ts", range: [1, 2] },
        { id: "range", title: "r", file: "package.json", range: [1, 9999] },
        { id: "mark", title: "k", file: "package.json", range: [1, 2], marks: [{ line: 0, text: "x" }] },
        { id: "anchor", title: "a", file: "package.json", range: [2, 3], anchor: "not here" },
      ],
    });
    const r = run(["check", course, ROOT]);
    assert.equal(r.code, 1);
    assert.match(r.out, /^steps: 5$/m);
    assert.match(r.out, /problems\[4\]\{step,id,problem\}:/);
    assert.match(r.out, /2,missing,no file no\/such\/file\.ts/);
    assert.match(r.out, /3,range,range 1-9999 outside 1-\d+/);
    assert.match(r.out, /4,mark,mark line 0 outside the file/);
    assert.match(r.out, /5,anchor,"anchor \\"not here\\" not on line 2"/);
  });

  test("a range may end on the last line but not past it", () => {
    const file = join(scratch, "three.txt");
    writeFileSync(file, "a\nb\nc\n");
    const ok = writeJson("last-ok.json", { steps: [{ id: "x", title: "x", file, range: [1, 3] }] });
    const bad = writeJson("last-bad.json", { steps: [{ id: "x", title: "x", file, range: [1, 4] }] });
    assert.equal(run(["check", ok, ROOT]).code, 0);
    assert.equal(run(["check", bad, ROOT]).code, 1);
  });

  test("an unreadable course is a structured error", () => {
    const r = run(["check", join(scratch, "absent.json"), ROOT]);
    assert.equal(r.code, 1);
    assert.match(r.out, /^code: NOT_FOUND$/m);
  });
});

describe("add", () => {
  test("creates the course, skips known ids and inserts after a step", () => {
    const course = join(scratch, "added.json");
    const ch1 = writeJson("ch1.json", {
      title: "my course",
      steps: [
        { id: "a", title: "A" },
        { id: "c", title: "C" },
      ],
    });
    let r = run(["add", course, ch1]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^added: 2$/m);
    assert.match(r.out, /^steps: 2$/m);

    r = run(["add", course, ch1]);
    assert.match(r.out, /^added: 0$/m);
    assert.match(r.out, /^skipped: 2$/m);

    const ch2 = writeJson("ch2.json", [
      { id: "b", title: "B" },
      { id: "a", title: "A again" },
    ]);
    r = run(["add", course, ch2, "a"]);
    assert.match(r.out, /^added: 1$/m);
    const saved = JSON.parse(readFileSync(course, "utf-8"));
    assert.equal(saved.title, "my course");
    assert.deepEqual(
      saved.steps.map((s) => s.id),
      ["a", "b", "c"],
    );
    assert.equal(saved.steps[0].title, "A");
    assert.equal(existsSync(`${course}.tmp`), false);
  });

  test("rejects steps without id or title and leaves the course alone", () => {
    const course = writeJson("keep.json", { title: "", steps: [{ id: "a", title: "A" }] });
    const before = readFileSync(course, "utf-8");
    const bad = writeJson("bad-chapter.json", [{ id: "b" }]);
    const r = run(["add", course, bad]);
    assert.equal(r.code, 1);
    assert.match(r.out, /every step needs `id` and `title`/);
    assert.equal(readFileSync(course, "utf-8"), before);
  });

  test("an unknown AFTER_ID is an error", () => {
    const course = writeJson("after.json", { steps: [{ id: "a", title: "A" }] });
    const ch = writeJson("after-ch.json", [{ id: "b", title: "B" }]);
    const r = run(["add", course, ch, "zzz"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /no step `zzz` to insert after/);
  });
});

describe("with a headless Neovim", { skip: !HAS_NVIM && "nvim is not installed" }, () => {
  let sock;
  let course;
  let nvim;
  const env = () => ({ NVIM_TOUR_SOCK: sock, NVIM_TOUR_TRANSPORT: `file:${join(scratch, "inbox")}` });
  const expr = (e) =>
    spawnSync("nvim", ["--server", sock, "--remote-expr", e], { encoding: "utf-8" }).stdout.trim();

  before(async () => {
    sock = join(scratch, "n.sock");
    course = join(scratch, "course.json");
    copyFileSync(EXAMPLE, course);
    nvim = spawn("nvim", ["--headless", "--clean", "--listen", sock], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 50 && !existsSync(sock); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(existsSync(sock), "headless Neovim did not open its socket");
  });

  after(() => nvim?.kill());

  test("home view and where before loading", () => {
    const home = run([], env());
    assert.match(home.out, /^neovim: listening$/m);
    assert.match(home.out, /^tour: none loaded$/m);
    const w = run(["where"], env());
    assert.equal(w.code, 1);
    assert.match(w.out, /^code: NO_TOUR$/m);
  });

  test("open reuses a Neovim already listening", () => {
    const r = run(["open", ROOT], env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^neovim: already listening$/m);
  });

  test("load starts the course at step 1 with the panel open", () => {
    const r = run(["load", course, ROOT], env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^loaded:$/m);
    assert.match(r.out, /^  transport: "file:/m);
    assert.match(r.out, /^  idx: 1$/m);
    assert.match(r.out, /^  total: 5$/m);
    assert.match(r.out, /^  id: intro$/m);
    assert.equal(expr("len(nvim_list_wins())"), "2");
  });

  test("go by id and by number, then where", () => {
    let r = run(["go", "transport"], env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^  idx: 3$/m);
    assert.match(r.out, /^  id: transport$/m);
    assert.match(expr("bufname(winbufnr(1))"), /src\/nvim\.ts$/);

    r = run(["go", "4"], env());
    assert.match(r.out, /^  id: anchor$/m);
    r = run(["where"], env());
    assert.match(r.out, /^  idx: 4$/m);
    assert.match(r.out, /^  title: Anchors survive edits$/m);
  });

  test("go to an unknown id fails and keeps the learner's place", () => {
    const r = run(["go", "nope"], env());
    assert.equal(r.code, 1);
    assert.match(r.out, /^code: NOT_FOUND$/m);
    assert.match(run(["where"], env()).out, /^  id: anchor$/m);
  });

  test("home view shows the loaded course and position", () => {
    const r = run([], env());
    assert.match(r.out, new RegExp(`^course: ${course.replaceAll("/", "\\/")}$`, "m"));
    assert.match(r.out, /^  id: anchor$/m);
  });

  test("add reloads Neovim live and keeps the learner's place", async () => {
    const ch = writeJson("live.json", [{ id: "deeper", title: "A deeper dive", body: ["more"] }]);
    const r = run(["add", course, ch, "intro"], env());
    assert.match(r.out, /^added: 1$/m);
    let out = "";
    for (let i = 0; i < 30; i += 1) {
      out = run(["where"], env()).out;
      if (/^  total: 6$/m.test(out)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(out, /^  total: 6$/m);
    assert.match(out, /^  id: anchor$/m);
    assert.match(out, /^  idx: 5$/m);
  });

  test("unload closes the panel and forgets the tour", () => {
    const r = run(["unload"], env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^tour: unloaded$/m);
    assert.equal(expr("len(nvim_list_wins())"), "1");
    assert.match(run(["where"], env()).out, /^code: NO_TOUR$/m);
    assert.match(run(["unload"], env()).out, /^tour: none loaded$/m);
  });

  test("loading again after unload works", () => {
    const r = run(["load", course, ROOT, "tr"], env());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^  lang: tr$/m);
    run(["unload"], env());
  });
});

describe("setup", () => {
  const home = join(scratch, "home");
  const henv = () => ({ HOME: home });

  test("skill installs where the agent directory exists, idempotently", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    let r = run(["setup", "skill"], henv());
    assert.equal(r.code, 0, r.out);
    const installed = join(home, ".claude", "skills", "nvim-tour", "SKILL.md");
    assert.equal(
      readFileSync(installed, "utf-8"),
      readFileSync(join(ROOT, "skills", "nvim-tour", "SKILL.md"), "utf-8"),
    );
    assert.match(r.out, /\.agents\/skills\/nvim-tour,skipped \(no /);
    r = run(["setup", "skill"], henv());
    assert.match(r.out, /already up to date/);
    assert.match(run(["setup"], henv()).out, /\.claude\/skills\/nvim-tour,installed/);
  });

  test("skill replaces a link but refuses a foreign directory", () => {
    const agents = join(home, ".agents", "skills");
    mkdirSync(agents, { recursive: true });
    const target = join(scratch, "draft-skill");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "---\nname: nvim-tour\n---\ndraft\n");
    symlinkSync(target, join(agents, "nvim-tour"));
    let r = run(["setup", "skill"], henv());
    assert.equal(r.code, 0, r.out);
    assert.equal(lstatSync(join(agents, "nvim-tour")).isSymbolicLink(), false);
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf-8"), "---\nname: nvim-tour\n---\ndraft\n");

    r = run(["setup", "skill", "--remove"], henv());
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(join(agents, "nvim-tour")), false);
    assert.equal(existsSync(join(home, ".claude", "skills", "nvim-tour")), false);

    mkdirSync(join(agents, "nvim-tour"));
    writeFileSync(join(agents, "nvim-tour", "SKILL.md"), "---\nname: something-else\n---\n");
    r = run(["setup", "skill"], henv());
    assert.equal(r.code, 1);
    assert.match(r.out, /^code: CONFLICT$/m);
  });

  test("hooks install and remove the session-start hook", () => {
    let r = run(["setup", "hooks"], henv());
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^  claude: installed$/m);
    const settings = readFileSync(join(home, ".claude", "settings.json"), "utf-8");
    assert.match(settings, /nvim-tour-axi/);
    r = run(["setup", "hooks", "--remove"], henv());
    assert.match(r.out, /^  claude: not installed$/m);
  });

  test("unknown targets and misplaced flags are validation errors", () => {
    assert.equal(run(["setup", "bogus"], henv()).code, 2);
    assert.equal(run(["setup", "skill", "--project"], henv()).code, 2);
    assert.equal(run(["setup", "skill", "--force"], henv()).code, 2);
  });
});
