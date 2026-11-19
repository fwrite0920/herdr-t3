// The space panel's Todos page: tracks project tasks directly synced with TODO.md on disk,
// with interactive checkmarks, task addition, and AI agent dispatch.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, readTextFile, writeTextFile, theme, notify, exec, layout, window } from "herdr";

const MOD = "mods/t3-todos";

function norm(p) {
  return p ? p.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}

function isTodosActive() {
  if (typeof window === "function" && window()?.active === false) return false;
  const root = typeof layout === "function" ? layout() : null;
  if (!root) return true;
  const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((hit, c) => hit ?? find(c, id), null));
  const panel = find(root, "panel");
  if (panel && panel.hidden) return false;
  const body = find(root, "panel-body");
  if (body && body.active && body.active !== "todos") return false;
  return true;
}

function activeFolder() {
  const sp = spaces().find((s) => s.active);
  const ps = typeof panes === "function" ? panes() : [];
  const f = typeof focused === "function" ? focused() : null;
  const tabs = new Set((sp?.tabs ?? []).map((c) => c.id));
  const focusPane = f?.pane && tabs.has(f.tab) ? ps.find((p) => p.pane === f.pane && p.cwd) : null;
  const cwd = focusPane?.cwd || ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || sp?.folder || "";
  return { folder: norm(cwd), spaceId: sp?.id ?? null, on: sp?.machine ?? null };
}

