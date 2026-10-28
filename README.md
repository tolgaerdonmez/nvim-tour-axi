# nvim-tour-axi

Agent-driven guided code tours in Neovim: an agent teaches you a codebase as a live course beside the code.

The agent reads the code, writes a course (JSON) one chapter ahead of you, and loads a small bundled plugin into your running Neovim for that session only.
Each step opens a file, highlights the lines being explained, adds short notes at line ends, and shows the explanation in a side panel.
You move with `n`/`p` and press `a` to ask a question; it arrives in the agent's terminal with your step and `file:line` attached.

Nothing is installed into Neovim: no plugin manager entry, no config change, no file in the project.

`nvim-tour-axi` is one [AXI](https://axi.md) CLI for the agent: structured (TOON) output, structured errors, no prompts, and a live home view when run with no arguments.
It ships with the Neovim plugin and the agent skill that teaches the method.

## Install

```sh
npm install -g nvim-tour-axi
nvim-tour-axi setup skill
```

`setup skill` copies the bundled skill into `~/.claude/skills/nvim-tour` (Claude Code) and `~/.agents/skills/nvim-tour` (agents that read `~/.agents/skills`), for each agent directory that exists.
Run it again after upgrading. `nvim-tour-axi setup` shows what is installed; `--remove` undoes it.

Without a global install, use `npx -y nvim-tour-axi <command>` everywhere.

Optionally, `nvim-tour-axi setup hooks` installs session-start hooks (Claude Code, Codex, OpenCode) so each agent session starts with the tour's home view: whether a Neovim is listening and where the learner is.

Then ask your agent: "open Neovim and teach me this codebase step by step".

## Quick start by hand

```sh
cd /path/to/project
nvim --listen /tmp/nvim-tour-$USER.sock                # in one terminal
nvim-tour-axi add /tmp/course.json chapter1.json       # write or extend a course
nvim-tour-axi check /tmp/course.json .                 # every step points at real lines
nvim-tour-axi load /tmp/course.json . en               # start it in that Neovim
nvim-tour-axi where                                    # the learner's step
nvim-tour-axi go 3                                     # move them (number or step id)
nvim-tour-axi unload                                   # close the panel, clear marks
```

From a clone of this repository, `examples/course.json` tours the project itself:

```sh
npm install && npm run build
node dist/bin/nvim-tour-axi.js check examples/course.json .
node dist/bin/nvim-tour-axi.js load examples/course.json .
```

`load` keeps the learner's place in `COURSE.state`, next to the course, so keep courses in a scratch directory rather than the project.

## Commands

| Command                           | What                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| _(none)_                          | home view: the socket, whether Neovim is listening, the loaded course and position      |
| `open [ROOT]`                     | open Neovim beside the agent (Rex or tmux split), or print the command for the user     |
| `load COURSE [ROOT] [LANG]`       | load the plugin into that Neovim and start the course; `LANG` is `en` (default) or `tr` |
| `add COURSE CHAPTER [AFTER_ID]`   | add a chapter atomically, skipping known ids; insert after a step if given              |
| `check COURSE [ROOT]`             | verify every step: file exists, lines in range, anchor present; exits 1 on problems     |
| `where`                           | the learner's current step                                                              |
| `go STEP`                         | jump to a step number or id                                                             |
| `unload`                          | close the panel, clear highlights and notes, stop watching                              |
| `setup [skill\|hooks] [--remove]` | install the skill or session hooks; with no target, show what is installed              |

`ROOT` defaults to the current directory. `nvim-tour-axi <command> --help` describes one command.

Environment:

- `NVIM_TOUR_SOCK`: the Neovim socket (default `/tmp/nvim-tour-$USER.sock`).
- `NVIM_TOUR_TRANSPORT`: where the learner's questions go: `auto` (default: the agent's Rex block, else its tmux pane, else `COURSE.inbox`), `rex:<block>`, `tmux:<pane>` or `file:<path>`.

The course format is described in [the skill](skills/nvim-tour/SKILL.md#course-format).

## Requirements

- Node.js 20 or newer.
- Neovim 0.10 or newer (`vim.system`, `vim.uv`, split windows from `nvim_open_win`), with `nvim` on `PATH`.
- For questions from Neovim to the agent: the agent running in Rex or tmux; otherwise questions go to an inbox file next to the course.

## Layout

| Path                            | What                                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| `src/cli.ts`                    | the commands, on [`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js) |
| `src/course.ts`                 | course merge (`add`) and verification (`check`)                           |
| `src/nvim.ts`                   | the Neovim socket (`--remote-expr`) and the transport                     |
| `src/setup.ts`                  | `setup skill` and `setup hooks`                                           |
| `plugin/lua/nvim_tour/init.lua` | the Neovim plugin, loaded over the socket                                 |
| `skills/nvim-tour/SKILL.md`     | the method and the commands, for the agent                                |
| `examples/course.json`          | a small example course that tours this repository                         |
| `test/`                         | end-to-end tests against a real headless Neovim                           |

## Development

```sh
npm install
npm test              # builds, then runs the tests (Neovim tests skip without nvim)
npm run format:check
```

## License

MIT
