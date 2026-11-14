import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, run, exec, shared, setShared, home, notify, theme } from "herdr";

const TAGS = "t3.sessions.tags";
const MOD = "mods/t3-sessions";

const PI = "pi", CC = "cc", AGY = "agy";
const AGENTS = {
  [PI]: { label: "pi", color: "ansi5", argv: (id) => ["pi", "--session", id] },
  [CC]: { label: "cc", color: "ansi3", argv: (id) => ["claude", "--resume", id] },
  [AGY]: { label: "agy", color: "ansi4", argv: (_id) => ["agy"] },
};

const norm = (p) => (p ? p.replace(/\\/g, "/").replace(/\/+$/, "") : "");

function currentPlace() {
  const sp = spaces().find((s) => s.active);
  const ps = typeof panes === "function" ? panes() : [];
  const f = typeof focused === "function" ? focused() : null;
  const tabs = new Set((sp?.tabs ?? []).map((c) => c.id));
  const focusPane = f?.pane && tabs.has(f.tab) ? ps.find((p) => p.pane === f.pane && p.cwd) : null;
  const cwd = focusPane?.cwd || ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || sp?.folder || "";
  return { cwd: norm(cwd), on: sp?.machine ?? null };
}

function when(millis) {
  const s = Math.max(0, Date.now() - millis) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

const SCAN_NODE = `
const fs = require('fs');
const h = (process.argv[1] || '').replace(/\\\\/g, '/');
const norm = (p) => (p ? p.replace(/\\\\/g, '/').replace(/\\/+$/, '').replace(/^[\\\"']|[\\\"']$/g, '') : '');

function scanPi(h) {
  const out = [];
  const base = h + '/.pi/agent/sessions';
  try {
    const subs = fs.readdirSync(base);
    for (const sub of subs) {
      const dir = base + '/' + sub;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const fp = dir + '/' + file;
          try {
            const stat = fs.statSync(fp);
            const head = fs.readFileSync(fp, 'utf8').slice(0, 16384);
            const first = head.split('\\n')[0];
            const o = JSON.parse(first || '{}');
            const ident = o.id || file.replace(/\\.jsonl$/, '').split('_').pop() || file;
            let title = '';
            for (const line of head.split('\\n')) {
              if (!line.trim()) continue;
              try {
                const row = JSON.parse(line);
                if (row.type === 'session_info' && row.name) { title = row.name; break; }
                const msg = row.message || {};
                if ((row.type === 'user' || msg.role === 'user') && !title) {
                  const c = msg.content || row.content;
                  title = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join(' ') : '';
                  if (title.trim()) break;
                }
              } catch {}
            }
            out.push({ agent: 'pi', id: ident, file, cwd: norm(o.cwd || ''), mtime: stat.mtimeMs, title: title.trim().slice(0, 200) });
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return out;
}

function scanClaude(h) {
  const out = [];
  const base = h + '/.claude/projects';
  try {
    const subs = fs.readdirSync(base);
    for (const sub of subs) {
      const dir = base + '/' + sub;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const fp = dir + '/' + file;
          try {
            const stat = fs.statSync(fp);
            const head = fs.readFileSync(fp, 'utf8').slice(0, 16384);
            const first = head.split('\\n')[0];
            const o = JSON.parse(first || '{}');
            const ident = file.replace(/\\.jsonl$/, '');
            let title = '';
            for (const line of head.split('\\n')) {
              if (!line.trim()) continue;
              try {
                const row = JSON.parse(line);
                const msg = row.message || {};
                if (row.type === 'user' || msg.role === 'user') {
                  const c = msg.content || row.content;
                  title = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join(' ') : '';
                  if (title.trim()) break;
                }
              } catch {}
            }
            out.push({ agent: 'cc', id: ident, file, cwd: norm(o.cwd || ''), mtime: stat.mtimeMs, title: title.trim().slice(0, 200) });
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return out;
}

function scanAgy(h) {
  const out = [];
  const base = h + '/.gemini/antigravity-cli/brain';
  try {
    const dirs = fs.readdirSync(base);
    for (const id of dirs) {
      const transcript = base + '/' + id + '/.system_generated/logs/transcript.jsonl';
      try {
        const stat = fs.statSync(transcript);
        const data = fs.readFileSync(transcript, 'utf8');
        let title = '', cwd = '';
        const lines = data.split('\\n');
        for (let i = 0; i < Math.min(lines.length, 50); i++) {
          const line = lines[i];
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            if (o.type === 'USER_INPUT' && !title) {
              const c = typeof o.content === 'string' ? o.content : '';
              const m = c.match(/<USER_REQUEST>([\\s\\S]*?)<\\/USER_REQUEST>/);
              title = (m ? m[1] : c).trim();
            }
            if (!cwd && o.tool_calls) {
              for (const tc of o.tool_calls) {
                const args = tc.args || tc.function?.arguments;
                const a = typeof args === 'string' ? JSON.parse(args) : args;
                const p = a?.Cwd || a?.Path;
                if (p && typeof p === 'string' && !p.includes('.gemini') && !p.includes('AppData')) {
                  const parts = norm(p).split('/');
                  if (parts.length >= 2) {
                    if (/\\.[a-zA-Z0-9]+$/.test(parts[parts.length - 1])) parts.pop();
                    cwd = parts.join('/');
                    break;
                  }
                }
              }
            }
            if (title && cwd) break;
          } catch {}
        }
        out.push({ agent: 'agy', id, file: id, cwd, mtime: stat.mtimeMs, title: title.slice(0, 200) });
      } catch {}
    }
  } catch {}
  return out;
}

const list = [...scanPi(h), ...scanClaude(h), ...scanAgy(h)];
process.stdout.write(JSON.stringify(list));
`;

export default class Sessions extends View {
  init(_props, cx) {
    this.sessions = [];
    this.error = null;
    this.loading = false;
    this.showAll = false;
    this.tagOnly = null;
    this.filter = "";
    this.tagging = null;
    this.input = InputState.new({ placeholder: "搜索标题/路径， #标签 过滤" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      cx.notify();
    });
    this.refresh(cx);
    cx.timer.every(30000, (cx) => this.refresh(cx));
    this.watch = null;
    cx.timer.every(1000, (cx) => {
      const { cwd } = currentPlace();
      if (cwd !== this.watch) {
        this.watch = cwd;
        cx.notify();
      }
    });
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const h = norm(home());
        const res = await exec("node", ["-e", SCAN_NODE, h]).catch(() => null);
        if (res && res.stdout) {
          const combined = JSON.parse(res.stdout);
          this.sessions = combined.filter((s) => s.title || s.cwd).sort((a, b) => b.mtime - a.mtime).slice(0, 300);
          this.error = null;
        } else {
          this.sessions = [];
        }
      } catch (e) {
        this.error = String(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  keyOf(session) {
    return `${session.agent}:${session.file || session.id}`;
  }

  tagsOf(session) {
    const all = shared(TAGS) ?? shared("hs.sessions.tags") ?? {};
    return all[this.keyOf(session)] ?? all[`${session.agent}:${session.id}`] ?? [];
  }

  setTags(session, tags, cx) {
    const all = { ...(shared(TAGS) ?? shared("hs.sessions.tags") ?? {}) };
    const key = this.keyOf(session);
    if (tags.length) all[key] = tags;
    else delete all[key];
    setShared(TAGS, all);
    setShared("hs.sessions.tags", all);
    cx.notify();
  }

  visible(root) {
    const raw = this.filter.trim();
    const wanted = [...raw.matchAll(/#([^\s#]+)/g)].map((m) => m[1].toLowerCase());
    const q = raw.replace(/#[^\s#]+/g, " ").trim().toLowerCase();
    return this.sessions.filter((s) => {
      if (!this.showAll && root && s.cwd && !(s.cwd === root || s.cwd.startsWith(root + "/") || root.startsWith(s.cwd + "/"))) return false;
      const own = this.tagsOf(s).map((x) => String(x).toLowerCase());
      if (this.tagOnly && !own.includes(String(this.tagOnly).toLowerCase())) return false;
      if (wanted.some((tag) => !own.some((x) => x.includes(tag)))) return false;
      if (!q) return true;
      return `${s.title} ${own.join(" ")} ${s.cwd}`.toLowerCase().includes(q);
    });
  }

  resume(session) {
    const agent = AGENTS[session.agent];
    if (!agent) return;
    const folder = session.cwd || currentPlace().cwd;
    if (!folder) {
      notify({ title: "会话没有记录目录", level: "warning" });
      return;
    }
    run("terminal.open", { argv: agent.argv(session.id), folder, place: "tab" });
  }

  tagInputFor(key) {
    if (this.tagKey !== key) {
      this.tagKey = key;
      this.tagInput = InputState.new({ placeholder: "标签，逗号分隔" });
      this.tagInput.on("submit", (_e, cx) => this.commitTag(cx));
    }
    return this.tagInput;
  }

  startTag(session, cx) {
    const key = this.keyOf(session);
    this.tagging = this.tagging === key ? null : key;
    if (this.tagging) {
      const cur = this.tagsOf(session).join(", ");
      this.tagInputFor(key).set_value(cur);
    }
    cx.notify();
  }

  commitTag(cx) {
    if (!this.tagging) return;
    const s = this.sessions.find((x) => this.keyOf(x) === this.tagging);
    if (s) {
      const raw = this.tagInput.value();
      const tags = raw.split(/[,，\s]+/).map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
      this.setTags(s, tags, cx);
    }
    this.tagging = null;
    cx.notify();
  }

  tagChip(session, tag, j, i, t) {
    return h_flex().id(`tag-${i}-${j}`).h(18).px(5).gap(3).flex_none().items_center().rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted)
      .on_click((_e, cx) => { cx.stop_propagation(); this.tagOnly = tag; cx.notify(); })
      .child(div().child(`#${tag}`))
      .child(div().text_size(9).text_color(t.dim).hover((s) => s.text_color(t.ansi1))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          const next = this.tagsOf(session).filter((x) => x !== tag);
          this.setTags(session, next, cx);
        })
        .child("✕"));
  }

  row(session, i, t, short, root) {
    const tags = this.tagsOf(session), agent = AGENTS[session.agent];
    const tagging = this.tagging === this.keyOf(session);
    const away = session.cwd && root && !session.cwd.startsWith(root);
    return div().id(`session-${i}`).flex().flex_col().flex_none().w_full().min_w(0).gap(4).px(10).py(8).rounded(7)
      .when(!tagging, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.resume(session)))
      .when(tagging, (el) => el.bg(t.selected))
      .child(h_flex().w_full().min_w(0).gap(8).items_center()
        .child(div().id(`agent-${i}`).min_w(26).h(16).px(4).flex_none().flex().items_center().justify_center().rounded(4).bg(t.raised).text_size(9.5).font_medium().text_color(t[agent.color]).child(agent.label))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(session.title || "(无标题)"))
        .when(!tagging, (el) => el.child(div().id(`tag-add-${i}`).size(18).flex_none().flex().items_center().justify_center().rounded(4).text_size(11).text_color(t.dim)
          .hover((s) => s.text_color(t.accent).bg(t.raised))
          .on_click((_e, cx) => { cx.stop_propagation(); this.startTag(session, cx); })
          .child("+"))))
      .child(h_flex().w_full().min_w(0).pl(34).gap(6).items_center()
        .child(div().flex_none().text_size(11).text_color(t.dim).child(when(session.mtime)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child("·"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).when(Boolean(away), (el) => el.text_color(t.dim)).child(short(session.cwd) || "未记录目录")))
      .when(tagging, (el) => el.child(h_flex().w_full().min_w(0).pl(34).gap(4).items_center()
        .child(Input.new(this.tagInputFor(this.keyOf(session))).flex_1().min_w(0).h(24).text_size(11).text_color(t.foreground))
        .child(div().id("tag-save").h(24).px(8).flex_none().flex().items_center().rounded(5).bg(t.raised).cursor_pointer().text_size(11).text_color(t.accent)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.commitTag(cx); }).child("保存"))))
      .when(!tagging && tags.length > 0, (el) => el.child(h_flex().w_full().min_w(0).pl(34).gap(4).items_center().overflow_hidden()
        .children(tags.slice(0, 6).map((tag, j) => this.tagChip(session, tag, j, i, t)))
        .when(tags.length > 6, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`+${tags.length - 6}`)))));
  }

  render() {
    const t = theme(), h = norm(home()), root = currentPlace().cwd;
    const short = (p) => {
      const np = norm(p);
      return np && h && np.startsWith(h) ? "~" + np.slice(h.length) : p ?? "";
    };
    const list = this.visible(root);
    const counts = { [PI]: 0, [CC]: 0, [AGY]: 0 };
    for (const s of list) if (counts[s.agent] !== undefined) counts[s.agent]++;
    return v_flex().id("t3-sessions").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().id("t3-sessions-toolbar").h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Sessions"))
        .child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(`${list.length}`))
        .child(div().flex_1())
        .child(div().id("sess-root").max_w(160).truncate().text_size(11).cursor_pointer()
          .text_color(this.showAll ? t.accent : t.dim)
          .hover((s) => s.text_color(t.accent))
          .on_click((_e, cx) => { this.showAll = !this.showAll; cx.notify(); })
          .child(this.showAll ? "所有项目 (切回当前)" : (short(root) || "当前项目") + " ▾"))
        .when(Boolean(this.tagOnly), (el) => el.child(h_flex().id("sess-tagonly").h(22).px(6).gap(4).flex_none().items_center().rounded(5).bg(t.raised).text_size(11).text_color(t.accent)
          .child(div().max_w(80).truncate().child(`#${this.tagOnly}`))
          .child(div().text_size(10).text_color(t.dim).hover((s) => s.text_color(t.ansi1))
            .on_click(() => { this.tagOnly = null; }).child("✕")))))
      .child(h_flex().h(32).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`pi ${counts[PI]} · cc ${counts[CC]} · agy ${counts[AGY]}`)))
      .child(v_flex().id("session-list").flex_1().min_h(0).p(6).gap(3).overflow_y_scrollbar()
        .children(list.map((s, i) => this.row(s, i, t, short, root))))
      .when(!list.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim)
        .child(this.error || (this.loading ? "Loading sessions…" : !root ? "当前 space 没有目录" : "当前项目暂无历史会话 (点击右上角可切换所有项目)"))));
  }
}
