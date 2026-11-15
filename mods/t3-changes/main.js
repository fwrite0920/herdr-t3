import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, home, window, layout } from "herdr";

const MOD = "mods/t3-changes";

function isChangesActive() {
  if (typeof window === "function" && window()?.active === false) return false;
  const root = typeof layout === "function" ? layout() : null;
  if (!root) return true;
  const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((hit, c) => hit ?? find(c, id), null));
  const panel = find(root, "panel");
  if (panel && panel.hidden) return false;
  const body = find(root, "panel-body");
  if (body && body.active && body.active !== "changes") return false;
  return true;
}

const norm = (p) => (p ? p.replace(/\\/g, "/").replace(/\/+$/, "") : "");

function location() {
  const sp = spaces().find((s) => s.active);
  const ps = typeof panes === "function" ? panes() : [];
  const f = typeof focused === "function" ? focused() : null;
  const tabs = new Set((sp?.tabs ?? []).map((c) => c.id));
  const focusPane = f?.pane && tabs.has(f.tab) ? ps.find((p) => p.pane === f.pane && p.cwd) : null;
  const cwd = focusPane?.cwd || ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || sp?.folder || "";
  return { cwd: norm(cwd), on: sp?.machine ?? null };
}

const key = () => JSON.stringify(location());
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);

