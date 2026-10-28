-- nvim-tour: a guided code course inside Neovim, written and updated live by an AI agent.
--
-- The agent writes a course file (JSON) and keeps extending it; the plugin reloads it on change,
-- keeping the learner's place. Each step opens a file, highlights a line range, labels it, and
-- shows the explanation in a side panel. `ask` sends the learner's message, prefixed with the
-- current step and file:line, back to the agent's terminal (Rex, tmux) or to an inbox file.
--
-- Loaded ad hoc into a running Neovim by `nvim-tour-axi load`; it never touches the
-- user's config. Loading it again replaces the earlier instance cleanly.

local M = {}

local ns = vim.api.nvim_create_namespace("nvim_tour")
local uv = vim.uv or vim.loop

local S = {
  cfg = nil,
  course = { title = "", steps = {} },
  idx = 1,
  code_win = nil,
  panel_win = nil,
  panel_buf = nil,
  watcher = nil,
  marked_buf = nil,
}

-- A reloaded module replaces an earlier one: stop its watcher, close its panel, clear its marks.
local prev = rawget(_G, "__nvim_tour")
if prev then
  if prev.watcher and not prev.watcher:is_closing() then
    pcall(function()
      prev.watcher:stop()
      prev.watcher:close()
    end)
  end
  if prev.panel_win and vim.api.nvim_win_is_valid(prev.panel_win) then
    pcall(vim.api.nvim_win_close, prev.panel_win, true)
  end
  if prev.panel_buf and vim.api.nvim_buf_is_valid(prev.panel_buf) then
    pcall(vim.api.nvim_buf_delete, prev.panel_buf, { force = true })
  end
  if prev.marked_buf and vim.api.nvim_buf_is_valid(prev.marked_buf) then
    vim.api.nvim_buf_clear_namespace(prev.marked_buf, ns, 0, -1)
  end
  S.idx = prev.idx or 1
end
_G.__nvim_tour = S

-- UI strings; `lang = "tr"` switches them.
local T = {
  en = {
    no_course = "no course file: ",
    bad_course = "cannot read the course file (JSON error?)",
    no_steps = "the course has no steps",
    last = "last step; ask the agent for more with `a`",
    no_step = "no such step: ",
    steps = "Steps",
    updated = "course updated",
    sent = "sent to the agent",
    send_failed = "could not send: ",
    kept = "\nthe message is in the \" register",
    no_transport = "no transport configured",
    ask_title = " Ask the agent ",
    ask_footer = " Ctrl-s send · q (normal mode) cancel ",
    help = "`n` next · `p` prev · `l` list · `a` ask · `r` reload · `q` close",
    help_code = "in code: `<leader>kn` / `<leader>kp` / `<leader>ka` / `<leader>kk` panel",
    step = "step",
    selection = "selection",
    cursor = "cursor",
    stale = "[moved] ",
  },
  tr = {
    no_course = "kurs dosyası yok: ",
    bad_course = "kurs dosyası okunamadı (JSON hatası?)",
    no_steps = "kursta adım yok",
    last = "son adımdasın; yeni adımlar için ajana `a` ile yaz",
    no_step = "böyle bir adım yok: ",
    steps = "Adımlar",
    updated = "kurs güncellendi",
    sent = "ajana gönderildi",
    send_failed = "gönderilemedi: ",
    kept = "\nmesaj \" register'ında duruyor",
    no_transport = "gönderim kanalı ayarlı değil",
    ask_title = " Ajana sor ",
    ask_footer = " Ctrl-s gönder · normal modda q iptal ",
    help = "`n` ileri · `p` geri · `l` liste · `a` sor · `r` yenile · `q` kapat",
    help_code = "kodda: `<leader>kn` / `<leader>kp` / `<leader>ka` / `<leader>kk` panel",
    step = "adım",
    selection = "seçim",
    cursor = "imleç",
    stale = "[kaydı] ",
  },
}

local function t(key)
  local lang = (S.cfg and T[S.cfg.lang]) and S.cfg.lang or "en"
  return T[lang][key]
end

local function notify(msg, level)
  vim.notify(msg, level or vim.log.levels.INFO, { title = "nvim-tour" })
end

local function read_file(path)
  local f = io.open(path, "r")
  if not f then
    return nil
  end
  local s = f:read("*a")
  f:close()
  return s
end

