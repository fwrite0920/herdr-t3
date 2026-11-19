import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, terminals, agents, run, exec, shared, setShared, home, appHome, settings, notify, theme, layout, window } from "herdr";

const TAGS = "t3.sessions.tags";
const MOD = "mods/t3-sessions";

const PI = "pi", CC = "cc", AGY = "agy", CDX = "codex", OMP = "omp";
const AGENTS = {
  [PI]: { name: "Inflection Pi", label: "Pi", icon: "mods/t3-sessions/icons/zap.svg", argv: (id, file) => ["pi", "--session", id || file] },
  [CC]: { name: "Claude Code", label: "Claude", icon: "mods/t3-sessions/icons/sparkles.svg", argv: (id, file) => ["claude", "--resume", id || file] },
  [AGY]: { name: "Google Antigravity", label: "Antigravity", icon: "mods/t3-sessions/icons/sparkles.svg", argv: (id, file) => file || id ? ["agy", "--conversation", file || id] : ["agy"] },
  [CDX]: { name: "OpenAI Codex", label: "Codex", icon: "mods/t3-sessions/icons/terminal.svg", argv: (id, file) => ["codex", "resume", id || file] },
  [OMP]: { name: "Oh-My-Prompt", label: "OMP", icon: "mods/t3-sessions/icons/terminal.svg", argv: (id, file) => ["omp", "--session", id || file] },
};

function paletteOf(t) {
  return {
    red: t.ansi1 || "#c4746e",
    green: t.ansi2 || t.working || t.accent || "#8a9a7b",
    gold: t.ansi3 || t.blocked || "#c4b28a",
    blue: t.ansi4 || t.accent || "#8ba4b0",
    purple: t.ansi5 || t.accent || "#a292a3",
    cyan: t.ansi6 || t.accent || "#8ea4a2",
  };
}

function agentColorOf(agentKey, t) {
  const p = paletteOf(t);
  const k = String(agentKey || "").toLowerCase();
  if (k === "agy" || k === "antigravity") return p.blue;
  if (k === "codex") return p.green;
  if (k === "omp") return p.cyan;
  if (k === "pi") return p.purple;
  if (k === "cc" || k === "claude") return p.gold;
  return t.accent || p.blue;
}

function groupSessions(list) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOf7Days = startOfToday - 6 * 86400000;

  const groups = [
    { id: "today", label: "今天", items: [] },
    { id: "yesterday", label: "昨天", items: [] },
    { id: "week", label: "近 7 天", items: [] },
    { id: "earlier", label: "更早", items: [] }
  ];

  for (const s of list) {
    const t = s.mtime || 0;
    if (t >= startOfToday) {
      groups[0].items.push(s);
    } else if (t >= startOfYesterday) {
      groups[1].items.push(s);
    } else if (t >= startOf7Days) {
      groups[2].items.push(s);
    } else {
      groups[3].items.push(s);
    }
  }

  return groups.filter((g) => g.items.length > 0);
}

function isSessionsActive() {
  if (typeof window === "function" && window()?.active === false) return false;
  const root = typeof layout === "function" ? layout() : null;
  if (!root) return true;
  const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((hit, c) => hit ?? find(c, id), null));
  const panel = find(root, "panel");
  if (panel && panel.hidden) return false;
  const body = find(root, "panel-body");
  if (body && body.active && body.active !== "sessions") return false;
  return true;
}

function isTelemetryDifferent(prev, next) {
  if (!prev) return true;
  return (
    prev.sessionId !== next.sessionId ||
    prev.cwd !== next.cwd ||
    prev.inTok !== next.inTok ||
    prev.outTok !== next.outTok ||
    prev.cacheTok !== next.cacheTok ||
    prev.totalCtx !== next.totalCtx ||
    prev.hitRate !== next.hitRate ||
    prev.sessionCost !== next.sessionCost ||
    prev.turnCost !== next.turnCost ||
    prev.stepCount !== next.stepCount ||
    prev.turn !== next.turn ||
    prev.sessionTitle !== next.sessionTitle ||
    prev.gitBranch !== next.gitBranch ||
    prev.gitClean !== next.gitClean ||
    prev.gitChanges !== next.gitChanges ||
    prev.usedToolsCount !== next.usedToolsCount ||
    prev.toolsOk !== next.toolsOk ||
    prev.toolsErr !== next.toolsErr ||
    prev.recentTools?.length !== next.recentTools?.length ||
    prev.recentTools?.[0]?.name !== next.recentTools?.[0]?.name ||
    prev.recentTools?.[0]?.status !== next.recentTools?.[0]?.status ||
    prev.recentTools?.[0]?.ms !== next.recentTools?.[0]?.ms ||
    prev.recentTools?.[0]?.detail !== next.recentTools?.[0]?.detail ||
    prev.breakdown?.msgPct !== next.breakdown?.msgPct ||
    prev.model !== next.model ||
    prev.provider !== next.provider ||
    prev.effort !== next.effort ||
    prev.agent !== next.agent
  );
}

const norm = (p) => (p ? p.replace(/\\/g, "/").replace(/\/+$/, "") : "");

function pathMatches(a, b) {
  if (!a || !b) return false;
  const na = String(a).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const nb = String(b).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (na === nb) return true;
  if (na.startsWith(nb + "/") || nb.startsWith(na + "/")) return true;
  return false;
}

function isKnownAgentKey(k) {
  return /^(antigravity|agy|codex|omp|pi|claude|cc)$/i.test(String(k || ""));
}

function resolveActiveTarget() {
  const sp = spaces().find((s) => s.active);
  const activeTab = sp?.tabs?.find((c) => c.active) || sp?.tabs?.[0] || null;
  const allPanes = typeof panes === "function" ? panes() : [];
  const allAgents = typeof agents === "function" ? agents() : [];
  const allTerms = typeof terminals === "function" ? terminals() : [];
  const f = typeof focused === "function" ? focused() : null;

  const tabPanes = allPanes.filter((p) => p.tab === activeTab?.id);
  const activePane = tabPanes.find((p) => p.pane === f?.pane)
    || tabPanes.find((p) => p.focused)
    || tabPanes.find((p) => p.mod === "mods/chat" || p.terminal)
    || tabPanes[0]
    || null;

  const paneItem = /** @type {any} */ (activePane)?.item;
  if (activePane?.mod === "mods/chat" && paneItem) {
    return {
      termAddr: "chat:" + paneItem,
      appHint: "chat",
      cwd: norm(activePane.cwd || sp?.folder || ""),
      curAgent: null,
      curTerm: null,
      tabTerm: null,
      activePane,
      chatTab: activePane.tab,
      space: sp
    };
  }

  const activeTabTerms = /** @type {any} */ (activeTab)?.terminals;
  let termAddr = activePane?.terminal
    || (activeTabTerms?.some((x) => x.terminal === f?.terminal) ? f.terminal : null)
    || activeTabTerms?.[0]?.terminal
    || tabPanes.find((p) => p.terminal)?.terminal
    || null;
  let tabTerm = activeTabTerms?.find((x) => x.terminal === termAddr) || activeTabTerms?.[0] || null;
  let curAgent = termAddr ? allAgents.find((a) => a.address === termAddr) : null;
  let curTerm = termAddr ? allTerms.find((k) => k.address === termAddr) : null;
  let appHint = curAgent?.program?.key || activePane?.program?.key || curTerm?.program?.key || tabTerm?.app || "";

  // If the current tab is a plain shell (no agent running in it), inspect an agent terminal in the same space if one exists
  if (!isKnownAgentKey(appHint) && !curAgent && sp?.tabs) {
    const spaceTabIds = new Set(sp.tabs.map((tb) => tb.id));
    for (const p of allPanes) {
      if (!spaceTabIds.has(p.tab) || !p.terminal) continue;
      const candAgent = allAgents.find((a) => a.address === p.terminal);
      const candTerm = allTerms.find((k) => k.address === p.terminal);
      const candApp = candAgent?.program?.key || p.program?.key || candTerm?.program?.key || p.app || "";
      if (isKnownAgentKey(candApp) || candAgent) {
        termAddr = p.terminal;
        tabTerm = null;
        curAgent = candAgent || null;
        curTerm = candTerm || null;
        appHint = candApp || "agent";
        break;
      }
    }
  }

  if (!isKnownAgentKey(appHint) && !curAgent) {
    appHint = "shell";
  }

  const cwd = norm(curTerm?.cwd || activePane?.cwd || sp?.folder || "");
  return {
    termAddr: termAddr || "",
    appHint,
    cwd,
    curAgent,
    curTerm,
    tabTerm,
    activePane,
    chatTab: null,
    space: sp
  };
}

