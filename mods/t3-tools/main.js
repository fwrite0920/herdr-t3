import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, run, exec, home, notify, theme, readTextFile } from "herdr";

const MOD = "mods/t3-tools";

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

const SCAN_NODE = `
const fs = require('fs');
const path = require('path');
const h = (process.argv[1] || '').replace(/\\\\/g, '/');
const cwd = (process.argv[2] || '').replace(/\\\\/g, '/');

const norm = (p) => (p ? p.replace(/\\\\/g, '/').replace(/\\/+$/, '').replace(/^[\\\"']|[\\\"']$/g, '') : '');

function parseFrontmatter(text) {
  let name = '', description = '';
  const m = text.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---/);
  if (m) {
    const yaml = m[1];
    const nMatch = yaml.match(/^name:\\s*[\\\"']?([^\\\"'\\r\\n]+)/m);
    if (nMatch) name = nMatch[1].trim();
    const dMatch = yaml.match(/^description:\\s*[\\\"']?([^\\\"'\\r\\n]+)/m);
    if (dMatch) description = dMatch[1].trim();
  }
  if (!name) {
    const h1 = text.match(/^#\\s+([^\\r\\n]+)/m);
    if (h1) name = h1[1].trim();
  }
  if (!description) {
    const lines = text.replace(/^---[\\s\\S]*?---\\r?\\n/, '').split('\\n');
    for (const l of lines) {
      const s = l.trim().replace(/^#+\\s*/, '');
      if (s && !s.startsWith('![')) { description = s; break; }
    }
  }
  return { name, description: description.slice(0, 200) };
}

function scanSkillDir(baseDir, scope, source) {
  const out = [];
  try {
    if (!fs.existsSync(baseDir)) return out;
    const entries = fs.readdirSync(baseDir);
    for (const entry of entries) {
      const dirPath = norm(path.join(baseDir, entry));
      try {
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) continue;
        const skillMd = norm(path.join(dirPath, 'SKILL.md'));
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, 'utf8').slice(0, 4096);
          const meta = parseFrontmatter(content);
          out.push({
            kind: 'skill',
            id: entry,
            name: meta.name || entry,
            description: meta.description || '',
            scope,
            source,
            path: skillMd,
            dir: dirPath
          });
        }
      } catch {}
    }
  } catch {}
  return out;
}

function scanPlugins(h) {
  const out = [];
  const pDir = norm(path.join(h, '.gemini/config/plugins'));
  try {
    if (fs.existsSync(pDir)) {
      for (const p of fs.readdirSync(pDir)) {
        const dir = norm(path.join(pDir, p));
        try {
          if (!fs.statSync(dir).isDirectory()) continue;
          let name = p, desc = '', ver = '';
          const pj = norm(path.join(dir, 'plugin.json'));
          if (fs.existsSync(pj)) {
            try {
              const data = JSON.parse(fs.readFileSync(pj, 'utf8'));
              name = data.name || p;
              desc = data.description || '';
              ver = data.version || '';
            } catch {}
          }
          out.push({
            kind: 'plugin',
            id: p,
            name,
            description: desc,
            version: ver,
            scope: 'global',
            source: 'gemini',
            path: pj,
            dir
          });
        } catch {}
      }
    }
  } catch {}
  return out;
}

function scanMcp(h) {
  const out = [];
  const mcpDir = norm(path.join(h, '.gemini/antigravity-cli/mcp'));
  try {
    if (fs.existsSync(mcpDir)) {
      for (const m of fs.readdirSync(mcpDir)) {
        const dir = norm(path.join(mcpDir, m));
        try {
          if (fs.statSync(dir).isDirectory()) {
            out.push({
              kind: 'mcp',
              id: m,
              name: m,
              description: 'Antigravity MCP Service',
              scope: 'builtin',
              source: 'gemini',
              dir
            });
          }
        } catch {}
      }
    }
  } catch {}
  return out;
}

const list = [
  ...scanSkillDir(norm(path.join(cwd, '.agents/skills')), 'project', 'agents'),
  ...scanSkillDir(norm(path.join(cwd, '.gemini/skills')), 'project', 'gemini'),
  ...scanSkillDir(norm(path.join(h, '.agents/skills')), 'global', 'agents'),
  ...scanSkillDir(norm(path.join(h, '.gemini/config/skills')), 'global', 'gemini'),
  ...scanSkillDir(norm(path.join(h, '.gemini/antigravity-cli/skills')), 'global', 'gemini'),
  ...scanSkillDir(norm(path.join(h, '.gemini/antigravity-cli/builtin/skills')), 'builtin', 'gemini'),
  ...scanPlugins(h),
  ...scanMcp(h)
];

const seen = new Set();
const dedup = [];
for (const item of list) {
  const k = item.kind + ':' + item.id;
  if (!seen.has(k)) {
    seen.add(k);
    dedup.push(item);
  }
}
process.stdout.write(JSON.stringify(dedup));
`;

