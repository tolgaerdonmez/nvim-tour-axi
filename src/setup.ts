// `setup`: install the bundled skill into agent harnesses' skill directories, and (opt-in) the AXI
// session-start hooks that show the tour's home view when an agent session starts.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AxiError,
  installSessionStartHooks,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
  type SessionStartHookScope,
} from "axi-sdk-js";

// A command's structured result, rendered as TOON by the AXI runtime.
type Output = Record<string, unknown>;

const SKILL_NAME = "nvim-tour";
const MARKER = "nvim-tour-axi";

export const SETUP_HELP = `usage: nvim-tour-axi setup [skill|hooks] [--remove] [--project]
setup              show what is installed
setup skill        copy the bundled nvim-tour skill into ~/.claude/skills and ~/.agents/skills
                   (each where its agent directory exists); run again after upgrading
setup hooks        install session-start hooks (Claude Code, Codex, OpenCode) that show the home view
--remove           remove what \`setup skill\` or \`setup hooks\` installed, leaving anything else alone
--project          for hooks: use the current repository's agent config instead of your home directory
`;

// Harness skill directories: Claude Code reads ~/.claude/skills, other agents ~/.agents/skills.
function skillTargets(): { agentDir: string; skillDir: string }[] {
  const home = homedir();
  return [".claude", ".agents"].map((d) => ({
    agentDir: join(home, d),
    skillDir: join(home, d, "skills", SKILL_NAME),
  }));
}

function isOurSkill(dir: string): boolean {
  try {
    const text = readFileSync(join(dir, "SKILL.md"), "utf-8");
    return /^---\n[\s\S]*?^name:\s*nvim-tour\s*$/m.test(text);
  } catch {
    return false;
  }
}

function skillState(skillDir: string, sourceDir: string): string {
  let st;
  try {
    st = lstatSync(skillDir);
  } catch {
    return "not installed";
  }
  if (st.isSymbolicLink()) {
    return "linked (run `setup skill` to replace with this version)";
  }
  if (!isOurSkill(skillDir)) {
    return "occupied by another skill";
  }
  const same = readdirSync(sourceDir).every((f) => {
    try {
      return readFileSync(join(skillDir, f), "utf-8") === readFileSync(join(sourceDir, f), "utf-8");
    } catch {
      return false;
    }
  });
  return same ? "installed" : "outdated (run `setup skill`)";
}

function installSkill(sourceDir: string, remove: boolean): Output {
  const results: { path: string; result: string }[] = [];
  for (const { agentDir, skillDir } of skillTargets()) {
    if (!existsSync(agentDir)) {
      results.push({ path: skillDir, result: `skipped (no ${agentDir})` });
      continue;
    }
    let st;
    try {
      st = lstatSync(skillDir);
    } catch {
      st = undefined;
    }
    if (remove) {
      if (!st) {
        results.push({ path: skillDir, result: "not installed" });
      } else if (st.isSymbolicLink()) {
        unlinkSync(skillDir);
        results.push({ path: skillDir, result: "link removed" });
      } else if (isOurSkill(skillDir)) {
        for (const f of readdirSync(sourceDir)) {
          rmSync(join(skillDir, f), { force: true });
        }
        if (readdirSync(skillDir).length === 0) {
          rmdirSync(skillDir);
        }
        results.push({ path: skillDir, result: "removed" });
      } else {
        results.push({ path: skillDir, result: "left alone (not this skill)" });
      }
      continue;
    }
    if (st && !st.isSymbolicLink() && !(st.isDirectory() && isOurSkill(skillDir))) {
      throw new AxiError(`${skillDir} exists and is not the nvim-tour skill`, "CONFLICT", [
        `Move ${skillDir} aside, then run \`nvim-tour-axi setup skill\` again`,
      ]);
    }
    const before = st ? skillState(skillDir, sourceDir) : "not installed";
    if (before === "installed") {
      results.push({ path: skillDir, result: "already up to date" });
      continue;
    }
    if (st?.isSymbolicLink()) {
      // A link (for example to a checkout of the draft) is replaced; its target is untouched.
      unlinkSync(skillDir);
    }
    mkdirSync(skillDir, { recursive: true });
    for (const f of readdirSync(sourceDir)) {
      copyFileSync(join(sourceDir, f), join(skillDir, f));
    }
    results.push({ path: skillDir, result: st ? "updated" : "installed" });
  }
  return {
    skill: results,
    help: ["Ask your agent: open Neovim and teach me this codebase step by step"],
  };
}

function hookStatus(scope: SessionStartHookScope): Output {
  const s = sessionStartHookStatus({ marker: MARKER, scope });
  return {
    scope,
    claude: s.claude.installed ? "installed" : "not installed",
    codex: s.codex.installed ? "installed" : "not installed",
    opencode: s.opencode.installed ? "installed" : "not installed",
  };
}

function installHooks(remove: boolean, scope: SessionStartHookScope): Output {
  const errors: string[] = [];
  if (remove) {
    uninstallSessionStartHooks({ marker: MARKER, scope, onError: (m) => errors.push(m) });
  } else {
    installSessionStartHooks({
      marker: MARKER,
      binaryNames: [MARKER],
      scope,
      onError: (m) => errors.push(m),
    });
  }
  const out: Output = { hooks: hookStatus(scope) };
  const installedAny = ["claude", "codex", "opencode"].some(
    (k) => (out.hooks as Record<string, string>)[k] === "installed",
  );
  if (!remove && !installedAny) {
    throw new AxiError(
      "hooks were not installed: run the packaged `nvim-tour-axi` binary, not a development build",
      "SETUP_FAILED",
      ["Run `npm install -g nvim-tour-axi`, then `nvim-tour-axi setup hooks`"],
    );
  }
  if (errors.length > 0) {
    out.errors = errors;
  }
  return out;
}

export async function setupCommand(args: string[], skillSourceDir: string): Promise<Output> {
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (const a of args) {
    if (a.startsWith("-")) {
      if (a !== "--remove" && a !== "--project") {
        throw new AxiError(`unknown flag ${a} for \`setup\``, "VALIDATION_ERROR", [
          "Run `nvim-tour-axi setup --help`",
        ]);
      }
      flags.add(a);
    } else {
      positionals.push(a);
    }
  }
  const what = positionals[0];
  if (positionals.length > 1 || (what !== undefined && what !== "skill" && what !== "hooks")) {
    throw new AxiError(`unknown setup target ${positionals.join(" ")}`, "VALIDATION_ERROR", [
      "Run `nvim-tour-axi setup skill` or `nvim-tour-axi setup hooks`",
    ]);
  }
  if (flags.has("--project") && what !== "hooks") {
    throw new AxiError("--project applies to `setup hooks` only", "VALIDATION_ERROR");
  }
  const scope: SessionStartHookScope = flags.has("--project") ? "project" : "user";
  if (what === "skill") {
    return installSkill(skillSourceDir, flags.has("--remove"));
  }
  if (what === "hooks") {
    return installHooks(flags.has("--remove"), scope);
  }
  if (flags.size > 0) {
    throw new AxiError(
      "--remove needs a target: `setup skill --remove` or `setup hooks --remove`",
      "VALIDATION_ERROR",
    );
  }
  return {
    skill: skillTargets().map(({ skillDir }) => ({
      path: skillDir,
      state: skillState(skillDir, skillSourceDir),
    })),
    hooks: hookStatus("user"),
    help: [
      "Run `nvim-tour-axi setup skill` to install the skill",
      "Run `nvim-tour-axi setup hooks` for session-start context (optional)",
    ],
  };
}