function activeTerminal() {
  const sp = spaces().find((s) => s.active);
  const ps = typeof panes === "function" ? panes() : [];
  const f = typeof focused === "function" ? focused() : null;
  if (f?.terminal) return f.terminal;
  const activeTab = sp?.tabs?.find((c) => c.active) ?? sp?.tabs?.[0];
  if (activeTab) {
    const tabPanes = ps.filter((p) => p.tab === activeTab.id && p.terminal);
    const hit = tabPanes.find((p) => p.focused) ?? tabPanes[0];
    if (hit?.terminal) return hit.terminal;
  }
  const tabIds = new Set((sp?.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabIds.has(p.tab) && p.terminal)?.terminal ?? null;
}

export default class TodosView extends View {
  init(_props, cx) {
    this.tasks = [];
    this.rawContent = "";
    this.filePath = null;
    this.filter = "all"; // "all" | "active" | "done"
    this.loading = false;
    this.lastFolder = "";
    this.on = null;
    this.refreshGen = 0;
    this.newInput = InputState.new({ placeholder: "Add a task to TODO.md… (Press Enter)" });
    this.newInput.on("submit", (_e, cx) => this.addTask(cx));
    this.refresh(cx);
    this.pollTimer = cx.timer.every(4000, (cx) => {
      if (!isTodosActive()) return;
      this.refresh(cx, true);
    });
  }

  async close() {
    this.pollTimer?.cancel();
  }

  refresh(cx, quiet = false) {
    const { folder, on } = activeFolder();
    const folderChanged = folder !== this.lastFolder || on !== this.on;
    this.lastFolder = folder;
    this.on = on;
    const gen = ++this.refreshGen;
    if (!folder) {
      this.tasks = [];
      this.filePath = null;
      this.rawContent = "";
      this.loading = false;
      cx.notify();
      return;
    }
    if (!quiet || folderChanged) {
      this.loading = true;
      cx.notify();
    }

    cx.spawn(async (cx) => {
      const candidates = [
        `${folder}/TODO.md`,
        `${folder}/todo.md`,
        `${folder}/TODOS.md`,
        `${folder}/tasks.md`,
      ];

      let content = null;
      let foundPath = null;
      for (const p of candidates) {
        content = await readTextFile(p, { on }).catch(() => null);
        if (this.refreshGen !== gen) return;
        if (content !== null) {
          foundPath = p;
          break;
        }
      }
      if (this.refreshGen !== gen) return;

      const changed = foundPath !== this.filePath || (content ?? "") !== this.rawContent;
      this.filePath = foundPath;
      this.rawContent = content ?? "";
      this.tasks = this.parseTasks(this.rawContent);
      this.loading = false;
      if (changed || !quiet || folderChanged) cx.notify();
    });
  }

  parseTasks(content) {
    if (!content) return [];
    const lines = content.split(/\r?\n/);
    const items = [];
    let currentSection = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const headingMatch = line.match(/^#{1,4}\s+(.+)$/);
      if (headingMatch) {
        currentSection = headingMatch[1].trim();
        continue;
      }

      const match = line.match(/^(\s*[-*]\s*\[([ xX])\]\s*)(.+)$/);
      if (match) {
        const indent = match[1];
        const done = match[2].toLowerCase() === "x";
        const text = match[3].trim();
        items.push({
          lineIndex: i,
          indent,
          done,
          text,
          section: currentSection,
          raw: line,
        });
      }
    }
    return items;
  }

  toggleTask(task, cx) {
    const path = this.filePath, on = this.on;
    if (!path) return;
    cx.spawn(async (cx) => {
      try {
        const latest = await readTextFile(path, { on }).catch(() => this.rawContent);
        if (latest === null) return;
        const eol = latest.includes("\r\n") ? "\r\n" : "\n";
        const lines = latest.split(/\r?\n/);
        let idx = task.lineIndex;
        if (lines[idx] !== task.raw) {
          idx = lines.findIndex((l) => l === task.raw);
        }
        if (idx < 0 || idx >= lines.length) {
          this.refresh(cx);
          return;
        }
        const newCheck = task.done ? "[ ]" : "[x]";
        lines[idx] = lines[idx].replace(/\[([ xX])\]/, newCheck);
        const updated = lines.join(eol);
        await writeTextFile(path, updated, latest);
        if (this.filePath !== path) return;
        this.rawContent = updated;
        this.tasks = this.parseTasks(updated);
        cx.notify();
      } catch (e) {
        notify({ title: "Failed to update TODO.md", body: String(e), level: "error" });
      }
    });
  }

  addTask(cx) {
    const text = this.newInput.value().trim();
    if (!text) return;
    const { folder, on } = activeFolder();
    if (!folder) return;

    const path = this.filePath || `${folder}/TODO.md`;
    const isNew = !this.filePath;
    cx.spawn(async (cx) => {
      try {
        let content = isNew ? `# Project Tasks\n\n` : (await readTextFile(path, { on }).catch(() => this.rawContent) ?? "");
        const eol = content.includes("\r\n") ? "\r\n" : "\n";
        const taskLine = `- [ ] ${text}${eol}`;
        const nextContent = !content || content.endsWith("\n") ? `${content}${taskLine}` : `${content}${eol}${taskLine}`;
        await writeTextFile(path, nextContent, isNew ? null : content);
        this.newInput.set_value("");
        this.filePath = path;
        this.rawContent = nextContent;
        this.tasks = this.parseTasks(nextContent);
        notify({ title: "Task added", body: text, level: "success" });
        cx.notify();
      } catch (e) {
        notify({ title: "Failed to save task", body: String(e), level: "error" });
      }
    });
  }

  deleteTask(task, cx) {
    const path = this.filePath, on = this.on;
    if (!path) return;
    cx.spawn(async (cx) => {
      try {
        const latest = await readTextFile(path, { on }).catch(() => this.rawContent);
        if (latest === null) return;
        const eol = latest.includes("\r\n") ? "\r\n" : "\n";
        const lines = latest.split(/\r?\n/);
        let idx = task.lineIndex;
        if (lines[idx] !== task.raw) {
          idx = lines.findIndex((l) => l === task.raw);
        }
        if (idx < 0 || idx >= lines.length) {
          this.refresh(cx);
          return;
        }
        lines.splice(idx, 1);
        const updated = lines.join(eol);
        await writeTextFile(path, updated, latest);
        if (this.filePath !== path) return;
        this.rawContent = updated;
        this.tasks = this.parseTasks(updated);
        cx.notify();
      } catch (e) {
        notify({ title: "Failed to delete task", body: String(e), level: "error" });
      }
    });
  }

  createTodoFile(cx) {
    const { folder, on } = activeFolder();
    if (!folder) return;
    const path = `${folder}/TODO.md`;
    const initial = `# Project Tasks\n\n- [ ] Initial task\n`;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(path, initial, null);
        this.filePath = path;
        this.rawContent = initial;
        this.tasks = this.parseTasks(initial);
        notify({ title: "Created TODO.md", body: path, level: "success" });
        cx.notify();
      } catch (e) {
        notify({ title: "Failed to create TODO.md", body: String(e), level: "error" });
      }
    });
  }

  askAgent(task, cx) {
    const fileName = this.filePath ? this.filePath.split("/").pop() : "TODO.md";
    const prompt = `@${fileName} Please implement the following task:\n"${task.text}"`;
    const term = activeTerminal();
    if (term) {
      exec("hc", ["send", term, prompt]).catch(() => null);
      notify({ title: "Task sent to agent", body: task.text, level: "info" });
    } else {
      cx.write_to_clipboard(prompt);
      notify({ title: "Copied to clipboard", body: "Paste into an agent terminal to run.", level: "info" });
    }
  }

  render() {
    const t = theme();
    const { folder } = activeFolder();
    const cardHover = t.foreground + "12";
    const cardOn = t.foreground + "1f";

    const total = this.tasks.length;
    const doneCount = this.tasks.filter((tk) => tk.done).length;
    const activeCount = total - doneCount;

    const visibleTasks = this.tasks.filter((tk) => {
      if (this.filter === "active") return !tk.done;
      if (this.filter === "done") return tk.done;
      return true;
    });

    const chip = (id, label, count) => {
      const active = this.filter === id;
      return h_flex().id(`filter-${id}`).px(8).h(24).gap(4).items_center().rounded(6).cursor_pointer()
        .bg(active ? cardOn : t.raised)
        .text_color(active ? t.foreground : t.dim)
        .when(!active, (el) => el.hover((s) => s.bg(cardHover).text_color(t.foreground)))
        .on_click((_e, cx) => {
          this.filter = id;
          cx.notify();
        })
        .child(div().text_size(12).font_medium().child(label))
        .child(div().text_size(11).text_color(active ? t.accent : t.muted).child(String(count)));
    };

    const toolbar = h_flex().id("t3-todos-toolbar").h(40).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
      .when(Boolean(this.filePath), (el) => el
        .child(chip("all", "All", total))
        .child(chip("active", "Active", activeCount))
        .child(chip("done", "Done", doneCount)))
      .when(!this.filePath, (el) => el.child(div().pl(4).text_size(12).font_medium().text_color(t.muted).child("Todos")))
      .child(div().flex_1())
      .when(total > 0, (el) => el.child(div().text_size(11).font_medium().text_color(doneCount === total ? t.done : t.dim).child(`${Math.round((doneCount / total) * 100)}%`)))
      .child(div().id("btn-refresh-todos").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(cardHover))
        .on_click((_e, cx) => this.refresh(cx))
        .child(svg(`${MOD}/icons/rotate-cw.svg`).size(14).text_color(t.muted)));

    if (!folder) {
      return v_flex().id("t3-todos").size_full().min_h(0)
        .child(toolbar)
        .child(v_flex().flex_1().items_center().justify_center().p(24).gap(8)
          .child(svg(`${MOD}/icons/file-text.svg`).size(24).text_color(t.dim))
          .child(div().text_size(13).font_medium().text_color(t.foreground).child("No workspace folder"))
          .child(div().text_size(12).text_color(t.dim).child("Open a workspace folder to manage tasks.")));
    }

    if (this.loading && !this.filePath) {
      return v_flex().id("t3-todos").size_full().min_h(0)
        .child(toolbar)
        .child(v_flex().flex_1().items_center().justify_center().p(24).gap(8)
          .child(div().text_size(12).text_color(t.dim).child("Loading TODO.md…")));
    }

    if (!this.filePath) {
      return v_flex().id("t3-todos").size_full().min_h(0)
        .child(toolbar)
        .child(v_flex().flex_1().items_center().justify_center().p(24).gap(10)
          .child(svg(`${MOD}/icons/file-text.svg`).size(24).text_color(t.dim))
          .child(div().text_size(13).font_medium().text_color(t.foreground).child("No TODO.md in this project"))
          .child(div().text_size(12).text_color(t.dim).text_center().child("Track tasks, todo checklists, and dispatch them to AI agents."))
          .child(div().id("btn-create-todo").h(32).px(12).flex().items_center().rounded(8).bg(t.raised).border_1().border_color(t.input).cursor_pointer()
            .hover((s) => s.opacity(0.9))
            .on_click((_e, cx) => this.createTodoFile(cx))
            .child(div().text_size(12).font_medium().text_color(t.foreground).child("Create TODO.md"))));
    }

    return v_flex().id("t3-todos").size_full().min_h(0)
      .child(toolbar)
      .when(total > 0, (el) => {
        const pctDone = Math.round((doneCount / total) * 100);
        return el.child(h_flex().w_full().h(3).flex_none().bg(t.border)
          .when(pctDone > 0, (fEl) => fEl.child(div().h_full().bg(pctDone === 100 ? t.done : t.accent).flex_grow(pctDone)))
          .when(pctDone < 100, (uEl) => uEl.child(div().h_full().flex_grow(100 - pctDone))));
      })
      // Add task input bar
      .child(h_flex().px(8).py(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(Input.new(this.newInput).flex_1().h(30).px(10).rounded(8).border_1().border_color(t.input).bg(t.raised).text_size(12).text_color(t.foreground))
        .child(div().id("btn-add-todo").h(30).px(10).flex_none().flex().items_center().rounded(8).bg(t.raised).border_1().border_color(t.input).cursor_pointer()
          .hover((s) => s.opacity(0.9))
          .on_click((_e, cx) => this.addTask(cx))
          .child(div().text_size(12).font_medium().text_color(t.foreground).child("Add"))))
      // Tasks list
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(4)
        .when(visibleTasks.length === 0, (el) => el.child(
          div().py(32).flex().items_center().justify_center().text_size(12).text_color(t.dim).child("No tasks in this view")
        ))
        .children(visibleTasks.map((tk) => {
          const key = `task-${tk.lineIndex}`;
          return h_flex().id(key).w_full().py(6).px(8).gap(8).items_center().rounded(6)
            .hover((s) => s.bg(cardHover))
            // Checkbox
            .child(div().id(`${key}-check`).size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
              .on_click((_e, cx) => this.toggleTask(tk, cx))
              .child(svg(`${MOD}/icons/${tk.done ? "check-square" : "square"}.svg`).size(16).text_color(tk.done ? t.done : t.muted)))
            // Task text
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().text_size(13).text_color(tk.done ? t.dim : t.foreground)
                .when(tk.done, (txt) => txt.line_through())
                .child(tk.text))
              .when(Boolean(tk.section), (sub) => sub.child(div().text_size(11).text_color(t.dim).child(tk.section))))
            // Ask Agent dispatch button
            .child(div().id(`${key}-agent`).h(24).px(6).gap(4).flex_none().flex().items_center().rounded(6).cursor_pointer()
              .bg(t.raised).border_1().border_color(t.input)
              .hover((s) => s.opacity(0.9))
              .on_click((_e, cx) => this.askAgent(tk, cx))
              .child(svg(`${MOD}/icons/sparkles.svg`).size(12).text_color(t.accent))
              .child(div().text_size(11).font_medium().text_color(t.foreground).child("Agent")))
            // Delete button
            .child(div().id(`${key}-del`).size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
              .hover((s) => s.bg(cardHover))
              .on_click((_e, cx) => this.deleteTask(tk, cx))
              .child(svg(`${MOD}/icons/x.svg`).size(12).text_color(t.dim)));
        })));
  }
}