function currentPlace() {
  const target = resolveActiveTarget();
  return { cwd: target.cwd, on: target.space?.machine ?? null, space: target.space };
}

function when(millis) {
  const s = Math.max(0, Date.now() - millis) / 1000;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}

function formatTok(n) {
  if (!n || n < 0 || isNaN(n)) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function maskSecrets(s) {
  return String(s ?? "")
    .replace(/\b(sk-[a-zA-Z0-9_-]{8,}|ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|AIza[0-9A-Za-z_-]{16,})\b/g, (m) => m.slice(0, 6) + "…***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer ***");
}

export default class Sessions extends View {
  init(_props, cx) {
    this.viewMode = shared("t3.sessions.mode") || "inspector"; // "inspector" | "history"
    this.toolsOpen = false;
    this.activityOpen = false;
    this.toolCategory = "all"; // "all" | "builtin" | "ext"
    this.toolFilter = "";
    this.toolInput = InputState.new({ placeholder: "搜索工具与技能名称..." });
    this.toolInput.on("change", (_e, cx) => {
      this.toolFilter = this.toolInput.value().toLowerCase().trim();
      cx.notify();
    });

    // Per-terminal timer map: { [termAddr]: { state, turn, startedAt } }
    this.termTimers = new Map();

    // Cache telemetry per terminal so switching displays immediately
    this.telemetryByTerm = new Map();
    this.lastTermAddr = null;

    this.telemetry = {
      agent: "",
      agentName: "Terminal",
      agentColor: "",
      model: "—",
      sessionTitle: "Terminal Session",
      sessionId: "—",
      effort: "",
      inTok: 0,
      outTok: 0,
      cacheTok: 0,
      totalCtx: 0,
      maxCtx: "1M",
      hitRate: 0,
      cost: "—",
      ttft: "—",
      tokPerSec: "—",
      avgTtft: "—",
      avgTokPerSec: "—",
      recentTools: [],
      toolsOk: 0,
      usedToolsCount: 0,
      usedToolNames: [],
      builtinTools: 0,
      extTools: 0,
      totalTools: 0,
      builtinNames: [],
      extNames: [],
      stepCount: 0,
      storage: "saved",
      cwd: "",
      gitBranch: "no repo",
      gitClean: true,
      gitChanges: "—",
      machine: "local",
      breakdown: { sys: 0, sysPct: 0, tools: 0, toolsPct: 0, msg: 0, msgPct: 0, res: 0, resPct: 0 }
    };

    this.sessions = [];
    this.error = null;
    this.loading = false;
    this.showAll = true;
    this.historyAgentFilter = "all";
    this.tagOnly = null;
    this.filter = "";
    this.tagging = null;
    this.input = InputState.new({ placeholder: "搜索标题/路径， #标签 过滤" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      cx.notify();
    });
    // Create tagInput once in init (never inside render()) and bind Enter to save.
    this.tagInput = InputState.new({ placeholder: "标签用空格隔开，回车保存" });
    this.tagInput.on("submit", (_e, cx) => this.commitTag(cx));

    if (this.viewMode === "history") this.refreshHistory(cx);
    else this.pollTelemetry(cx);

    this.watch = null;
    // Combined 1-second timer: detects target switches and ticks elapsed clock only while an agent is working.
    this.tickTimer = cx.timer.every(1000, (cx) => {
      if (!isSessionsActive()) return;
      const target = resolveActiveTarget();
      const cur = `${target.termAddr}:${target.appHint}:${target.cwd}`;
      if (cur !== this.watch) {
        this.watch = cur;
        if (this.viewMode === "inspector") this.pollTelemetry(cx);
        else this.refreshHistory(cx);
        cx.notify();
        return;
      }
      if (this.viewMode === "inspector" && this.lastWorking) cx.notify();
    });

    // 1.5-second telemetry polling (only when active and in inspector view)
    this.telemetryTimer = cx.timer.every(1500, (cx) => {
      if (isSessionsActive() && this.viewMode === "inspector") {
        this.pollTelemetry(cx);
      }
    });

    // 8-second real-time history refresh (only when active and in history view)
    this.historyTimer = cx.timer.every(8000, (cx) => {
      if (isSessionsActive() && this.viewMode === "history") {
        this.refreshHistory(cx);
      }
    });
  }

  async close() {
    this.tickTimer?.cancel();
    this.telemetryTimer?.cancel();
    this.historyTimer?.cancel();
  }

  pollTelemetry(cx) {
    if (this.telemetryPolling) return;
    this.telemetryPolling = true;
    cx.spawn(async (cx) => {
      try {
        const h = norm(home());
        const modDir = norm(typeof appHome === "function" ? appHome() : `${h}/.config/herdr-app`) + "/mods/t3-sessions";
        const target = resolveActiveTarget();
        const termAddr = target.termAddr;
        const cwd = target.cwd;
        const appHint = target.appHint || "";
        if (!termAddr) return;

        const res = await exec("node", [`${modDir}/scan-telemetry.cjs`, h, cwd || "", termAddr, appHint]).catch(() => null);
        if (res && res.stdout) {
          try {
            const t = JSON.parse(res.stdout);
            if (t) {
              const prev = this.telemetryByTerm.get(termAddr);
              const changed = isTelemetryDifferent(prev, t);
              this.telemetryByTerm.set(termAddr, t);
              if (changed) {
                this.telemetry = { ...this.telemetry, ...t };
                cx.notify();
              }
            }
          } catch {}
        }
      } catch {} finally {
        this.telemetryPolling = false;
      }
    });
  }

  refreshHistory(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const h = norm(home());
        const modDir = norm(typeof appHome === "function" ? appHome() : `${h}/.config/herdr-app`) + "/mods/t3-sessions";
        const res = await exec("node", [`${modDir}/scan-history.cjs`, h]).catch(() => null);
        if (res && res.stdout) {
          const combined = JSON.parse(res.stdout);
          this.sessions = combined.filter((s) => s.title || s.cwd || s.id).sort((a, b) => b.mtime - a.mtime).slice(0, 300);
          this.error = null;
        } else if (!this.sessions.length) {
          this.error = "Unable to scan session history";
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
      if (!this.showAll && root && (!s.cwd || !pathMatches(root, s.cwd))) return false;
      if (this.historyAgentFilter !== "all" && s.agent !== this.historyAgentFilter) return false;
      const own = this.tagsOf(s).map((x) => String(x).toLowerCase());
      if (this.tagOnly && !own.includes(String(this.tagOnly).toLowerCase())) return false;
      if (wanted.some((tag) => !own.some((x) => x.includes(tag)))) return false;
      if (!q) return true;
      return `${s.title} ${own.join(" ")} ${s.cwd}`.toLowerCase().includes(q);
    });
  }

  resume(session) {
    if (!session) return;
    const agent = AGENTS[session.agent];
    if (!agent) return;
    let argv = [];
    let folder = session.cwd || home();
    if (session.agent === "codex" && String(session.id).startsWith("wsl/")) {
      const um = String(session.file || session.id).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      const cleanId = um ? um[1] : String(session.id).replace(/^wsl\//, "");
      const activeMachine = (typeof spaces === "function" ? spaces().find((s) => s.active)?.machine : null) || null;
      if (activeMachine === "wsl") {
        argv = ["codex", "resume", cleanId];
        folder = session.cwd || undefined;
      } else {
        argv = ["wsl", ...(session.wslDistro ? ["-d", session.wslDistro] : []), ...(session.cwd ? ["--cd", session.cwd] : []), "codex", "resume", cleanId];
        folder = undefined;
      }
    } else if (typeof agent.argv === "function") {
      argv = agent.argv(session.id, session.file);
    }
    if (!argv || !argv.length) return;
    try {
      run("terminal.open", {
        argv,
        place: "tab",
        ...(folder ? { folder } : {})
      });
    } catch (e) {
      console.error("Failed to resume session:", e);
    }
  }

  startTag(session, cx) {
    this.tagging = this.keyOf(session);
    this.tagInput.set_value(this.tagsOf(session).join(" "));
    this.tagInput.focus();
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

  tagChip(session, tag, j, rowKey, t) {
    return h_flex().id(`tag-${rowKey}-${j}`).h(18).px(5).gap(3).flex_none().items_center().rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted)
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

  categoryTab(id, label, iconPath, count, color, t) {
    const active = this.historyAgentFilter === id;
    return h_flex().h(24).px(8).gap(5).items_center().rounded(5).cursor_pointer()
      .when(active, (el) => el.bg(t.raised).border_1().border_color(t.border).text_color(t.foreground))
      .when(!active, (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground).bg(t.hover)))
      .on_click((_e, cx) => {
        this.historyAgentFilter = id;
        cx.notify();
      })
      .when(Boolean(iconPath), (el) => el.child(svg(iconPath).size(11).text_color(color || t.foreground).flex_none()))
      .child(div().text_size(11).font_medium().child(label))
      .when(count > 0, (el) => el.child(
        div().px(4).py(0.5).rounded(3).text_size(9.5).font_medium()
          .when(active, (s) => s.bg(t.background).text_color(color || t.accent))
          .when(!active, (s) => s.bg(t.raised).text_color(t.dim))
          .child(String(count))
      ));
  }

  historySectionHeader(label, count, t) {
    return h_flex().w_full().items_center().gap(6).pt(6).pb(2).px(4)
      .child(svg("mods/t3-sessions/icons/clock.svg").size(11).text_color(t.dim).flex_none())
      .child(div().text_size(11).font_bold().text_color(t.muted).child(label))
      .child(div().px(4).py(0.5).rounded(3).bg(t.raised).text_size(9.5).text_color(t.dim).child(String(count)))
      .child(div().flex_1().h(1).bg(t.border));
  }

  row(session, rowKey, t, short, root) {
    const tags = this.tagsOf(session);
    const baseAgent = AGENTS[session.agent] || { label: session.agent, icon: "mods/t3-sessions/icons/sparkles.svg" };
    const agent = { ...baseAgent, color: agentColorOf(session.agent, t) };
    const tagging = this.tagging === this.keyOf(session);
    const away = session.cwd && root && !pathMatches(root, session.cwd);
    const isWsl = String(session.id).startsWith("wsl/") || String(session.cwd).startsWith("/home");
    const cardHover = t.foreground + "12";

    return div().id(`session-${rowKey}`).flex().flex_col().flex_none().w_full().min_w(0).gap(5).p(8).rounded(6)
      .bg(t.raised)
      .border_1()
      .border_color(tagging ? t.accent : t.border)
      .when(!tagging, (el) => el.cursor_pointer()
        .hover((s) => s.bg(cardHover).border_color(t.border))
        .on_click(() => this.resume(session)))
      // Row 1: Agent Pill + Title + Quick Action "恢复"
      .child(h_flex().w_full().min_w(0).gap(6).items_center()
        // Agent badge
        .child(h_flex().h(18).px(5).gap(3).flex_none().items_center().rounded(4).bg(t.background).border_1().border_color(t.border)
          .child(svg(agent.icon || "mods/t3-sessions/icons/sparkles.svg").size(10).text_color(agent.color).flex_none())
          .child(div().text_size(9.5).font_medium().text_color(agent.color).child(agent.label)))
        // Title
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(t.foreground)
          .child(session.title || "(无标题会话)"))
        // Quick Resume Button
        .when(!tagging, (el) => el.child(
          h_flex().id(`btn-resume-${rowKey}`).h(18).px(6).gap(3).flex_none().items_center().rounded(4)
            .bg(t.background).border_1().border_color(t.border)
            .hover((s) => s.bg(cardHover).border_color(t.accent))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.resume(session);
            })
            .child(svg("mods/t3-sessions/icons/terminal.svg").size(10).text_color(agent.color).flex_none())
            .child(div().text_size(10).font_medium().text_color(t.foreground).child("恢复 ↗"))
        )))
      // Row 2: Metadata (Time · Folder · WSL · Add Tag)
      .child(h_flex().w_full().min_w(0).gap(5).items_center().text_size(11).text_color(t.dim)
        .child(svg("mods/t3-sessions/icons/clock.svg").size(10.5).text_color(t.dim).flex_none())
        .child(div().flex_none().child(when(session.mtime)))
        .child(div().flex_none().child("·"))
        .child(svg("mods/t3-sessions/icons/folder.svg").size(10.5).text_color(t.dim).flex_none())
        .child(div().flex_1().min_w(0).truncate()
          .when(Boolean(away), (el) => el.text_color(t.dim))
          .when(!away, (el) => el.text_color(t.muted))
          .child(short(session.cwd) || "全局 / 未记录目录"))
        .when(isWsl, (el) => el.child(
          div().px(4).py(0.5).rounded(4).bg(t.background).border_1().border_color(t.border).text_size(9).font_medium().text_color(t.dim).child("WSL")
        ))
        .when(!tagging, (el) => el.child(
          h_flex().id(`tag-add-${rowKey}`).h(18).px(4).gap(2).flex_none().items_center().rounded(4)
            .hover((s) => s.bg(cardHover).text_color(t.accent))
            .on_click((_e, cx) => { cx.stop_propagation(); this.startTag(session, cx); })
            .child(svg("mods/t3-sessions/icons/tag.svg").size(9).text_color(t.dim).flex_none())
            .child(div().text_size(9.5).child("+标签"))
        )))
      // Row 3: Tag editor (when tagging is active)
      .when(tagging, (el) => el.child(
        h_flex().w_full().min_w(0).gap(4).items_center().pt(2)
          .child(Input.new(this.tagInput).flex_1().min_w(0).h(24).text_size(11).text_color(t.foreground))
          .child(div().id("tag-save").h(24).px(8).flex_none().flex().items_center().rounded(4).bg(t.background).border_1().border_color(t.border).cursor_pointer().text_size(11).text_color(t.accent)
            .hover((s) => s.bg(cardHover)).on_click((_e, cx) => { cx.stop_propagation(); this.commitTag(cx); }).child("保存"))
          .child(div().id("tag-cancel").h(24).px(6).flex_none().flex().items_center().rounded(4).cursor_pointer().text_size(11).text_color(t.dim)
            .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); this.tagging = null; cx.notify(); }).child("取消"))
      ))
      // Row 4: Tag chips (when tags exist and not tagging)
      .when(!tagging && tags.length > 0, (el) => el.child(
        h_flex().w_full().min_w(0).gap(4).items_center().overflow_hidden().pt(1)
          .children(tags.slice(0, 6).map((tag, j) => this.tagChip(session, tag, j, rowKey, t)))
          .when(tags.length > 6, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`+${tags.length - 6}`)))
      ));
  }

  sectionHead(title, color, iconPath, t) {
    return h_flex().flex_1().min_w(0).items_center().gap(6).mb(2)
      .when(Boolean(iconPath), (el) => el.child(svg(iconPath).size(12).text_color(color).flex_none()))
      .child(div().flex_none().font_bold().text_size(11).text_color(color).child(title))
      .child(div().flex_1().h(1).bg(t.border));
  }

  renderInspector(t, short, root) {
    const target = resolveActiveTarget();
    const curTermAddr = target.termAddr;
    if (this.lastTermAddr !== curTermAddr) {
      this.lastTermAddr = curTermAddr;
    }

    const curAgent = target.curAgent;
    const curTerm = target.curTerm;
    const tabTerm = target.tabTerm;
    const activePane = target.activePane;

    // Priority telemetry: active terminal cache or general fallback
    const tel = this.telemetryByTerm.get(curTermAddr) || this.telemetry;

    // Live agent status & turn from Herdr (never confuse terminal process 'live' with agent 'working')
    const aAny = /** @type {any} */ (curAgent);
    const kAny = /** @type {any} */ (curTerm);
    const chatSt = target.chatTab ? shared("mods/chat.status")?.[target.chatTab] : null;
    const rawState = chatSt
      || curAgent?.status
      || tabTerm?.status
      || (typeof kAny?.status === "string" ? kAny.status : kAny?.status?.state)
      || "idle";
    const normSt = String(rawState).toLowerCase();
    const state = normSt === "working" ? "WORKING" : (normSt === "blocked" || normSt === "error") ? "BLOCKED" : "IDLE";
    const isWorking = state === "WORKING";
    const isBlocked = state === "BLOCKED";
    this.lastWorking = isWorking;
    const mono = settings()?.font_family ?? "JetBrains Mono";
    const turn = Math.max(kAny?.turn ?? 0, aAny?.turn ?? 0, tel.turn ?? 0) || 1;

    // Session Title
    let taskName = tel.sessionTitle;
    if (!taskName || /pwsh|powershell|cmd|bash|zsh|^[a-z0-9_-]+@[a-z0-9_-]+:/i.test(taskName)) {
      taskName = kAny?.status?.msg || curAgent?.title || curAgent?.tab_name || tel.sessionTitle || "Terminal Session";
    }
    if (/pwsh|powershell|cmd|bash|zsh|^[a-z0-9_-]+@[a-z0-9_-]+:/i.test(taskName)) {
      taskName = (tel.cwd || target.cwd || "").split("/").pop() || "Terminal Session";
    }

    // Actual project directory
    const activeCwd = tel.cwd || target.cwd || kAny?.foreground?.cwd || activePane?.cwd || aAny?.cwd || root;

    // Independent timer per terminal (switching does NOT reset to 0)
    let tInfo = this.termTimers.get(curTermAddr);
    const statusMs = kAny?.status_ms || aAny?.status_ms;
    const createdMs = kAny?.created_ms;

    if (!tInfo) {
      const toolStartMs = tel.recentTools?.[0]?.start ? new Date(tel.recentTools[0].start).getTime() : 0;
      const validStart = (toolStartMs && (Date.now() - toolStartMs < 1800000)) ? toolStartMs : (statusMs && (Date.now() - statusMs < 1800000) ? statusMs : Date.now());
      tInfo = {
        state,
        turn,
        startedAt: validStart
      };
      this.termTimers.set(curTermAddr, tInfo);
    } else {
      if (tInfo.state !== state || (tInfo.turn !== turn && state === "WORKING")) {
        tInfo.state = state;
        tInfo.turn = turn;
        tInfo.startedAt = statusMs && (Date.now() - statusMs < 1800000) ? statusMs : Date.now();
      }
    }
    const elapsedSec = Math.max(0, Math.floor((Date.now() - tInfo.startedAt) / 1000));
    const mm = Math.floor(elapsedSec / 60);
    const ss = String(elapsedSec % 60).padStart(2, "0");
    const elapsedStr = `${mm}:${ss}`;

    // Token usage calculations
    const inTok = tel.inTok || 0;
    const cacheTok = tel.cacheTok || 0;
    const outTok = tel.outTok || 0;
    const totalTok = tel.totalCtx || (inTok + cacheTok);
    const maxCtxStr = String(tel.maxCtx || "1M").trim();
    const maxCtxNum = /m$/i.test(maxCtxStr) ? (parseFloat(maxCtxStr) || 1) * 1000000
      : /k$/i.test(maxCtxStr) ? (parseFloat(maxCtxStr) || 200) * 1000
      : (parseFloat(maxCtxStr) || 1000000);
    const pct = totalTok > 0 ? Math.min(100, Math.max(0.1, (totalTok / maxCtxNum) * 100)) : 0;

    // Token Breakdown from Telemetry (no artificial caps)
    const b = tel.breakdown || { sys: 0, sysPct: 0, tools: 0, toolsPct: 0, msg: 0, msgPct: 0, res: 0, resPct: 0 };

    const remainingTools = Math.max(0, (tel.toolsOk || 0) - (tel.recentTools?.length || 0));

    // Filter tools for tools catalog
    const usedSet = new Set(tel.usedToolNames || []);
    const builtins = (tel.builtinNames || []).map((name) => ({ name, type: "builtin" }));
    const exts = (tel.extNames || []).map((name) => ({ name, type: "ext" }));
    let displayedTools = [];
    if (this.toolCategory === "all") displayedTools = [...builtins, ...exts];
    else if (this.toolCategory === "builtin") displayedTools = builtins;
    else if (this.toolCategory === "ext") displayedTools = exts;
    else if (this.toolCategory === "used") displayedTools = [...builtins, ...exts].filter((x) => usedSet.has(x.name));
    else displayedTools = [...builtins, ...exts];

    if (this.toolFilter) {
      displayedTools = displayedTools.filter((x) => x.name.toLowerCase().includes(this.toolFilter));
    }

    const pal = paletteOf(t);
    const agColor = agentColorOf(tel.agent || curAgent?.agent, t);
    const stateColor = isBlocked ? pal.red : isWorking ? pal.gold : pal.green;

    return v_flex().id("sessions-inspector").flex_1().min_h(0).p(10).gap(10).overflow_y_scrollbar()
      // 1. HERO CARD: Agent & Session Identity with Vector Icons
      .child(v_flex().w_full().p(10).gap(8).rounded(8).bg(t.raised).border(1).border_color(t.border)
        .child(h_flex().w_full().justify_between().items_center()
          .child(h_flex().gap(6).items_center()
            .child(h_flex().items_center().gap(5).px(7).py(2).rounded(4).bg(t.background).border(1).border_color(t.border)
              .child(svg("mods/t3-sessions/icons/sparkles.svg").size(11).text_color(agColor).flex_none())
              .child(div().text_size(11).font_bold().text_color(agColor).child(tel.agentName || "Agent")))
            .child(div().text_size(11).font_medium().text_color(t.dim).child(tel.model || "—")))
          .child(h_flex().gap(6).items_center()
            .child(div().size(7).rounded_full().bg(stateColor))
            .child(div().text_size(11).font_bold().text_color(stateColor).child(state))
            .child(h_flex().gap(3).items_center()
              .child(svg("mods/t3-sessions/icons/clock.svg").size(11).text_color(t.muted).flex_none())
              .child(div().text_size(11).font_family(mono).text_color(t.muted).child(elapsedStr)))))
        .child(div().w_full().text_size(13).font_bold().text_color(t.foreground).truncate().child(taskName))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(h_flex().gap(6).items_center()
            .child(div().px(5).py(1).rounded(4).bg(t.background).text_color(t.muted).child(`Turn ${turn}`))
            .when(Boolean(tel.effort), (eEl) => eEl.child(div().text_color(t.dim).child(`effort ${tel.effort}`))))
          .child(h_flex().gap(6).items_center()
            .child(div().font_family(mono).text_color(t.dim).child(`# ${tel.sessionId || "—"}`))
            .child(div().font_bold().text_color(stateColor).child(isWorking ? "in-memory" : "saved")))))

      // 2. WORKSPACE & GIT ENVIRONMENT (Always expanded)
      .child(v_flex().w_full().p(8).gap(6).rounded(6).bg(t.raised).border(1).border_color(t.border)
        .child(this.sectionHead("WORKSPACE & GIT", pal.purple, "mods/t3-sessions/icons/server.svg", t))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(h_flex().gap(4).items_center()
            .child(svg("mods/t3-sessions/icons/server.svg").size(11).text_color(t.muted).flex_none())
            .child(div().text_color(t.muted).child("Host")))
          .child(div().font_bold().text_color(pal.cyan).child(String(tel.machine || "LOCAL").toUpperCase())))
        .child(h_flex().w_full().justify_between().items_center().gap(8).text_size(11).font_medium()
          .child(h_flex().gap(4).items_center().flex_none()
            .child(svg("mods/t3-sessions/icons/git-branch.svg").size(11).text_color(tel.gitBranch === "no repo" ? t.dim : pal.gold).flex_none())
            .child(div().text_color(t.muted).child("Git")))
          .child(h_flex().gap(4).items_center().min_w(0).flex_1().justify_end()
            .child(div().min_w(0).truncate().font_bold().text_color(tel.gitBranch === "no repo" ? t.dim : pal.gold).child(tel.gitBranch === "no repo" ? "—" : tel.gitBranch))
            .child(div().flex_none().text_color(tel.gitChanges === "—" ? t.dim : tel.gitClean ? pal.green : pal.gold)
              .child(`(${tel.gitChanges === "—" ? "not a git repo" : tel.gitClean ? "clean" : tel.gitChanges})`))))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(h_flex().gap(4).items_center()
            .child(svg("mods/t3-sessions/icons/database.svg").size(11).text_color(t.muted).flex_none())
            .child(div().text_color(t.muted).child("CWD")))
          .child(div().flex_1().min_w(0).text_right().truncate().text_color(t.dim).child(activeCwd || root || "—")))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(div().text_color(t.muted).child("Session ID"))
          .child(div().font_family(mono).font_bold().text_color(t.foreground).child(tel.sessionId || "—")))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(div().text_color(t.muted).child("History"))
          .child(div().text_color(t.foreground).child(`${turn} turns · ${tel.stepCount || 0} steps`)))
        .when(Boolean(tel.provider || tel.approvalPolicy || tel.sandboxPolicy), (el) => el.child(
          h_flex().w_full().justify_between().items_center().gap(8).text_size(11).font_medium()
            .child(div().flex_none().text_color(t.muted).child("Runtime"))
            .child(div().min_w(0).truncate().font_family(mono).text_size(10.5).text_color(pal.cyan)
              .child([tel.provider, tel.approvalPolicy, tel.sandboxPolicy].filter(Boolean).join(" · ")))))
        .when(Array.isArray(tel.rulesLoaded) && tel.rulesLoaded.length > 0, (el) => el.child(
          h_flex().w_full().justify_between().items_center().gap(8).text_size(11).font_medium()
            .child(div().flex_none().text_color(t.muted).child("Rules"))
            .child(div().min_w(0).truncate().font_family(mono).text_size(10.5).text_color(pal.purple)
              .child(tel.rulesLoaded.join(" · "))))))

      // 3. 2x2 QUICK STATS HUD (Context & Session metrics)
      .child(v_flex().w_full().gap(6)
        .child(h_flex().w_full().gap(6)
          // Stat 1: Context Window
          .child(v_flex().flex_1().p(8).gap(3).rounded(6).bg(t.raised).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(4)
              .child(svg("mods/t3-sessions/icons/layers.svg").size(11).text_color(pal.blue).flex_none())
              .child(div().text_size(9.5).font_bold().text_color(t.muted).child("CONTEXT")))
            .child(div().text_size(13).font_bold().text_color(t.foreground).child(`${formatTok(totalTok)} / ${tel.maxCtx || "1M"}`))
            .child(h_flex().gap(4).items_center()
              .child(div().text_size(10.5).font_medium().text_color(pct >= 90 ? pal.red : pct >= 80 ? pal.gold : pal.blue).child(`${pct.toFixed(1)}%`))
              .child(div().text_size(10).text_color(t.dim).truncate().child(`· ~${tel.headroom || 30} 轮剩余`)))
            .child(h_flex().w_full().h(3).mt(2).rounded(2).overflow_hidden().bg(t.border)
              .when(pct > 0, (fEl) => fEl.child(div().h_full().bg(pct >= 90 ? pal.red : pct >= 80 ? pal.gold : pct >= 60 ? pal.blue : pal.green).flex_grow(Math.max(1, Math.min(100, pct)))))
              .when(pct < 100, (uEl) => uEl.child(div().h_full().flex_grow(Math.max(1, 100 - Math.min(100, pct)))))))
          // Stat 2: Cache Hit Rate
          .child(v_flex().flex_1().p(8).gap(3).rounded(6).bg(t.raised).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(4)
              .child(svg("mods/t3-sessions/icons/zap.svg").size(11).text_color(pal.green).flex_none())
              .child(div().text_size(9.5).font_bold().text_color(t.muted).child("CACHE HIT")))
            .child(div().text_size(13).font_bold().text_color(pal.green).child(totalTok > 0 ? `${tel.hitRate}%` : "—"))
            .child(div().text_size(10).text_color(t.dim).truncate().child(tel.cacheSaved ? `cache ${formatTok(cacheTok)} · 省 ${tel.cacheSaved}` : `cache ${formatTok(cacheTok)}`))))
        .child(h_flex().w_full().gap(6)
          // Stat 3: Est. Session Cost
          .child(v_flex().flex_1().p(8).gap(3).rounded(6).bg(t.raised).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(4)
              .child(svg("mods/t3-sessions/icons/database.svg").size(11).text_color(pal.gold).flex_none())
              .child(div().text_size(9.5).font_bold().text_color(t.muted).child("EST. COST")))
            .child(div().text_size(13).font_bold().text_color(pal.gold).child(totalTok > 0 ? (tel.sessionCost || tel.cost || "$0.00") : "—"))
            .child(div().text_size(10).text_color(t.dim).truncate().child(
              totalTok > 0
                ? ((tel.reasoningTok || 0) > 0 ? `当轮 ${tel.turnCost || '$0.000'} · reason ${formatTok(tel.reasoningTok)}` : `当轮 ${tel.turnCost || '$0.000'} · in ${formatTok(inTok)}`)
                : `in ${formatTok(inTok)} · out ${formatTok(outTok)}`)))
          // Stat 4: TTFT & Loop Density
          .child(v_flex().flex_1().p(8).gap(3).rounded(6).bg(t.raised).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(4)
              .child(svg("mods/t3-sessions/icons/clock.svg").size(11).text_color(pal.purple).flex_none())
              .child(div().text_size(9.5).font_bold().text_color(t.muted).child("LATENCY & LOOP")))
            .child(div().text_size(13).font_bold().text_color(pal.purple).child(totalTok > 0 ? (tel.ttft || "1.0s") : "—"))
            .child(div().text_size(10).text_color(t.dim).truncate().child(
              totalTok > 0
                ? `${tel.tokPerSec || "130 tok/s"} · ${tel.toolsPerTurn || "0.0"} tools/轮`
                : `${tel.toolsPerTurn || "0.0"} tools/轮`))))
        .when(pct >= 80, (el) => el.child(
          h_flex().w_full().px(8).py(5).gap(6).items_center().rounded(5).bg((pct >= 90 ? pal.red : pal.gold) + "26").border(1).border_color(pct >= 90 ? pal.red : pal.gold)
            .child(div().text_size(10.5).font_bold().text_color(pct >= 90 ? pal.red : pal.gold).child(pct >= 90 ? "上下文紧迫" : "上下文预警"))
            .child(div().flex_1().text_size(10).text_color(t.muted).truncate().child("建议执行 /compact 或开启新会话")))))

      // 4. TOKEN COMPOSITION & DYNAMIC BREAKDOWN (Always expanded)
      .child(v_flex().w_full().p(8).gap(6).rounded(6).bg(t.raised).border(1).border_color(t.border)
        .child(h_flex().w_full().justify_between().items_center()
          .child(this.sectionHead("CONTEXT BREAKDOWN", pal.blue, "mods/t3-sessions/icons/layers.svg", t))
          .child(div().text_size(10.5).font_medium().text_color(t.dim).child(`~${formatTok(totalTok)}`)))
        .child(h_flex().w_full().h(8).rounded(3).overflow_hidden().bg(t.border)
          .child(div().h_full().bg(pal.purple).flex_grow(Math.max(1, b.sysPct || 10)))
          .child(div().h_full().bg(pal.cyan).flex_grow(Math.max(1, b.toolsPct || 12)))
          .child(div().h_full().bg(pal.blue).flex_grow(Math.max(1, b.msgPct || 48)))
          .child(div().h_full().bg(pal.gold).flex_grow(Math.max(1, b.resPct || 30))))
        .child(v_flex().w_full().gap(5).pt(2).text_size(10.5).font_medium()
          .child(h_flex().w_full().gap(10)
            .child(h_flex().flex_1().justify_between().items_center()
              .child(h_flex().gap(5).items_center()
                .child(div().size(6).rounded(1).bg(pal.purple))
                .child(div().text_color(t.muted).child("System")))
              .child(div().text_color(t.dim).child(`${b.sysPct}%`)))
            .child(h_flex().flex_1().justify_between().items_center()
              .child(h_flex().gap(5).items_center()
                .child(div().size(6).rounded(1).bg(pal.cyan))
                .child(div().text_color(t.muted).child("Tools")))
              .child(div().text_color(t.dim).child(`${b.toolsPct}%`))))
          .child(h_flex().w_full().gap(10)
            .child(h_flex().flex_1().justify_between().items_center()
              .child(h_flex().gap(5).items_center()
                .child(div().size(6).rounded(1).bg(pal.blue))
                .child(div().text_color(t.muted).child("Messages")))
              .child(div().text_color(t.dim).child(`${b.msgPct}%`)))
            .child(h_flex().flex_1().justify_between().items_center()
              .child(h_flex().gap(5).items_center()
                .child(div().size(6).rounded(1).bg(pal.gold))
                .child(div().text_color(t.muted).child("Results")))
              .child(div().text_color(t.dim).child(`${b.resPct}%`))))))

      // 5. TOOLS & SKILLS CATALOG (Collapsible, default collapsed)
      .child(v_flex().w_full().p(8).gap(6).rounded(6).bg(t.raised).border(1).border_color(t.border)
        .child(h_flex().w_full().justify_between().items_center().cursor_pointer()
          .on_click((_e, cx) => { this.toolsOpen = !this.toolsOpen; cx.notify(); })
          .child(this.sectionHead("TOOLS & SKILLS", pal.purple, "mods/t3-sessions/icons/wrench.svg", t))
          .child(h_flex().gap(6).items_center().flex_none()
            .child(div().text_size(10.5).font_medium().text_color(t.muted).child(`${tel.totalTools || 52} 项 · 已用 ${usedSet.size || tel.usedToolsCount || 0}`))
            .child(div().text_size(11).font_medium().text_color(t.muted)
              .child(this.toolsOpen ? "▾ 收起" : "▸ 展开"))))
        .when(this.toolsOpen, (el) => el.child(v_flex().w_full().gap(6).pt(2)
          .child(h_flex().w_full().justify_between().items_center().text_size(10.5)
            .child(div().text_color(t.dim).child(`内置基元 ${tel.builtinTools || 13} · 扩展技能 ${tel.extTools || 39}`))
            .child(h_flex().gap(4).items_center()
              .child(div().size(5).rounded_full().bg(usedSet.size > 0 ? pal.green : t.dim))
              .child(div().font_bold().text_color(usedSet.size > 0 ? pal.green : t.dim).child(`已调用 ${usedSet.size || tel.usedToolsCount || 0} 项`))))
          // Search Box
          .child(h_flex().w_full().h(26).px(6).gap(6).items_center().rounded(4).bg(t.background).border(1).border_color(t.border)
            .child(div().text_size(10).text_color(t.dim).child("🔍"))
            .child(Input.new(this.toolInput).flex_1().h_full().text_size(11).text_color(t.foreground))
            .when(Boolean(this.toolFilter), (el2) => el2.child(
              div().text_size(10).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.ansi1))
                .on_click((_e, cx) => { this.toolInput.set_value(""); this.toolFilter = ""; cx.notify(); })
                .child("✕"))))
          // Filter Tabs (All, Builtin, Ext, Used)
          .child(h_flex().w_full().gap(4)
            .child(div().px(6).py(2).rounded(3).cursor_pointer().text_size(10.5).font_medium()
              .when(this.toolCategory === "all", (tEl) => tEl.bg(t.border).text_color(t.foreground))
              .when(this.toolCategory !== "all", (tEl) => tEl.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
              .on_click((_e, cx) => { this.toolCategory = "all"; cx.notify(); })
              .child(`全部 (${tel.totalTools || 52})`))
            .child(div().px(6).py(2).rounded(3).cursor_pointer().text_size(10.5).font_medium()
              .when(this.toolCategory === "builtin", (tEl) => tEl.bg(t.border).text_color(pal.cyan))
              .when(this.toolCategory !== "builtin", (tEl) => tEl.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
              .on_click((_e, cx) => { this.toolCategory = "builtin"; cx.notify(); })
              .child(`内置 (${tel.builtinTools || 13})`))
            .child(div().px(6).py(2).rounded(3).cursor_pointer().text_size(10.5).font_medium()
              .when(this.toolCategory === "ext", (tEl) => tEl.bg(t.border).text_color(pal.purple))
              .when(this.toolCategory !== "ext", (tEl) => tEl.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
              .on_click((_e, cx) => { this.toolCategory = "ext"; cx.notify(); })
              .child(`技能 (${tel.extTools || 39})`))
            .child(div().px(6).py(2).rounded(3).cursor_pointer().text_size(10.5).font_medium()
              .when(this.toolCategory === "used", (tEl) => tEl.bg(t.selected).text_color(pal.green))
              .when(this.toolCategory !== "used", (tEl) => tEl.text_color(usedSet.size > 0 ? pal.green : t.muted).hover((s) => s.text_color(pal.green)))
              .on_click((_e, cx) => { this.toolCategory = "used"; cx.notify(); })
              .child(`已调用 (${usedSet.size})`)))
          // 2-Column Responsive Chips Matrix: Invoked tools highlighted in theme accent
          .child(h_flex().id("tools-chips-grid").w_full().flex_wrap().gap(4).pt(2)
            .children(displayedTools.map((tool) => {
              const isUsed = usedSet.has(tool.name);
              const chipColor = isUsed ? pal.green : (tool.type === "builtin" ? pal.cyan : pal.purple);
                return h_flex().id(`tool-chip-${tool.name}`).items_center().gap(4).px(6).py(3).rounded(4)
                .bg(isUsed ? t.selected : t.background)
                .border(1)
                .border_color(isUsed ? pal.green : t.border)
                .child(svg(isUsed ? "mods/t3-sessions/icons/check.svg" : (tool.type === "builtin" ? "mods/t3-sessions/icons/terminal.svg" : "mods/t3-sessions/icons/sparkles.svg")).size(10).text_color(chipColor).flex_none())
                .child(div().text_size(10.5).font_family(mono)
                  .when(isUsed, (d) => d.font_bold().text_color(pal.green))
                  .when(!isUsed, (d) => d.text_color(tool.type === "builtin" ? pal.cyan : t.foreground))
                  .child(tool.name))
                .when(isUsed, (elChip) => elChip.child(div().text_size(8.5).font_bold().px(3).py(0.5).rounded(2).bg(pal.green + "26").text_color(pal.green).child("ACTIVE")));
            })))
          .when(displayedTools.length === 0, (el3) => el3.child(
            div().p(8).text_size(11).text_color(t.dim).child("没有匹配的工具或技能"))))))

      // 6. LIVE ACTIVITY FEED (Collapsible, default collapsed)
      .child(v_flex().w_full().p(8).gap(6).rounded(6).bg(t.raised).border(1).border_color(t.border)
        .child(h_flex().w_full().justify_between().items_center().cursor_pointer()
          .on_click((_e, cx) => { this.activityOpen = !this.activityOpen; cx.notify(); })
          .child(this.sectionHead("ACTIVITY", pal.green, "mods/t3-sessions/icons/terminal.svg", t))
          .child(h_flex().gap(5).items_center().text_size(10).flex_none()
            .when((tel.readFilesCount || 0) > 0 || (tel.editedFilesCount || 0) > 0, (el) => el.child(
              div().px(5).py(1).rounded(3).bg(t.background).text_color(t.muted).child(`读 ${tel.readFilesCount || 0} · 改 ${tel.editedFilesCount || 0}`)))
            .child(div().px(5).py(1).rounded(3).bg(t.selected).font_bold().text_color(pal.green).child(`${tel.toolsOk || 0} ok`))
            .when((tel.toolsErr || 0) > 0, (el) => el.child(
              div().px(5).py(1).rounded(3).bg(pal.red + "26").font_bold().text_color(pal.red).child(`${tel.toolsErr} err`)))
            .when(Boolean(tel.avgToolMs), (el) => el.child(
              div().px(5).py(1).rounded(4).bg(t.background).font_family(mono).text_color(t.dim).child(`avg ${tel.avgToolMs}`)))
            .child(div().text_size(11).font_medium().text_color(t.muted)
              .child(this.activityOpen ? "▾ 收起" : "▸ 展开"))))
        .when(this.activityOpen, (el) => el.child(v_flex().w_full().gap(6).pt(2)
          .children((tel.recentTools || []).map((tool, idx) => {
            const isOk = tool.status === "ok";
            const stColor = isOk ? pal.green : pal.gold;
            return v_flex().id(`tool-${idx}`).w_full().gap(2).py(5).px(7).rounded(6).bg(t.background).border(1).border_color(t.border)
              .child(h_flex().w_full().justify_between().items_center().gap(6)
                .child(h_flex().gap(6).items_center().min_w(0).flex_1()
                  .child(div().size(6).flex_none().rounded_full().bg(stColor))
                  .child(div().text_size(11).font_bold().text_color(t.foreground).truncate().child(tool.name)))
                .child(h_flex().gap(6).items_center().flex_none().font_family(mono).text_size(10)
                  .when(Boolean(tool.time), (el2) => el2.child(div().text_color(t.dim).child(tool.time)))
                  .child(div().px(4).py(0.5).rounded(4).bg(t.raised).text_color(stColor).child(tool.ms || "—"))))
              .when(Boolean(tool.detail), (el2) => el2.child(
                div().pl(12).text_size(10).font_family(mono).text_color(t.dim).truncate().child(tool.detail)));
          }))
          .when((tel.recentTools?.length || 0) === 0, (el2) => el2.child(
            div().py(4).text_size(11).text_color(t.dim).child("等待工具调用 / 暂无活动记录")))
          .when(remainingTools > 0, (el2) => el2.child(
            div().pt(1).text_size(10).text_color(t.dim).child(`… 另有 ${remainingTools} 次历史工具调用`))))));
  }

  renderHistory(t, short, root) {
    // Calculate agent category counts based on current project scope & search query
    const raw = this.filter.trim();
    const wanted = [...raw.matchAll(/#([^\s#]+)/g)].map((m) => m[1].toLowerCase());
    const q = raw.replace(/#[^\s#]+/g, " ").trim().toLowerCase();
    const scopedList = this.sessions.filter((s) => {
      if (!this.showAll && root && (!s.cwd || !pathMatches(root, s.cwd))) return false;
      const own = this.tagsOf(s).map((x) => String(x).toLowerCase());
      if (this.tagOnly && !own.includes(String(this.tagOnly).toLowerCase())) return false;
      if (wanted.some((tag) => !own.some((x) => x.includes(tag)))) return false;
      if (!q) return true;
      return `${s.title} ${own.join(" ")} ${s.cwd}`.toLowerCase().includes(q);
    });
    const list = this.historyAgentFilter === "all"
      ? scopedList
      : scopedList.filter((s) => s.agent === this.historyAgentFilter);
    const groups = groupSessions(list);

    const counts = { all: scopedList.length, [AGY]: 0, [CDX]: 0, [CC]: 0, [PI]: 0, [OMP]: 0 };
    for (const s of scopedList) {
      if (counts[s.agent] !== undefined) counts[s.agent]++;
    }

    // Collect all popular tags for tag filtering bar
    const tagCounts = new Map();
    for (const s of scopedList) {
      for (const tag of this.tagsOf(s)) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
    const popularTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    return v_flex().id("sessions-history").flex_1().min_h(0)
      // Search and Filter Bar
      .child(v_flex().flex_none().px(10).pt(8).pb(6).gap(6).border_b(1).border_color(t.border)
        // Search Input + Scope Toggle + Refresh
        .child(h_flex().h(28).gap(6).items_center()
          .child(h_flex().flex_1().h_full().px(8).items_center().rounded(6).bg(t.raised).border_1().border_color(t.border)
            .child(Input.new(this.input).flex_1().h_full().text_size(11.5).text_color(t.foreground))
            .when(Boolean(this.filter), (el) => el.child(
              div().id("btn-clear-search").cursor_pointer().text_size(10).text_color(t.dim).hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => {
                  this.filter = "";
                  this.input.set_value("");
                  cx.notify();
                })
                .child("✕")
            )))
          // Current Project / All Projects Switch Pill
          .child(h_flex().id("btn-scope-toggle").h_full().px(7).gap(4).items_center().rounded(5).cursor_pointer()
            .bg(this.showAll ? t.raised : t.background)
            .border_1().border_color(t.border)
            .hover((s) => s.border_color(t.accent))
            .on_click((_e, cx) => {
              this.showAll = !this.showAll;
              cx.notify();
            })
            .child(svg(this.showAll ? "mods/t3-sessions/icons/server.svg" : "mods/t3-sessions/icons/folder.svg").size(11).text_color(this.showAll ? t.accent : t.muted).flex_none())
            .child(div().text_size(11).font_medium().text_color(this.showAll ? t.accent : t.foreground).child(this.showAll ? "全局" : (short(root) || "当前项目"))))
          // Export CSV Button (Magpie-inspired masked usage export)
          .child(div().id("btn-export-csv").h_full().px(7).flex_none().flex().items_center().rounded(5).bg(t.raised).border_1().border_color(t.border).text_size(10.5).font_medium().text_color(t.muted).cursor_pointer()
            .hover((s) => s.text_color(t.foreground).bg(t.hover))
            .on_click((_e, cx) => {
              const csvEsc = (v) => `"${maskSecrets(v).replace(/"/g, '""')}"`;
              const header = "agent,id,mtime,cwd,tags,title";
              const rows = scopedList.map((s) => [
                csvEsc(s.agent),
                csvEsc(s.id),
                csvEsc(s.mtime ? new Date(s.mtime).toISOString() : ""),
                csvEsc(s.cwd || ""),
                csvEsc(this.tagsOf(s).join(" ")),
                csvEsc(s.title || "")
              ].join(","));
              cx.write_to_clipboard([header, ...rows].join("\n"));
              notify({ title: "已导出会话 CSV 到剪贴板", body: `共 ${scopedList.length} 条记录（已自动脱敏）`, level: "success" });
            })
            .child("CSV"))
          // Refresh Button
          .child(div().id("btn-refresh-hist").h_full().px(7).flex_none().flex().items_center().rounded(5).bg(t.raised).border_1().border_color(t.border).text_size(11).text_color(t.muted).cursor_pointer()
            .hover((s) => s.text_color(t.foreground).bg(t.hover))
            .on_click((_e, cx) => { this.refreshHistory(cx); })
            .child("⟳")))

        // Agent Category Tabs (分类标签栏)
        .child(h_flex().w_full().gap(4).items_center().overflow_x_scrollbar().pb(1)
          .child(this.categoryTab("all", "全部", null, counts.all, null, t))
          .when(counts[AGY] > 0 || this.historyAgentFilter === AGY, (el) => el.child(
            this.categoryTab(AGY, "Antigravity", "mods/t3-sessions/icons/sparkles.svg", counts[AGY], agentColorOf(AGY, t), t)
          ))
          .when(counts[CDX] > 0 || this.historyAgentFilter === CDX, (el) => el.child(
            this.categoryTab(CDX, "Codex", "mods/t3-sessions/icons/terminal.svg", counts[CDX], agentColorOf(CDX, t), t)
          ))
          .when(counts[CC] > 0 || this.historyAgentFilter === CC, (el) => el.child(
            this.categoryTab(CC, "Claude", "mods/t3-sessions/icons/sparkles.svg", counts[CC], agentColorOf(CC, t), t)
          ))
          .when(counts[PI] > 0 || this.historyAgentFilter === PI, (el) => el.child(
            this.categoryTab(PI, "Pi", "mods/t3-sessions/icons/zap.svg", counts[PI], agentColorOf(PI, t), t)
          ))
          .when(counts[OMP] > 0 || this.historyAgentFilter === OMP, (el) => el.child(
            this.categoryTab(OMP, "OMP", "mods/t3-sessions/icons/terminal.svg", counts[OMP], agentColorOf(OMP, t), t)
          ))
        )

        // Popular Tags bar (if any) or Active Tag Filter
        .when(Boolean(this.tagOnly) || popularTags.length > 0, (el) => el.child(
          h_flex().w_full().gap(4).items_center().pt(1)
            .child(svg("mods/t3-sessions/icons/tag.svg").size(10).text_color(t.dim).flex_none())
            .when(Boolean(this.tagOnly), (el2) => el2.child(
              h_flex().h(18).px(6).gap(3).items_center().rounded(4).bg(t.background).border_1().border_color(t.accent).text_size(10.5).text_color(t.accent)
                .child(div().child(`#${this.tagOnly}`))
                .child(div().text_size(9).text_color(t.dim).hover((s) => s.text_color(t.ansi1))
                  .on_click((_e, cx) => { cx.stop_propagation(); this.tagOnly = null; cx.notify(); }).child("✕"))
            ))
            .children(popularTags.filter(([tag]) => tag !== this.tagOnly).map(([tag, count]) =>
              h_flex().h(18).px(5).gap(2).items_center().rounded(4).bg(t.raised).cursor_pointer().text_size(10).text_color(t.dim)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => { cx.stop_propagation(); this.tagOnly = tag; cx.notify(); })
                .child(div().child(`#${tag}`))
                .child(div().text_size(9).text_color(t.dim).child(String(count)))
            ))
        ))
      )

      // Session List with Chronological Grouping
      .when(list.length > 0, (el) => el.child(
        v_flex().id("session-list").flex_1().min_h(0).p(8).gap(6).overflow_y_scrollbar()
          .children(groups.map((group) =>
            v_flex().w_full().gap(4)
              .child(this.historySectionHeader(group.label, group.items.length, t))
              .children(group.items.map((s, i) => this.row(s, `${group.id}-${i}`, t, short, root)))
          ))
      ))

      // Empty State
      .when(list.length === 0, (el) => el.child(
        v_flex().flex_1().items_center().justify_center().p(24).gap(8)
          .child(svg("mods/t3-sessions/icons/file-text.svg").size(28).text_color(t.dim))
          .child(div().font_medium().text_size(13).text_color(t.foreground)
            .child(this.loading ? "正在加载历史会话…" : "暂无匹配的历史会话"))
          .child(div().text_size(11.5).text_color(t.dim).text_center()
            .child(this.error || (this.loading ? "正在扫描本地 Agent 会话日志…" : !this.showAll ? "当前项目目录下暂无历史会话，点击下方按钮切换查看所有项目会话。" : "未找到符合当前分类或搜索条件的会话记录。")))
          .when(!this.showAll && !this.loading, (el2) => el2.child(
            h_flex().mt(4).px(10).py(4).rounded(5).bg(t.raised).border_1().border_color(t.border).cursor_pointer()
              .hover((s) => s.bg(t.hover).border_color(t.accent))
              .on_click((_e, cx) => { this.showAll = true; cx.notify(); })
              .child(svg("mods/t3-sessions/icons/server.svg").size(11).text_color(t.accent).mr(4))
              .child(div().text_size(11.5).font_medium().text_color(t.foreground).child("查看所有项目会话"))
          ))
          .when(this.showAll && Boolean(this.filter || this.historyAgentFilter !== "all" || this.tagOnly), (el2) => el2.child(
            h_flex().mt(4).px(10).py(4).rounded(5).bg(t.raised).border_1().border_color(t.border).cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                this.filter = "";
                this.input.set_value("");
                this.historyAgentFilter = "all";
                this.tagOnly = null;
                cx.notify();
              })
              .child(div().text_size(11.5).font_medium().text_color(t.accent).child("清除所有筛选条件"))
          ))
      ));
  }

  render() {
    const t = theme(), h = norm(home()), root = currentPlace().cwd;
    const short = (p) => {
      const np = norm(p);
      return np && h && np.startsWith(h) ? "~" + np.slice(h.length) : p ?? "";
    };

    return v_flex().id("t3-sessions").size_full().min_h(0).text_color(t.foreground).text_size(13)
      // Top Mode Switch Toolbar
      .child(h_flex().id("t3-sessions-toolbar").h(40).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(h_flex().gap(3).p(2).rounded(6).bg(t.raised)
          .child(h_flex().id("btn-inspector").px(8).py(3).gap(5).items_center().rounded(4).cursor_pointer().text_size(11.5).font_medium()
            .when(this.viewMode === "inspector", (el) => el.bg(t.background).text_color(t.foreground).border_1().border_color(t.border))
            .when(this.viewMode !== "inspector", (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) => { this.viewMode = "inspector"; setShared("t3.sessions.mode", "inspector"); this.pollTelemetry(cx); cx.notify(); })
            .child(svg("mods/t3-sessions/icons/sparkles.svg").size(11).text_color(this.viewMode === "inspector" ? t.accent : t.muted).flex_none())
            .child("Inspector"))
          .child(h_flex().id("btn-history").px(8).py(3).gap(5).items_center().rounded(4).cursor_pointer().text_size(11.5).font_medium()
            .when(this.viewMode === "history", (el) => el.bg(t.background).text_color(t.foreground).border_1().border_color(t.border))
            .when(this.viewMode !== "history", (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) => { this.viewMode = "history"; setShared("t3.sessions.mode", "history"); this.refreshHistory(cx); cx.notify(); })
            .child(svg("mods/t3-sessions/icons/clock.svg").size(11).text_color(this.viewMode === "history" ? t.accent : t.muted).flex_none())
            .child(`History (${this.sessions.length})`)))
        .child(div().flex_1())
        .when(this.viewMode === "inspector", (el) => el.child(
          h_flex().gap(4).items_center().text_size(10.5).font_medium().text_color(paletteOf(t).green)
            .child(div().size(6).rounded_full().bg(paletteOf(t).green))
            .child("LIVE"))))

      .child(this.viewMode === "inspector" ? this.renderInspector(t, short, root) : this.renderHistory(t, short, root));
  }
}