export default class Tools extends View {
  init(_props, cx) {
    this.tools = [];
    this.loading = false;
    this.error = null;
    this.filter = "";
    this.category = "all"; // all, skill, plugin, project, global
    this.selected = null;
    this.previewContent = null;
    this.input = InputState.new({ placeholder: "搜索技能、MCP与插件…" });
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
        this.refresh(cx);
      }
    });
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const h = norm(home());
        const { cwd } = currentPlace();
        const res = await exec("node", ["-e", SCAN_NODE, h, cwd]).catch(() => null);
        if (res && res.stdout) {
          this.tools = JSON.parse(res.stdout);
          this.error = null;
        } else {
          this.tools = [];
        }
      } catch (e) {
        this.error = String(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  async selectItem(item, cx) {
    if (this.selected?.id === item.id && this.selected?.kind === item.kind) {
      this.selected = null;
      this.previewContent = null;
    } else {
      this.selected = item;
      this.previewContent = null;
      if (item.path) {
        const text = await readTextFile(item.path).catch(() => null);
        this.previewContent = text || "(无法读取文件内容)";
      }
    }
    cx.notify();
  }

  mention(item, cx) {
    const target = item.path || item.dir || item.name;
    const f = focused();
    const term = f?.terminal || panes().find((p) => p.tab === f?.tab && p.terminal)?.terminal;
    if (term) {
      const q = target.replace(/\\/g, "/");
      exec("hc", ["send", term, `@${q} `]).catch(() => null);
      notify({ title: "已在终端中引用", body: item.name, level: "success" });
    } else {
      cx.write_to_clipboard(`@${target} `);
      notify({ title: "已复制到剪贴板", body: `@${target}`, level: "info" });
    }
  }

  reveal(item) {
    const target = item.dir || item.path;
    if (!target) return;
    const winTarget = target.replace(/\//g, "\\");
    exec("explorer", [`/select,${winTarget}`]).catch(() => {
      exec("explorer", [winTarget]).catch(() => null);
    });
  }

  visible() {
    const q = this.filter.trim().toLowerCase();
    return this.tools.filter((t) => {
      if (this.category === "skill" && t.kind !== "skill") return false;
      if (this.category === "plugin" && t.kind !== "plugin" && t.kind !== "mcp") return false;
      if (this.category === "project" && t.scope !== "project") return false;
      if (this.category === "global" && t.scope !== "global" && t.scope !== "builtin") return false;
      if (!q) return true;
      return `${t.name} ${t.id} ${t.description} ${t.kind} ${t.scope}`.toLowerCase().includes(q);
    });
  }

  scopeBadge(scope, t) {
    const label = scope === "project" ? "项目" : scope === "builtin" ? "内置" : "全局";
    const bg = scope === "project" ? t.accent : t.raised;
    const fg = scope === "project" ? t.solid_foreground || t.background : t.muted;
    return div().px(4).py(1).rounded(3).bg(bg).text_size(9.5).font_medium().text_color(fg).child(label);
  }

  kindIcon(kind, t) {
    const iconName = kind === "skill" ? "sparkles" : "plug-zap";
    const color = kind === "skill" ? t.accent : t.ansi4 || t.foreground;
    return svg(`${MOD}/icons/${iconName}.svg`).size(14).flex_none().text_color(color);
  }

  filterChip(key, label, t, cx) {
    const on = this.category === key;
    return h_flex().id(`cat-${key}`).h(22).px(8).flex_none().items_center().justify_center().rounded(4).cursor_pointer()
      .bg(on ? t.selected : t.raised)
      .text_size(11).font_medium()
      .text_color(on ? t.accent : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.category = key;
        cx.notify();
      })
      .child(label);
  }

  row(item, i, t, cx) {
    const isSelected = this.selected?.id === item.id && this.selected?.kind === item.kind;
    return v_flex().id(`tool-item-${i}`).flex_none().w_full().min_w(0).rounded(6).gap(4).px(8).py(7)
      .bg(isSelected ? t.selected : t.background)
      .border(1).border_color(isSelected ? t.accent : t.border)
      .cursor_pointer()
      .hover((s) => s.bg(isSelected ? t.selected : t.hover))
      .on_click((_e, cx) => this.selectItem(item, cx))
      .child(h_flex().w_full().min_w(0).gap(8).items_center()
        .child(this.kindIcon(item.kind, t))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(item.name))
        .child(this.scopeBadge(item.scope, t))
        .child(h_flex().gap(4).flex_none().items_center()
          .child(div().id(`btn-mention-${i}`).size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.accent))
            .on_click((_e, cx) => { cx.stop_propagation(); this.mention(item, cx); })
            .child(svg(`${MOD}/icons/at-sign.svg`).size(12).text_color(t.muted)))
          .child(div().id(`btn-open-${i}`).size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.accent))
            .on_click((_e, cx) => { cx.stop_propagation(); this.reveal(item); })
            .child(svg(`${MOD}/icons/folder-open.svg`).size(12).text_color(t.muted)))))
      .when(Boolean(item.description), (el) => el.child(div().w_full().min_w(0).truncate().text_size(11).text_color(t.dim).child(item.description)));
  }

  previewDrawer(t, cx) {
    if (!this.selected) return null;
    const item = this.selected;
    return v_flex().id("tools-preview").flex_1().min_h(120).p(8).gap(6).border_t(1).border_color(t.border).bg(t.raised).overflow_y_scrollbar()
      .child(h_flex().w_full().min_w(0).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(item.name))
        .child(h_flex().gap(4).flex_none()
          .child(div().id("preview-mention").h(22).px(6).rounded(4).bg(t.background).border(1).border_color(t.border).cursor_pointer()
            .flex().items_center().gap(3).text_size(11).text_color(t.accent)
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.mention(item, cx))
            .child(svg(`${MOD}/icons/at-sign.svg`).size(11).text_color(t.accent))
            .child("引用"))
          .child(div().id("preview-reveal").h(22).px(6).rounded(4).bg(t.background).border(1).border_color(t.border).cursor_pointer()
            .flex().items_center().gap(3).text_size(11).text_color(t.foreground)
            .hover((s) => s.bg(t.hover))
            .on_click(() => this.reveal(item))
            .child(svg(`${MOD}/icons/external-link.svg`).size(11).text_color(t.muted))
            .child("目录"))
          .child(div().id("preview-close").size(22).rounded(4).cursor_pointer()
            .flex().items_center().justify_center().text_size(12).text_color(t.muted)
            .hover((s) => s.text_color(t.ansi1))
            .on_click((_e, cx) => { this.selected = null; cx.notify(); })
            .child(svg(`${MOD}/icons/x.svg`).size(12).text_color(t.muted)))))
      .child(div().text_size(11).text_color(t.dim).truncate().child(item.path || item.dir || ""))
      .child(div().flex_1().p(6).rounded(4).bg(t.background).border(1).border_color(t.border).overflow_y_scrollbar()
        .text_size(11.5).text_color(t.foreground)
        .child(this.previewContent || "(正在载入文档内容…)"));
  }

  render() {
    const t = theme();
    const list = this.visible();
    const skillCount = this.tools.filter((x) => x.kind === "skill").length;
    const pluginCount = this.tools.filter((x) => x.kind === "plugin" || x.kind === "mcp").length;

    return v_flex().id("t3-tools").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().id("t3-tools-toolbar").h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Tools"))
        .child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(`${this.tools.length}`))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(`Skills ${skillCount} · MCP/Plugins ${pluginCount}`)))
      .child(h_flex().h(32).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg(`${MOD}/icons/search.svg`).size(13).flex_none().text_color(t.muted))
        .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().h(30).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(this.filterChip("all", "全部", t))
        .child(this.filterChip("skill", "Skills", t))
        .child(this.filterChip("plugin", "MCP/Plugins", t))
        .child(this.filterChip("project", "项目", t))
        .child(this.filterChip("global", "全局", t)))
      .child(v_flex().id("tools-list").flex_1().min_h(0).p(6).gap(4).overflow_y_scrollbar()
        .children(list.map((it, i) => this.row(it, i, t))))
      .when(!list.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim)
        .child(this.error || (this.loading ? "正在扫描工具与技能…" : "未找到匹配的工具或技能"))))
      .when(Boolean(this.selected), (el) => el.child(this.previewDrawer(t)));
  }
}