function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      return { kind: "@", text: line };
    }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") {
      old++;
      return { kind, number: next++, text: line.slice(1) || " " };
    }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = [];
    this.rows = [];
    this.diffWidth = 0;
    this.listOpen = true;
    this.confirmDiscard = null;
    this.message = "";
    this.gen = false;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => { if (isChangesActive()) this.refresh(cx); });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch {
        this.watched = null;
      }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context;
      this.root = null;
      this.files = [];
      this.open = null;
      this.setLines([]);
      this.message = "";
      this.input.set_value("");
      this.error = null;
      this.note = null;
      this.watched = null;
      this.closed = false;
      this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        let root = this.root;
        if (!root) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
          if (key() !== context) return;
          if (!top || top.code !== 0) {
            this.root = null;
            this.files = [];
            this.setLines([]);
            this.open = null;
            this.error = "Not a git repository";
            return;
          }
          root = top.stdout.trim().replace(/\\/g, "/");
        }
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [status, head] = await Promise.all([
          git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
          git(["rev-parse", "--verify", "HEAD"]),
        ]);
        if (status.code !== 0) throw new Error(status.stderr);
        const stats = {};
        const results = head.code === 0
          ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
          : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), x = xy[0], y = xy[1], path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const staged = !fresh && x !== " " && x !== "?";
          const unstaged = fresh || y !== " ";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, staged, unstaged, ...stat });
        }
        if (key() !== context) return;
        this.root = root;
        this.on = on;
        this.hasHead = head.code === 0;
        this.files = files;
        this.limited = entries.length > 1000;
        this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) {
          this.open = null;
          this.setLines([]);
        }
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try {
            await this.load(this.open, context);
          } catch {
            if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]);
          }
        }
      } catch (e) {
        if (key() === context) this.error = String(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map((l) => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) {
      this.setLines(lines.slice(0, 1500).map((line) => (line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line)));
    }
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map((line) => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path;
    this.setLines([]);
    this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) {
      cx.spawn(async (cx) => {
        try {
          await this.load(path, context);
        } catch (e) {
          if (key() === context && this.open === path) this.note = `Cannot preview this diff: ${e}`;
        }
        cx.notify();
      });
    }
    cx.notify();
  }

  stageFile(f, cx) {
    if (!this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context;
    const args = (f.staged && !f.unstaged) ? ["reset", "HEAD", "--", f.path] : ["add", "--", f.path];
    this.busy = true;
    this.note = null;
    this.confirmDiscard = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", args, { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) {
        if (key() === context) this.note = `Stage failed: ${e}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  discardFile(f, cx) {
    if (!this.root || this.busy || this.loading || this.context !== key()) return;
    if (this.confirmDiscard !== f.path) {
      this.confirmDiscard = f.path;
      cx.notify();
      return;
    }
    this.confirmDiscard = null;
    const root = this.root, on = this.on, context = this.context;
    const args = f.fresh ? ["clean", "-fd", "--", f.path] : ["checkout", "HEAD", "--", f.path];
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", args, { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) {
        if (key() === context) this.note = `Discard failed: ${e}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    const hasStaged = this.files.some((f) => f.staged);
    this.busy = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const steps = hasStaged ? [["commit", "-m", message]] : [["add", "-A"], ["commit", "-m", message]];
        for (const args of steps) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) {
          this.message = "";
          this.input.set_value("");
        }
      } catch (e) {
        if (key() === context) this.note = `Commit failed: ${e}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  generate(cx) {
    if (this.gen || !this.root || this.loading || this.context !== key()) return;
    if (!this.files.length) {
      this.note = "没有变更可生成";
      cx.notify();
      return;
    }
    const root = this.root, on = this.on, context = this.context, hasHead = this.hasHead;
    const files = this.files.map((f) => `${f.status} ${f.path} (+${f.add} −${f.del})`).join("\n");
    this.gen = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const [log, diff] = await Promise.all([
          exec("git", [...READ, "log", "--oneline", "-5"], { cwd: root, on }).catch(() => null),
          exec("git", [...READ, "diff", ...(hasHead ? ["HEAD"] : ["--cached"]), "--no-color", "--no-textconv", "--no-ext-diff"], { cwd: root, on }).catch(() => null),
        ]);
        const style = log && log.code === 0 ? log.stdout.trim() : "";
        const body = diff && diff.code === 0 ? diff.stdout.slice(0, 4000) : "";
        const prompt = [
          "你是 git 提交信息助手。根据「变更文件」和「diff 摘录」写一条简洁的中文 commit message：一行，不超过 50 个字，概括这次改了什么。",
          "只输出这一行 message 本身，不要解释、不要引号、不要代码块。",
          ...(style ? [`参考最近提交的风格：\n${style}`] : []),
          `变更文件：\n${files}`,
          ...(body ? [`diff 摘录：\n${body}`] : ["（无文本 diff，依据文件名推测）"]),
        ].join("\n\n");

        let message = "";
        const rPi = await exec("pi", ["-p", "--no-session", prompt], { cwd: root, on }).catch(() => null);
        if (rPi?.code === 0 && rPi.stdout?.trim()) {
          message = rPi.stdout.trim();
        } else {
          const rClaude = await exec("claude", ["-p", prompt], { cwd: root, on }).catch(() => null);
          if (rClaude?.code === 0 && rClaude.stdout?.trim()) {
            message = rClaude.stdout.trim();
          } else {
            const first = this.files[0];
            const count = this.files.length;
            message = `update ${first ? first.path : "files"}${count > 1 ? ` 等 ${count} 个文件` : ""}`;
          }
        }
        if (key() !== context) return;
        message = message.replace(/^["'`]+|["'`]+$/g, "").split("\n").filter(Boolean).pop() || "";
        this.message = message;
        this.input.set_value(message);
      } catch (e) {
        if (key() === context) this.note = `AI 生成失败: ${e}`;
      } finally {
        this.gen = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  stepFile(dir, cx) {
    if (!this.files.length) return;
    const idx = this.files.findIndex((f) => f.path === this.open);
    const nextIdx = idx < 0 ? 0 : (idx + dir + this.files.length) % this.files.length;
    this.pick(this.files[nextIdx].path, cx);
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") {
      const m = /^(@@[^@]+@@)\s*(.*)$/.exec(text);
      return h_flex().w_full().px(10).h(22).gap(8).items_center().flex_none().bg(t.raised).border_t(1).border_b(1).border_color(t.border)
        .child(div().flex_none().font_bold().text_color(t.accent).child(m ? m[1] : text))
        .when(Boolean(m?.[2]), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(m[2])));
    }
    const sign = kind === "+" ? "+" : kind === "-" ? "−" : " ";
    const signColor = kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim;
    return h_flex().w_full().h(20).flex_none().gap(6)
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18"))
      .when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(12).flex_none().text_center().font_bold().text_color(signColor).child(sign))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    const isConfirm = this.confirmDiscard === f.path;
    const statusColor = f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked;
    return h_flex().id(`change-${f.path}`).h(28).flex_none().px(6).gap(6).items_center().rounded(6).cursor_pointer()
      .when(this.open === f.path, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(f.path, cx))
      .child(div().w(14).flex_none().text_size(11).font_bold().text_color(statusColor).child(f.status))
      .child(h_flex().flex_1().min_w(0).items_center()
        .when(parts.length > 0, (el) => el.child(div().text_color(t.dim).truncate().child(parts.join("/") + "/")))
        .child(div().flex_none().max_w(220).truncate().font_medium().child(name)))
      .when(f.staged, (el) => el.child(div().px(4).py(0.5).rounded(3).bg(t.ansi2 + "22").text_size(9.5).font_bold().text_color(t.ansi2).child("S")))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)))
      .child(div().id(`stage-${f.path}`).px(5).py(1).rounded(4).bg(t.raised).text_size(10.5).font_bold()
        .text_color((f.staged && !f.unstaged) ? t.ansi2 : t.muted)
        .hover((s) => s.text_color(t.foreground).bg(t.border))
        .on_click((_e, cx) => { cx.stop_propagation(); this.stageFile(f, cx); })
        .child((f.staged && !f.unstaged) ? "−" : "+"))
      .child(div().id(`discard-${f.path}`).px(5).py(1).rounded(4).bg(isConfirm ? t.ansi1 + "33" : t.raised).text_size(10.5).font_medium()
        .text_color(isConfirm ? t.ansi1 : t.dim)
        .hover((s) => s.text_color(t.ansi1).bg(t.ansi1 + "22"))
        .on_click((_e, cx) => { cx.stop_propagation(); this.discardFile(f, cx); })
        .child(isConfirm ? "确认?" : "↺"));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const stagedFiles = this.files.filter((f) => f.staged);
    const unstagedFiles = this.files.filter((f) => !f.staged || f.unstaged);
    const openFile = this.files.find((f) => f.path === this.open);
    const hunkCount = this.rows.filter((r) => r.kind === "@").length;
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("t3-changes").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) {
          this.typing = false;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(h_flex().id("t3-changes-toolbar").h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Changes"))
        .child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).cursor_pointer()
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.listOpen = !this.listOpen; cx.notify(); })
          .child(`${this.listOpen ? "▾" : "▸"} ${this.files.length} files`))
        .when(stagedFiles.length > 0, (el) => el.child(
          div().px(5).py(1).rounded(4).bg(t.ansi2 + "20").text_size(10.5).font_medium().text_color(t.ansi2).child(`${stagedFiles.length} staged`)))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
        .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .when(this.listOpen, (el) => el.child(
        v_flex().id("changes-list").flex_none().h(Math.min(200, Math.max(40, this.files.length * 28 + (stagedFiles.length && unstagedFiles.length ? 26 : 10)))).overflow_y_scrollbar().p(6).gap(2).border_b(1).border_color(t.border)
          .when(stagedFiles.length > 0 && unstagedFiles.length > 0, (g) => g.child(
            div().px(6).py(2).text_size(10).font_bold().text_color(t.ansi2).child(`STAGED (${stagedFiles.length})`)))
          .children(stagedFiles.map((f) => this.fileRow(f, t)))
          .when(stagedFiles.length > 0 && unstagedFiles.length > 0, (g) => g.child(
            div().px(6).pt(4).pb(2).text_size(10).font_bold().text_color(t.muted).child(`CHANGES (${unstagedFiles.length})`)))
          .children((stagedFiles.length > 0 ? unstagedFiles.filter((f) => !f.staged) : this.files).map((f) => this.fileRow(f, t)))
          .when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder"))))))
      .when(this.limited, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(openFile), (el) => el.child(
        h_flex().h(28).flex_none().px(10).gap(6).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(11)
          .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(openFile.path))
          .when(hunkCount > 0, (hEl) => hEl.child(div().flex_none().text_size(10).text_color(t.dim).child(`${hunkCount} hunks`)))
          .child(div().px(5).py(1).rounded(4).bg(t.background).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.stepFile(-1, cx)).child("‹"))
          .child(div().px(5).py(1).rounded(4).bg(t.background).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.stepFile(1, cx)).child("›"))))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(4).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(8).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(6).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit-ai").h(32).px(10).flex().items_center().rounded(6).bg(t.raised).text_color(this.gen || !this.root || this.loading || this.context !== key() ? t.dim : t.accent).text_size(12).font_medium().cursor_pointer().on_click((_e, cx) => this.generate(cx)).child(this.gen ? "…" : "AI"))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(6).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).font_medium().when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : stagedFiles.length > 0 ? `Commit (${stagedFiles.length})` : "Commit")));
  }
}
