// The space panel's Todos page: tracks project tasks directly synced with TODO.md on disk,
// with interactive checkmarks, task addition, and AI agent dispatch.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, readTextFile, writeTextFile, theme, notify, run, exec } from "herdr";

const MOD = "mods/t3-todos";

function norm(p) {
  return p ? p.replace(/\\/g, "/").replace(/\/+$/, "") : "";
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

export default class TodosView extends View {
  init(_props, cx) {
    this.tasks = [];
    this.rawContent = "";
    this.filePath = null;
    this.filter = "all"; // "all" | "active" | "done"
    this.loading = false;
    this.lastFolder = "";
    this.newInput = InputState.new({ placeholder: "Add a task to TODO.md… (Press Enter)" });
    this.newInput.on("submit", (_e, cx) => this.addTask(cx));
    this.refresh(cx);
    cx.timer.every(4000, (cx) => this.checkFolder(cx));
  }

  checkFolder(cx) {
    const { folder, on } = activeFolder();
    if (folder !== this.lastFolder || on !== this.on) {
      this.refresh(cx);
    }
  }

  async refresh(cx) {
    const { folder, on } = activeFolder();
    this.lastFolder = folder;
    this.on = on;
    if (!folder) {
      this.tasks = [];
      this.filePath = null;
      this.rawContent = "";
      cx.notify();
      return;
    }
    this.loading = true;
    cx.notify();

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
      if (content !== null) {
        foundPath = p;
        break;
      }
    }

    this.filePath = foundPath;
    this.rawContent = content ?? "";
    this.tasks = this.parseTasks(this.rawContent);
    this.loading = false;
    cx.notify();
  }

  parseTasks(content) {
    if (!content) return [];
    const lines = content.split("\n");
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

  async toggleTask(task, cx) {
    if (!this.filePath || !this.rawContent) return;
    const lines = this.rawContent.split("\n");
    if (task.lineIndex >= lines.length) return;

    const oldLine = lines[task.lineIndex];
    const newCheck = task.done ? "[ ]" : "[x]";
    const newLine = oldLine.replace(/\[([ xX])\]/, newCheck);
    lines[task.lineIndex] = newLine;

    const updated = lines.join("\n");
    try {
      await writeTextFile(this.filePath, updated, { on: this.on });
      this.rawContent = updated;
      this.tasks = this.parseTasks(updated);
      cx.notify();
    } catch (e) {
      notify({ title: "Failed to update TODO.md", body: String(e), level: "error" });
    }
  }

  async addTask(cx) {
    const text = this.newInput.value().trim();
    if (!text) return;
    const { folder, on } = activeFolder();
    if (!folder) return;

    const path = this.filePath || `${folder}/TODO.md`;
    let content = this.rawContent;
    if (!this.filePath) {
      content = `# Project Tasks\n\n`;
    }

    const taskLine = `- [ ] ${text}\n`;
    const nextContent = content.endsWith("\n") || !content ? `${content}${taskLine}` : `${content}\n${taskLine}`;

    try {
      await writeTextFile(path, nextContent, { on });
      this.newInput.set_value("");
      this.filePath = path;
      this.rawContent = nextContent;
      this.tasks = this.parseTasks(nextContent);
      notify({ title: "Task added to TODO.md", body: text, level: "success" });
      cx.notify();
    } catch (e) {
      notify({ title: "Failed to save task", body: String(e), level: "error" });
    }
  }

  async deleteTask(task, cx) {
    if (!this.filePath || !this.rawContent) return;
    const lines = this.rawContent.split("\n");
    if (task.lineIndex >= lines.length) return;

    lines.splice(task.lineIndex, 1);
    const updated = lines.join("\n");
    try {
      await writeTextFile(this.filePath, updated, { on: this.on });
      this.rawContent = updated;
      this.tasks = this.parseTasks(updated);
      cx.notify();
    } catch (e) {
      notify({ title: "Failed to delete task", body: String(e), level: "error" });
    }
  }

  async createTodoFile(cx) {
    const { folder, on } = activeFolder();
    if (!folder) return;
    const path = `${folder}/TODO.md`;
    const initial = `# Project Tasks\n\n- [ ] Initial task\n`;
    try {
      await writeTextFile(path, initial, { on });
      this.filePath = path;
      this.rawContent = initial;
      this.tasks = this.parseTasks(initial);
      notify({ title: "Created TODO.md", body: path, level: "success" });
      cx.notify();
    } catch (e) {
      notify({ title: "Failed to create TODO.md", body: String(e), level: "error" });
    }
  }

  askAgent(task, cx) {
    const prompt = `@TODO.md Please implement the following task:\n"${task.text}"`;
    const f = focused();
    const ps = typeof panes === "function" ? panes() : [];
    const term = f?.terminal || ps.find((p) => p.tab === f?.tab && p.terminal)?.terminal;
    if (term) {
      exec("hc", ["send", term, prompt]).catch(() => null);
      notify({ title: "Task sent to agent", body: task.text, level: "info" });
    } else {
      cx.write_to_clipboard(prompt);
      notify({ title: "Copied to clipboard", body: "Paste into an agent terminal to run.", level: "info" });
    }
  }

  render(cx) {
    const t = theme();
    const { folder } = activeFolder();

    if (!folder) {
      return div().id("t3-todos").size_full().flex().items_center().justify_center().p(20)
        .child(div().text_size(13).text_color(t.dim).child("Open a workspace or folder to manage tasks."));
    }

    if (!this.filePath && !this.loading) {
      return v_flex().id("t3-todos").size_full().items_center().justify_center().p(24).gap(12)
        .child(svg(`${MOD}/icons/file-text.svg`).size(36).text_color(t.muted))
        .child(div().text_size(14).font_medium().text_color(t.foreground).child("No TODO.md in this project"))
        .child(div().text_size(12.5).text_color(t.dim).text_center().child("Track tasks, todo checklists, and dispatch them to AI agents."))
        .child(div().id("btn-create-todo").px(12).py(6).rounded(7).bg(t.raised).border_1().border_color(t.border).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.createTodoFile(cx))
          .child(div().text_size(13).font_medium().text_color(t.foreground).child("Create TODO.md")));
    }

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
        .bg(active ? t.selected : t.raised)
        .text_color(active ? t.foreground : t.dim)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          this.filter = id;
          cx.notify();
        })
        .child(div().text_size(12).font_medium().child(label))
        .child(div().text_size(11).text_color(active ? t.accent : t.muted).child(String(count)));
    };

    return v_flex().id("t3-todos").size_full().min_h(0).bg(t.background)
      // Toolbar header
      .child(h_flex().h(40).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(chip("all", "All", total))
        .child(chip("active", "Active", activeCount))
        .child(chip("done", "Done", doneCount))
        .child(div().flex_1())
        .when(total > 0, (el) => el.child(div().text_size(10.5).font_medium().text_color(doneCount === total ? t.done : t.dim).child(`${Math.round((doneCount / total) * 100)}%`)))
        .child(div().id("btn-refresh-todos").p(4).rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx))
          .child(svg(`${MOD}/icons/rotate-cw.svg`).size(14).text_color(t.muted))))
      .when(total > 0, (el) => {
        const pctDone = Math.round((doneCount / total) * 100);
        return el.child(h_flex().w_full().h(3).flex_none().bg(t.border)
          .when(pctDone > 0, (fEl) => fEl.child(div().h_full().bg(pctDone === 100 ? t.done : t.accent).flex_grow(pctDone)))
          .when(pctDone < 100, (uEl) => uEl.child(div().h_full().flex_grow(100 - pctDone))));
      })
      // Add task input bar
      .child(h_flex().px(10).py(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(Input.new(this.newInput).w_full().h(32).px(8).rounded(7).border_1().border_color(t.border).bg(t.raised).text_size(13).text_color(t.foreground)))
      // Tasks list
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(4)
        .when(visibleTasks.length === 0, (el) => el.child(
          div().py(32).flex().items_center().justify_center().text_size(13).text_color(t.dim).child("No tasks in this view")
        ))
        .children(visibleTasks.map((tk) => {
          const key = `task-${tk.lineIndex}`;
          return h_flex().id(key).w_full().py(6).px(8).gap(8).items_center().rounded(7)
            .hover((s) => s.bg(t.hover))
            // Checkbox
            .child(div().id(`${key}-check`).size(20).flex_none().flex().items_center().justify_center().cursor_pointer()
              .on_click((_e, cx) => this.toggleTask(tk, cx))
              .child(svg(`${MOD}/icons/${tk.done ? "check-square" : "square"}.svg`).size(16).text_color(tk.done ? t.done : t.muted)))
            // Task text
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().text_size(13).text_color(tk.done ? t.dim : t.foreground)
                .when(tk.done, (txt) => txt.line_through())
                .child(tk.text))
              .when(Boolean(tk.section), (sub) => sub.child(div().text_size(10.5).text_color(t.dim).child(tk.section))))
            // Ask Agent dispatch button
            .child(div().id(`${key}-agent`).h(24).px(6).gap(4).flex_none().flex().items_center().rounded(5).cursor_pointer()
              .bg(t.raised).border_1().border_color(t.border)
              .hover((s) => s.bg(t.selected))
              .on_click((_e, cx) => this.askAgent(tk, cx))
              .child(svg(`${MOD}/icons/sparkles.svg`).size(12).text_color(t.accent))
              .child(div().text_size(11).font_medium().text_color(t.foreground).child("Agent")))
            // Delete button
            .child(div().id(`${key}-del`).size(20).flex_none().flex().items_center().justify_center().cursor_pointer()
              .hover((s) => s.bg(t.raised))
              .on_click((_e, cx) => this.deleteTask(tk, cx))
              .child(svg(`${MOD}/icons/x.svg`).size(13).text_color(t.dim)));
        })));
  }
}
