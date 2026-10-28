---
name: nvim-tour
description: Teach a codebase step by step as a live guided course inside the user's Neovim. The agent writes the course, the bundled plugin (loaded ad hoc, never installed) shows each step beside the code, and the user sends questions back from Neovim. Use when the user asks to be taught, walked through, onboarded to, or shown around a codebase, module or change, especially "open Neovim and teach me".
---

# nvim-tour

A **tour** is a course you write as JSON and keep extending while the user follows it in Neovim.
Each step opens a file, highlights a line range with a label, adds end-of-line notes, and shows your explanation in a side panel.
The user moves with `n`/`p`, lists steps with `l`, and presses `a` to send you a message that arrives in your terminal prefixed with where they are: `[nvim · step 5/32 «title» · cursor src/cli.rs:424] why is this hot?`.

The plugin ships inside the `nvim-tour-axi` package and is loaded into a running Neovim over its socket for this session only.
Never install it, never edit the user's Neovim config, never write into the project.

## Setup

`nvim-tour-axi` drives everything (if it is not on `PATH`, use `npx -y nvim-tour-axi`).
Run it with no arguments to see whether a Neovim is listening and where the learner is; `nvim-tour-axi --help` lists the commands.

1. **Open Neovim** beside you, at the project root: `nvim-tour-axi open ROOT`.
   Inside Rex it splits your own block; inside tmux it splits your pane; otherwise it prints the command for the user to run in another terminal.
   If the user already has a Neovim, ask them to start it with `nvim --listen /tmp/nvim-tour-$USER.sock` (or set `NVIM_TOUR_SOCK` to theirs).
2. **Write the first chapter** (see Course format) to a scratch directory, never the project: `nvim-tour-axi add COURSE chapter1.json`.
3. **Check it**: `nvim-tour-axi check COURSE ROOT` must report `problems: 0`.
4. **Load**: `nvim-tour-axi load COURSE ROOT [en|tr]`, with the language you are teaching in.
   Messages reach you through Rex or tmux when you run in one (`NVIM_TOUR_TRANSPORT=auto`), else they go to `COURSE.inbox`, which you then read when the user says they asked something.
5. **Tell the user** the keys: panel `n` next, `p` previous, `l` list, `a` ask, `r` reload, `q` close; in code `<leader>kn`/`kp`/`ka`/`kk`; in visual mode `<leader>ka` asks about the selection; `Ctrl-w l`/`Ctrl-w h` moves between panel and code. Have them send a test message first.

## Teaching

- **Map before you teach.** Read enough of the codebase to draw its real map: entry point, core abstractions, the main end-to-end flow. Open with a short big picture (what it is for, the moving parts, one flow traced end to end), then a route of chapters the user can reorder.
- **Never guess.** Every claim points at a real `file:line`; read the lines before writing the step. Run `nvim-tour-axi check` after every chapter and fix every problem before the user can reach it.
- **One chapter ahead.** Keep the next chapter written while the user reads the current one; `add` reloads Neovim live and keeps the user's place.
- **Explain why, not only what.** Each step: what the code does, why it is shaped that way, and how it connects to the previous step. Use `marks` for the two to five lines worth a glance; quote the code's own comments when they state the design.
- **Follow the user.** Answer questions in your terminal reply; when an answer deserves to stay, add a step for it (`nvim-tour-axi add COURSE CHAPTER AFTER_ID` inserts it after the current step, `nvim-tour-axi go ID` takes them there). `nvim-tour-axi where` shows their position.
- **Stay read-only.** Running the tests or the program to demonstrate behaviour is fine; changing the project is a separate request.

## Course format

```json
{
  "title": "cylinder course",
  "steps": [
    {
      "id": "cli-main",
      "section": "1 · Entry point and CLI",
      "title": "cli::main: panic hook, parse, tokio",
      "file": "src/cli.rs",
      "range": [358, 376],
      "anchor": "pub fn main() -> u8 {",
      "marks": [{ "line": 359, "text": "secrets never reach panic output" }],
      "body": ["Markdown lines shown in the panel.", "", "- one point per line"]
    }
  ]
}
```

- `id` (unique, stable) and `title` are required; a step without `file` is a text-only step.
- `file` is relative to ROOT; `range` is 1-based and inclusive; `marks` are end-of-line notes.
- `anchor` (optional, recommended) is text on the range's first line. When the file changes, the plugin finds the anchor within 200 lines and shifts the whole step, showing `[moved]`.
- `body` is a list of markdown lines (or one string); it renders with the user's markdown plugins.
- A chapter file for `add` is a JSON array of steps (or an object with `steps`); steps whose `id` already exists are skipped, so fix a published step by editing COURSE itself.

## Driving Neovim directly

- Use `--remote-expr` with `luaeval(...)`/`execute(...)`, never `--remote-send` with key sequences: users' mappings (for example toggleterm on `<C-\>`) turn your keys into actions.
- Socket paths must stay short (Unix sockets allow about 100 bytes); keep them under `/tmp`.
- A Neovim launched by a multiplexer may lack your `PATH`; `nvim-tour-axi` passes absolute paths to the transport for that reason.
- Loading again (`nvim-tour-axi load`) replaces the earlier instance: watcher, panel and highlights. `nvim-tour-axi unload` removes it.

## Finishing

When the user is done, offer a written study guide: the map, the route with `file:line` anchors, the key concepts, and every question with its answer.
Then `nvim-tour-axi unload`; the scratch course can be deleted.