local function write_file(path, s)
  local f = io.open(path, "w")
  if f then
    f:write(s)
    f:close()
  end
end

local function save_state()
  local step = S.course.steps[S.idx]
  write_file(S.cfg.state, vim.json.encode({ idx = S.idx, id = step and step.id or nil }))
end

local function index_of(id)
  for i, s in ipairs(S.course.steps) do
    if s.id == id then
      return i
    end
  end
end

local function load_course()
  local text = read_file(S.cfg.course)
  if not text then
    notify(t("no_course") .. S.cfg.course, vim.log.levels.WARN)
    return false
  end
  local ok, data = pcall(vim.json.decode, text)
  if not ok or type(data) ~= "table" or type(data.steps) ~= "table" then
    notify(t("bad_course"), vim.log.levels.ERROR)
    return false
  end
  local current = S.course.steps[S.idx]
  S.course = data
  if current and current.id then
    S.idx = index_of(current.id) or S.idx
  end
  S.idx = math.max(1, math.min(S.idx, #data.steps))
  return true
end

local function is_panel(win)
  return S.panel_win ~= nil and win == S.panel_win
end

local function code_window()
  if S.code_win and vim.api.nvim_win_is_valid(S.code_win) then
    return S.code_win
  end
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if not is_panel(w) and vim.api.nvim_win_get_config(w).relative == "" then
      S.code_win = w
      return w
    end
  end
  return vim.api.nvim_get_current_win()
end

local function body_lines(step)
  local body = step.body or {}
  if type(body) == "string" then
    body = vim.split(body, "\n", { plain = true })
  end
  return body
end

local function range_text(step)
  if not step.file then
    return ""
  end
  local r = step.range or {}
  if r[1] and r[2] and r[2] ~= r[1] then
    return string.format("%s:%d-%d", step.file, r[1], r[2])
  elseif r[1] then
    return string.format("%s:%d", step.file, r[1])
  end
  return step.file
end

local function ensure_panel()
  if S.panel_buf == nil or not vim.api.nvim_buf_is_valid(S.panel_buf) then
    S.panel_buf = vim.api.nvim_create_buf(false, true)
    vim.bo[S.panel_buf].buftype = "nofile"
    vim.bo[S.panel_buf].bufhidden = "hide"
    vim.bo[S.panel_buf].swapfile = false
    vim.bo[S.panel_buf].filetype = "markdown"
    pcall(vim.api.nvim_buf_set_name, S.panel_buf, "nvim-tour://course")
    local map = function(lhs, fn)
      vim.keymap.set("n", lhs, fn, { buffer = S.panel_buf, nowait = true })
    end
    map("n", M.next)
    map("p", M.prev)
    map("l", M.list)
    map("a", function()
      M.ask()
    end)
    map("r", M.reload)
    map("q", M.close_panel)
  end
  if S.panel_win == nil or not vim.api.nvim_win_is_valid(S.panel_win) then
    S.panel_win = vim.api.nvim_open_win(S.panel_buf, false, {
      split = "right",
      win = code_window(),
      width = S.cfg.panel_width,
    })
    local wo = vim.wo[S.panel_win]
    wo.wrap = true
    wo.linebreak = true
    wo.number = false
    wo.relativenumber = false
    wo.signcolumn = "no"
    wo.winfixwidth = true
    wo.cursorline = false
  end
end

local function render_panel(step, moved)
  ensure_panel()
  local lines = {}
  if S.course.title and S.course.title ~= "" then
    vim.list_extend(lines, { "_" .. S.course.title .. "_", "" })
  end
  table.insert(lines, string.format("# %d/%d · %s", S.idx, #S.course.steps, step.title or "?"))
  if step.section then
    table.insert(lines, "_" .. step.section .. "_")
  end
  local where = range_text(step)
  if where ~= "" then
    vim.list_extend(lines, { "", (moved and t("stale") or "") .. "`" .. where .. "`" })
  end
  table.insert(lines, "")
  vim.list_extend(lines, body_lines(step))
  vim.list_extend(lines, { "", "---", t("help") })
  if S.cfg.leader_maps then
    table.insert(lines, t("help_code"))
  end
  vim.bo[S.panel_buf].modifiable = true
  vim.api.nvim_buf_set_lines(S.panel_buf, 0, -1, false, lines)
  vim.bo[S.panel_buf].modifiable = false
  pcall(vim.api.nvim_win_set_cursor, S.panel_win, { 1, 0 })
end

-- When a step's `anchor` text is no longer on its first line, look for it nearby and shift the
-- step's lines by the same offset (the file changed since the course was written).
local function anchor_offset(buf, first, anchor)
  if not anchor or anchor == "" then
    return 0
  end
  local count = vim.api.nvim_buf_line_count(buf)
  local function has(l)
    local line = vim.api.nvim_buf_get_lines(buf, l - 1, l, false)[1] or ""
    return line:find(anchor, 1, true) ~= nil
  end
  if first <= count and has(first) then
    return 0
  end
  for d = 1, 200 do
    if first - d >= 1 and has(first - d) then
      return -d
    end
    if first + d <= count and has(first + d) then
      return d
    end
  end
  return 0
end

local function mark_code(buf, step)
  if S.marked_buf and vim.api.nvim_buf_is_valid(S.marked_buf) then
    vim.api.nvim_buf_clear_namespace(S.marked_buf, ns, 0, -1)
  end
  S.marked_buf = buf
  local count = vim.api.nvim_buf_line_count(buf)
  local r = step.range or {}
  local off = anchor_offset(buf, r[1] or 1, step.anchor)
  local function clamp(l)
    return math.max(1, math.min(l + off, count))
  end
  local first = clamp(r[1] or 1)
  local last = math.max(first, clamp(r[2] or r[1] or 1))
  for l = first, last do
    vim.api.nvim_buf_set_extmark(buf, ns, l - 1, 0, { line_hl_group = "NvimTourRange", priority = 5 })
  end
  vim.api.nvim_buf_set_extmark(buf, ns, first - 1, 0, {
    virt_lines = {
      { { string.format(" ◆ %d/%d · %s ", S.idx, #S.course.steps, step.title or ""), "NvimTourLabel" } },
    },
    virt_lines_above = true,
  })
  for _, m in ipairs(step.marks or {}) do
    if m.line then
      local l = clamp(m.line)
      vim.api.nvim_buf_set_extmark(buf, ns, l - 1, 0, {
        virt_text = { { "  ◀ " .. (m.text or ""), "NvimTourNote" } },
        virt_text_pos = "eol",
      })
    end
  end
  return first, off ~= 0
end

local function show()
  local step = S.course.steps[S.idx]
  if not step then
    notify(t("no_steps"), vim.log.levels.WARN)
    return
  end
  local moved = false
  if step.file then
    local win = code_window()
    local path = step.file:match("^/") and step.file or (S.cfg.root .. "/" .. step.file)
    vim.api.nvim_win_call(win, function()
      vim.cmd.edit(vim.fn.fnameescape(path))
    end)
    local first
    first, moved = mark_code(vim.api.nvim_win_get_buf(win), step)
    vim.api.nvim_win_set_cursor(win, { first, 0 })
    vim.api.nvim_win_call(win, function()
      -- Top of the window, leaving one line for the label above the range.
      vim.cmd("normal! zt")
      vim.cmd('execute "normal! \\<C-y>"')
    end)
  end
  render_panel(step, moved)
  save_state()
end

function M.go(target)
  if type(target) == "string" then
    target = index_of(target) or tonumber(target)
  end
  if type(target) ~= "number" then
    notify(t("no_step") .. tostring(target), vim.log.levels.WARN)
    return
  end
  S.idx = math.max(1, math.min(target, #S.course.steps))
  show()
end

function M.next()
  if S.idx >= #S.course.steps then
    notify(t("last"))
    return
  end
  M.go(S.idx + 1)
end

function M.prev()
  if S.idx > 1 then
    M.go(S.idx - 1)
  end
end

function M.list()
  local items = {}
  for i, s in ipairs(S.course.steps) do
    table.insert(items, { i = i, s = s })
  end
  vim.ui.select(items, {
    prompt = t("steps"),
    format_item = function(it)
      local mark = it.i == S.idx and "▶ " or "  "
      return string.format("%s%2d. %s  (%s)", mark, it.i, it.s.title or "?", range_text(it.s))
    end,
  }, function(choice)
    if choice then
      M.go(choice.i)
    end
  end)
end

function M.reload()
  if load_course() then
    show()
  end
end

function M.close_panel()
  if S.panel_win and vim.api.nvim_win_is_valid(S.panel_win) then
    vim.api.nvim_win_close(S.panel_win, true)
  end
  S.panel_win = nil
end

function M.toggle_panel()
  if S.panel_win and vim.api.nvim_win_is_valid(S.panel_win) then
    M.close_panel()
  elseif S.course.steps[S.idx] then
    render_panel(S.course.steps[S.idx], false)
  end
end

-- Where the learner is: a selection, the cursor in a code window, or the current step.
local function context(sel)
  local step = S.course.steps[S.idx]
  local parts = { "nvim" }
  if step then
    table.insert(parts, string.format("%s %d/%d «%s»", t("step"), S.idx, #S.course.steps, step.title or ""))
  end
  local win = vim.api.nvim_get_current_win()
  local buf = vim.api.nvim_win_get_buf(win)
  local name = vim.api.nvim_buf_get_name(buf)
  if sel then
    local file = vim.fn.fnamemodify(sel.file, ":.")
    table.insert(parts, string.format("%s %s:%d-%d", t("selection"), file, sel.first, sel.last))
  elseif not is_panel(win) and name ~= "" and vim.bo[buf].buftype == "" then
    table.insert(parts, string.format("%s %s:%d", t("cursor"), vim.fn.fnamemodify(name, ":."), vim.fn.line(".")))
  elseif step then
    table.insert(parts, range_text(step))
  end
  return "[" .. table.concat(parts, " · ") .. "]"
end

-- Commands that deliver `text` to the agent: first the text, then (optionally) Enter.
local function transport_cmds(text)
  local tr = S.cfg.transport or {}
  if tr.kind == "rex" then
    local bin = tr.bin or "rex"
    return { { bin, "send", "-b", tr.target, text }, { bin, "send-key", "-b", tr.target, "enter" } }
  elseif tr.kind == "tmux" then
    local bin = tr.bin or "tmux"
    return { { bin, "send-keys", "-t", tr.target, "-l", text }, { bin, "send-keys", "-t", tr.target, "Enter" } }
  end
end

local function send(text)
  local function failed(why)
    vim.fn.setreg('"', text)
    notify(t("send_failed") .. why .. t("kept"), vim.log.levels.ERROR)
  end
  local tr = S.cfg.transport or {}
  if tr.kind == "file" then
    local f = io.open(tr.target, "a")
    if not f then
      failed(tr.target)
      return
    end
    f:write(text .. "\n")
    f:close()
    notify(t("sent"))
    return
  end
  local cmds = transport_cmds(text)
  if not cmds or not tr.target or tr.target == "" then
    failed(t("no_transport"))
    return
  end
  local function run(i)
    if i > #cmds then
      vim.schedule(function()
        notify(t("sent"))
      end)
      return
    end
    local ok, err = pcall(vim.system, cmds[i], { text = true }, function(r)
      if r.code ~= 0 then
        vim.schedule(function()
          failed(r.stderr or ("exit " .. r.code))
        end)
        return
      end
      -- Give the terminal a moment to take the text before Enter.
      vim.defer_fn(function()
        run(i + 1)
      end, 150)
    end)
    if not ok then
      vim.schedule(function()
        failed(tostring(err))
      end)
    end
  end
  run(1)
end

function M.ask(sel)
  local ctx = context(sel)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = "nofile"
  vim.bo[buf].filetype = "markdown"
  local width = math.min(80, vim.o.columns - 6)
  local height = 8
  local win = vim.api.nvim_open_win(buf, true, {
    relative = "editor",
    width = width,
    height = height,
    row = math.floor((vim.o.lines - height) / 2),
    col = math.floor((vim.o.columns - width) / 2),
    border = "rounded",
    title = t("ask_title"),
    title_pos = "center",
    footer = t("ask_footer"),
    footer_pos = "center",
  })
  vim.wo[win].wrap = true
  local function submit()
    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    -- One line: a newline would submit early in a terminal agent.
    local msg = vim.trim((table.concat(lines, " / "):gsub("[%s/]+$", "")))
    vim.api.nvim_win_close(win, true)
    vim.cmd("stopinsert")
    if msg ~= "" then
      send(ctx .. " " .. msg)
    end
  end
  vim.keymap.set({ "n", "i" }, "<C-s>", submit, { buffer = buf })
  vim.keymap.set("n", "q", function()
    vim.api.nvim_win_close(win, true)
  end, { buffer = buf, nowait = true })
  vim.cmd("startinsert")
end

function M.ask_visual()
  local first, last = vim.fn.line("v"), vim.fn.line(".")
  if first > last then
    first, last = last, first
  end
  local file = vim.api.nvim_buf_get_name(0)
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<Esc>", true, false, true), "nx", false)
  M.ask({ file = file, first = first, last = last })
end

-- For the agent: where the learner is right now.
function M.where()
  local step = S.course.steps[S.idx]
  return { idx = S.idx, id = step and step.id or nil, total = #S.course.steps }
end

local function watch()
  if S.watcher and not S.watcher:is_closing() then
    S.watcher:stop()
    S.watcher:close()
  end
  S.watcher = uv.new_fs_event()
  local pending = false
  S.watcher:start(S.cfg.course, {}, function()
    if pending then
      return
    end
    pending = true
    vim.defer_fn(function()
      pending = false
      if load_course() then
        show()
        notify(t("updated"))
      end
      -- Atomic writes replace the file; watch the new one.
      watch()
    end, 200)
  end)
end

local function define_highlights()
  vim.api.nvim_set_hl(0, "NvimTourRange", { default = true, link = "Visual" })
  vim.api.nvim_set_hl(0, "NvimTourLabel", { default = true, link = "IncSearch" })
  vim.api.nvim_set_hl(0, "NvimTourNote", { default = true, link = "DiagnosticVirtualTextInfo" })
end

--- Starts (or restarts) a tour.
--- cfg.course       path of the course JSON (required)
--- cfg.root         directory step files are relative to (default: cwd)
--- cfg.transport    { kind = "rex"|"tmux"|"file", target = block|pane|path, bin = absolute path }
--- cfg.lang         "en" (default) or "tr"
--- cfg.panel_width  default 50
--- cfg.leader_maps  default true; maps only free `<leader>k*` keys
function M.setup(cfg)
  S.cfg = vim.tbl_extend("force", {
    root = vim.fn.getcwd(),
    panel_width = 50,
    lang = "en",
    leader_maps = true,
  }, cfg or {})
  S.cfg.state = S.cfg.state or (S.cfg.course .. ".state")
  define_highlights()
  vim.api.nvim_create_autocmd("ColorScheme", {
    group = vim.api.nvim_create_augroup("nvim_tour", { clear = true }),
    callback = define_highlights,
  })

  local cmd = vim.api.nvim_create_user_command
  cmd("TourNext", M.next, {})
  cmd("TourPrev", M.prev, {})
  cmd("TourList", M.list, {})
  cmd("TourReload", M.reload, {})
  cmd("TourPanel", M.toggle_panel, {})
  cmd("TourGo", function(o)
    M.go(tonumber(o.args) or o.args)
  end, { nargs = 1 })
  cmd("TourAsk", function(o)
    if o.range > 0 then
      M.ask({ file = vim.api.nvim_buf_get_name(0), first = o.line1, last = o.line2 })
    else
      M.ask()
    end
  end, { range = true })

  if S.cfg.leader_maps then
    -- Never override the user's own mappings; only replace ours from an earlier load.
    local function map(mode, lhs, fn, desc)
      local existing = vim.fn.maparg(lhs, mode, false, true)
      if vim.tbl_isempty(existing) or vim.startswith(existing.desc or "", "nvim-tour:") then
        vim.keymap.set(mode, lhs, fn, { desc = "nvim-tour: " .. desc })
      end
    end
    map("n", "<leader>kn", M.next, "next step")
    map("n", "<leader>kp", M.prev, "previous step")
    map("n", "<leader>kl", M.list, "step list")
    map("n", "<leader>ka", function()
      M.ask()
    end, "ask the agent")
    map("x", "<leader>ka", M.ask_visual, "ask about the selection")
    map("n", "<leader>kk", M.toggle_panel, "toggle panel")
  end

  S.code_win = vim.api.nvim_get_current_win()
  local saved = read_file(S.cfg.state)
  local ok, st = pcall(vim.json.decode, saved or "")
  if load_course() then
    if ok and type(st) == "table" then
      S.idx = (st.id and index_of(st.id)) or st.idx or S.idx
      S.idx = math.max(1, math.min(S.idx, #S.course.steps))
    end
    show()
  end
  watch()
end

return M
