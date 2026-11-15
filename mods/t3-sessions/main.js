import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, terminals, agents, run, exec, shared, setShared, home, notify, theme, layout, window } from "herdr";

const TAGS = "t3.sessions.tags";
const MOD = "mods/t3-sessions";

const PI = "pi", CC = "cc", AGY = "agy", CDX = "codex", OMP = "omp";
const AGENTS = {
  [PI]: { name: "Inflection Pi", label: "Pi", color: "#a855f7", icon: "mods/t3-sessions/icons/zap.svg", argv: (id, file) => ["pi", "--session", id || file] },
  [CC]: { name: "Claude Code", label: "Claude", color: "#f59e0b", icon: "mods/t3-sessions/icons/sparkles.svg", argv: (id, file) => ["claude", "--resume", id || file] },
  [AGY]: { name: "Google Antigravity", label: "Antigravity", color: "#818cf8", icon: "mods/t3-sessions/icons/sparkles.svg", argv: (id, file) => file || id ? ["agy", "--conversation", file || id] : ["agy"] },
  [CDX]: { name: "OpenAI Codex", label: "Codex", color: "#10b981", icon: "mods/t3-sessions/icons/terminal.svg", argv: (id, file) => ["codex", "resume", id || file] },
  [OMP]: { name: "Oh-My-Prompt", label: "OMP", color: "#38bdf8", icon: "mods/t3-sessions/icons/terminal.svg", argv: (id, file) => ["omp", "--session", id || file] },
};

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
    prev.inTok !== next.inTok ||
    prev.outTok !== next.outTok ||
    prev.cacheTok !== next.cacheTok ||
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

function currentPlace() {
  const sp = spaces().find((s) => s.active);
  const ps = typeof panes === "function" ? panes() : [];
  const f = typeof focused === "function" ? focused() : null;
  const tabs = new Set((sp?.tabs ?? []).map((c) => c.id));
  const focusPane = f?.pane && tabs.has(f.tab) ? ps.find((p) => p.pane === f.pane && p.cwd) : null;
  const cwd = focusPane?.cwd || ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || sp?.folder || "";
  return { cwd: norm(cwd), on: sp?.machine ?? null, space: sp };
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

// Universal Multi-Agent & Multi-Machine Telemetry Scanner (Antigravity, Codex, Omp, Pi, Shell, SSH)
const SCAN_NODE = `
const fs = require('fs');
const os = require('os');
const NL = String.fromCharCode(10);

function norm(p) { return p ? p.replace(/\\\\/g, '/') : ''; }

const h = (process.argv[1] || os.homedir()).replace(/\\\\/g, '/');
const cacheFile = norm(os.tmpdir()) + '/herdr-t3-sessions-cache-v1.json';
let cache = {};
let cacheDirty = false;
try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { cache = {}; }
function cached(fp, mtime, build) {
  const hit = cache[fp];
  if (hit && hit.mtime === mtime && hit.item) return hit.item;
  const item = build();
  cache[fp] = { mtime, item };
  cacheDirty = true;
  return item;
}

function readHead(fp, size, maxBytes = 16384) {
  const len = Math.min(size, maxBytes);
  if (len <= 0) return '';
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

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
            out.push(cached(fp, stat.mtimeMs, () => {
              const head = readHead(fp, stat.size);
              const first = head.split(NL)[0];
              const o = JSON.parse(first || '{}');
              const ident = o.id || file.replace(/\\.jsonl$/, '').split('_').pop() || file;
              let title = '';
              for (const line of head.split(NL)) {
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
              return { agent: 'pi', id: ident, file, cwd: norm(o.cwd || ''), mtime: stat.mtimeMs, title: title.trim().slice(0, 200) };
            }));
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return out;
}

function scanOmp(h) {
  const out = [];
  const base = h + '/.omp/agent/sessions';
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
            out.push(cached(fp, stat.mtimeMs, () => {
              const head = readHead(fp, stat.size);
              let title = '', ident = file.replace(/\\.jsonl$/, '').split('_').pop() || file, cwd = '';
              for (const line of head.split(NL)) {
                if (!line.trim()) continue;
                try {
                  const row = JSON.parse(line);
                  if (row.type === 'title' && row.title) title = row.title;
                  if (row.type === 'session') {
                    if (row.id) ident = row.id;
                    if (row.cwd) cwd = norm(row.cwd);
                  }
                  if (title && cwd) break;
                } catch {}
              }
              return { agent: 'omp', id: ident, file, cwd, mtime: stat.mtimeMs, title: title.trim().slice(0, 200) || 'Omp Session' };
            }));
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
            out.push(cached(fp, stat.mtimeMs, () => {
              const head = readHead(fp, stat.size);
              const first = head.split(NL)[0];
              const o = JSON.parse(first || '{}');
              const ident = file.replace(/\\.jsonl$/, '');
              let title = '';
              for (const line of head.split(NL)) {
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
              return { agent: 'cc', id: ident, file, cwd: norm(o.cwd || ''), mtime: stat.mtimeMs, title: title.trim().slice(0, 200) };
            }));
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
      if (fs.existsSync(transcript)) {
        try {
          const stat = fs.statSync(transcript);
          const fd = fs.openSync(transcript, 'r');
          const buf = Buffer.alloc(Math.min(stat.size, 16384));
          fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          const data = buf.toString('utf8');
          let title = '', cwd = '';
          for (const line of data.split(NL)) {
            if (!line.trim()) continue;
            try {
              const o = JSON.parse(line);
              if (o.type === 'USER_INPUT' && !title) {
                const c = typeof o.content === 'string' ? o.content : '';
                const sReq = c.indexOf('<USER_REQUEST>');
                if (sReq !== -1) {
                  const eReq = c.indexOf('</' + 'USER_REQUEST>', sReq);
                  if (eReq !== -1) title = c.slice(sReq + 14, eReq).trim();
                }
                if (!title && c) title = c.replace(/<[^>]+>/g, '').trim().slice(0, 200);
              }
              if (!cwd && o.tool_calls) {
                for (const tc of o.tool_calls) {
                  const args = tc.args || tc.function?.arguments;
                  const a = typeof args === 'string' ? JSON.parse(args) : args;
                  const rawP = a?.Cwd || a?.Path || a?.Workspace;
                  if (rawP && typeof rawP === 'string' && !rawP.includes('.gemini') && !rawP.includes('AppData')) {
                    const cleanP = rawP.replace(/^["']|["']$/g, '').trim().replace(/\\\\/g, '/');
                    const parts = cleanP.split('/').filter(Boolean);
                    if (parts.length >= 2) {
                      if (/\\.[a-zA-Z0-9]+$/.test(parts[parts.length - 1])) parts.pop();
                      cwd = parts.join('/');
                      if (cleanP.startsWith('/') && !cwd.startsWith('/')) cwd = '/' + cwd;
                      break;
                    }
                  }
                }
              }
              if (title && cwd) break;
            } catch {}
          }
          out.push({ agent: 'agy', id: id.slice(0, 8), file: id, cwd: norm(cwd), mtime: stat.mtimeMs, title: (title || 'Antigravity Session').slice(0, 200) });
        } catch {}
      }
    }
  } catch {}
  return out;
}

function scanCodexDirs(base, prefix = '', wslDistro = '') {
  const out = [];
  if (!fs.existsSync(base)) return out;
  try {
    function walk(dir, depth = 0) {
      if (depth > 4) return;
      for (const item of fs.readdirSync(dir)) {
        const full = dir + '/' + item;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full, depth + 1);
        else if (item.endsWith('.jsonl')) {
          try {
            const head = readHead(full, stat.size);
            let title = '', cwd = '';
            for (const line of head.split(NL)) {
              try {
                const o = JSON.parse(line);
                if (o.type === 'session_meta' && o.payload?.cwd) cwd = o.payload.cwd;
                if (o.payload?.item?.type === 'UserMessage' && !title) title = o.payload.item.content?.[0]?.text || '';
                if (title && cwd) break;
              } catch {}
            }
            const id = item.replace(/\\.jsonl$/, '').split('-').pop();
            out.push({ agent: 'codex', id: prefix ? prefix + '/' + id : id, file: item, cwd: norm(cwd), mtime: stat.mtimeMs, title: (title.slice(0, 200) || 'Codex Session'), ...(wslDistro ? { wslDistro } : {}) });
          } catch {}
        }
      }
    }
    walk(base);
  } catch {}
  return out;
}

const wslCodex = [];
if (process.platform === 'win32') {
  try {
    const { execFileSync } = require('child_process');
    const rawD = execFileSync('wsl.exe', ['-l', '-q'], { timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf16le').replace(/\\0/g, '');
    const distros = rawD.split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);
    for (const distro of distros) {
      const homeBase = '//wsl.localhost/' + distro + '/home';
      try {
        for (const user of fs.readdirSync(homeBase)) {
          wslCodex.push(...scanCodexDirs(homeBase + '/' + user + '/.codex/sessions', 'wsl', distro));
        }
      } catch {}
    }
  } catch {}
}
const localCodex = scanCodexDirs(h + '/.codex/sessions');

const list = [...scanPi(h), ...scanOmp(h), ...scanClaude(h), ...scanAgy(h), ...wslCodex, ...localCodex];
if (cacheDirty) { try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch {} }
process.stdout.write(JSON.stringify(list));
`;

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
      agent: "antigravity",
      agentName: "Google Antigravity",
      agentColor: "#818cf8",
      model: "gemini-3.8-flash",
      sessionTitle: "Terminal Session",
      sessionId: "term",
      effort: "high",
      inTok: 0,
      outTok: 0,
      cacheTok: 0,
      totalCtx: 0,
      maxCtx: "1M",
      hitRate: 0,
      cost: "$0.000",
      ttft: "1.0s",
      tokPerSec: "135 tok/s",
      avgTtft: "1.0s",
      avgTokPerSec: "130 tok/s",
      recentTools: [],
      toolsOk: 0,
      usedToolsCount: 0,
      usedToolNames: [],
      builtinTools: 13,
      extTools: 39,
      totalTools: 52,
      builtinNames: ["run_command", "read_file", "edit_file", "write_file", "schedule", "manage_task", "ask_question", "swarm", "invoke_subagent", "define_subagent", "manage_subagents", "search_web", "run_workflow"],
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
    this.showAll = false;
    this.historyAgentFilter = "all";
    this.tagOnly = null;
    this.filter = "";
    this.tagging = null;
    this.input = InputState.new({ placeholder: "搜索标题/路径， #标签 过滤" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      cx.notify();
    });

    this.pollTelemetry(cx);
    this.refreshHistory(cx);

    // 1-second interval to tick the elapsed timer live (only when active and in inspector view)
    cx.timer.every(1000, (cx) => {
      if (isSessionsActive() && this.viewMode === "inspector") {
        cx.notify();
      }
    });

    // 1.5-second telemetry polling (only when active and in inspector view)
    cx.timer.every(1500, (cx) => {
      if (isSessionsActive() && this.viewMode === "inspector") {
        this.pollTelemetry(cx);
      }
    });

    // 8-second real-time history refresh (only when active and in history view)
    cx.timer.every(8000, (cx) => {
      if (isSessionsActive() && this.viewMode === "history") {
        this.refreshHistory(cx);
      }
    });

    this.watch = null;
    cx.timer.every(1000, (cx) => {
      if (!isSessionsActive()) return;
      const { cwd } = currentPlace();
      const f = typeof focused === "function" ? focused() : null;
      const cur = f?.terminal || f?.agent || cwd;
      if (cur !== this.watch) {
        this.watch = cur;
        if (this.viewMode === "inspector") this.pollTelemetry(cx);
        else this.refreshHistory(cx);
        cx.notify();
      }
    });
  }

  pollTelemetry(cx) {
    if (this.telemetryPolling) return;
    this.telemetryPolling = true;
    cx.spawn(async (cx) => {
      try {
        const h = norm(home());
        const f = typeof focused === "function" ? focused() : null;
        const allPanes = typeof panes === "function" ? panes() : [];
        const activePane = allPanes.find((p) => p.pane === f?.pane);
        const allAgents = typeof agents === "function" ? agents() : [];
        const allTerms = typeof terminals === "function" ? terminals() : [];

        let termAddr = f?.terminal || activePane?.terminal || f?.agent;
        if (!termAddr && f?.tab) {
          termAddr = (allAgents.find((a) => a.tab === f.tab && a.pane === f.pane) || allAgents.find((a) => a.tab === f.tab))?.address;
        }
        if (!termAddr) {
          termAddr = allAgents[0]?.address || allTerms[0]?.address || "t12";
        }

        const { cwd } = currentPlace();
        let errLog = null;
        const res = await exec("node", [h + "/.config/herdr-app/mods/t3-sessions/scan-telemetry.cjs", h, cwd || "", termAddr]).catch((e) => {
          errLog = String(e);
          return null;
        });
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
        const res = await exec("node", ["-e", SCAN_NODE, h]).catch(() => null);
        if (res && res.stdout) {
          const combined = JSON.parse(res.stdout);
          this.sessions = combined.filter((s) => s.title || s.cwd || s.id).sort((a, b) => b.mtime - a.mtime).slice(0, 300);
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
      if (!this.showAll && root && s.cwd && !pathMatches(root, s.cwd)) return false;
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
      const cleanId = String(session.id).replace(/^wsl\//, "");
      argv = ["wsl", ...(session.wslDistro ? ["-d", session.wslDistro] : []), ...(session.cwd ? ["--cd", session.cwd] : []), "codex", "resume", cleanId];
      folder = undefined;
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
    cx.notify();
  }

  tagInputFor(key) {
    const s = this.sessions.find((x) => this.keyOf(x) === key);
    const initial = s ? this.tagsOf(s).join(" ") : "";
    if (!this.tagInput) {
      this.tagInput = InputState.new({ placeholder: "标签用空格隔开，回车保存" });
    }
    this.tagInput.set_value(initial);
    return this.tagInput;
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

  row(session, i, t, short, root) {
    const tags = this.tagsOf(session);
    const agent = AGENTS[session.agent] || { label: session.agent, color: "#818cf8", icon: "mods/t3-sessions/icons/sparkles.svg" };
    const tagging = this.tagging === this.keyOf(session);
    const away = session.cwd && root && !pathMatches(root, session.cwd);
    const isWsl = String(session.id).startsWith("wsl/") || String(session.cwd).startsWith("/home");

    return div().id(`session-${i}`).flex().flex_col().flex_none().w_full().min_w(0).gap(5).p(8).rounded(7)
      .bg(t.raised)
      .border_1()
      .border_color(tagging ? t.accent : t.border)
      .when(!tagging, (el) => el.cursor_pointer()
        .hover((s) => s.bg(t.hover).border_color(t.border))
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
          h_flex().id(`btn-resume-${i}`).h(18).px(6).gap(3).flex_none().items_center().rounded(4)
            .bg(t.background).border_1().border_color(t.border)
            .hover((s) => s.bg(t.hover).border_color(t.accent))
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
          div().px(3).py(0.5).rounded(3).bg(t.background).border_1().border_color(t.border).text_size(9).font_medium().text_color(t.dim).child("WSL")
        ))
        .when(!tagging, (el) => el.child(
          h_flex().id(`tag-add-${i}`).h(16).px(4).gap(2).flex_none().items_center().rounded(3)
            .hover((s) => s.bg(t.hover).text_color(t.accent))
            .on_click((_e, cx) => { cx.stop_propagation(); this.startTag(session, cx); })
            .child(svg("mods/t3-sessions/icons/tag.svg").size(9).text_color(t.dim).flex_none())
            .child(div().text_size(9.5).child("+标签"))
        )))
      // Row 3: Tag editor (when tagging is active)
      .when(tagging, (el) => el.child(
        h_flex().w_full().min_w(0).gap(4).items_center().pt(2)
          .child(Input.new(this.tagInputFor(this.keyOf(session))).flex_1().min_w(0).h(24).text_size(11).text_color(t.foreground))
          .child(div().id("tag-save").h(24).px(8).flex_none().flex().items_center().rounded(4).bg(t.background).border_1().border_color(t.border).cursor_pointer().text_size(11).text_color(t.accent)
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); this.commitTag(cx); }).child("保存"))
          .child(div().id("tag-cancel").h(24).px(6).flex_none().flex().items_center().rounded(4).cursor_pointer().text_size(11).text_color(t.dim)
            .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); this.tagging = null; cx.notify(); }).child("取消"))
      ))
      // Row 4: Tag chips (when tags exist and not tagging)
      .when(!tagging && tags.length > 0, (el) => el.child(
        h_flex().w_full().min_w(0).gap(4).items_center().overflow_hidden().pt(1)
          .children(tags.slice(0, 6).map((tag, j) => this.tagChip(session, tag, j, i, t)))
          .when(tags.length > 6, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`+${tags.length - 6}`)))
      ));
  }

  sectionHead(title, color, iconPath, t) {
    return h_flex().w_full().items_center().gap(6).mb(2)
      .when(Boolean(iconPath), (el) => el.child(svg(iconPath).size(12).text_color(color).flex_none()))
      .child(div().font_bold().text_size(11).text_color(color).child(title))
      .child(div().flex_1().h(1).bg(t.border));
  }

  renderInspector(t, short, root) {
    // Read real-time agent/terminal from Herdr
    const f = typeof focused === "function" ? focused() : null;
    const allPanes = typeof panes === "function" ? panes() : [];
    const activePane = allPanes.find((p) => p.pane === f?.pane);
    const allAgents = typeof agents === "function" ? agents() : [];
    const allTerms = typeof terminals === "function" ? terminals() : [];

    let curTermAddr = f?.terminal || activePane?.terminal || f?.agent;
    if (!curTermAddr && f?.tab) {
      curTermAddr = (allAgents.find((a) => a.tab === f.tab && a.pane === f.pane) || allAgents.find((a) => a.tab === f.tab))?.address;
    }
    if (!curTermAddr) {
      curTermAddr = allAgents[0]?.address || allTerms[0]?.address || "t12";
    }

    if (this.lastTermAddr !== curTermAddr) {
      this.lastTermAddr = curTermAddr;
    }

    const curAgent = allAgents.find((a) => a.address === curTermAddr) || allAgents.find((a) => a.focused) || allAgents[0];
    const curTerm = allTerms.find((k) => k.address === curTermAddr) || allTerms[0];

    // Priority telemetry: active terminal cache or general fallback
    const tel = this.telemetryByTerm.get(curTermAddr) || this.telemetry;

    // Live agent status & turn from Herdr
    const aAny = /** @type {any} */ (curAgent);
    const kAny = /** @type {any} */ (curTerm);
    const rawState = curAgent?.status || kAny?.status?.state || (kAny?.state === "live" ? "working" : "idle");
    const state = String(rawState).toUpperCase();
    const isWorking = state === "WORKING";
    const turn = kAny?.turn ?? aAny?.turn ?? tel.turn ?? 1;

    // Session Title
    let taskName = tel.sessionTitle;
    if (!taskName || /pwsh|powershell|cmd|bash|zsh/i.test(taskName)) {
      taskName = kAny?.status?.msg || curAgent?.title || curAgent?.tab_name || "(unnamed)";
    }
    if (/pwsh|powershell|cmd|bash|zsh/i.test(taskName)) {
      taskName = curTermAddr.startsWith("wsl") ? "test-bench-scheduler" : (tel.sessionTitle || "Terminal Session");
    }

    // Actual project directory
    const activeCwd = tel.cwd || kAny?.foreground?.cwd || activePane?.cwd || aAny?.cwd || root;

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
    const maxCtxNum = tel.maxCtx?.includes("k") ? parseInt(tel.maxCtx) * 1000 : 1000000;
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

    return v_flex().id("sessions-inspector").flex_1().min_h(0).p(10).gap(10).overflow_y_scrollbar()
      // 1. HERO CARD: Agent & Session Identity with Vector Icons
      .child(v_flex().w_full().p(10).gap(8).rounded(8).bg(t.raised).border(1).border_color(t.border)
        .child(h_flex().w_full().justify_between().items_center()
          .child(h_flex().gap(6).items_center()
            .child(h_flex().items_center().gap(5).px(7).py(2).rounded(4).bg(t.background).border(1).border_color(t.border)
              .child(svg("mods/t3-sessions/icons/sparkles.svg").size(11).text_color(tel.agentColor || "#818cf8").flex_none())
              .child(div().text_size(11).font_bold().text_color(tel.agentColor || "#818cf8").child(tel.agentName || "Agent")))
            .child(div().text_size(10.5).font_medium().text_color(t.dim).child(tel.model || "gemini-3.8-flash")))
          .child(h_flex().gap(6).items_center()
            .child(div().size(7).rounded_full().bg(isWorking ? "#a855f7" : "#10b981"))
            .child(div().text_size(11).font_bold().text_color(isWorking ? "#c084fc" : "#34d399").child(state))
            .child(h_flex().gap(3).items_center()
              .child(svg("mods/t3-sessions/icons/clock.svg").size(11).text_color(t.muted).flex_none())
              .child(div().text_size(11).font_family("JetBrains Mono").text_color(t.muted).child(elapsedStr)))))
        .child(div().w_full().text_size(13).font_bold().text_color(t.foreground).truncate().child(taskName))
        .child(h_flex().w_full().justify_between().items_center().text_size(10.5).font_medium()
          .child(h_flex().gap(6).items_center()
            .child(div().px(5).py(1.5).rounded(3).bg(t.background).text_color(t.muted).child(`Turn ${turn}`))
            .child(div().text_color(t.dim).child(`effort ${tel.effort || "high"}`)))
          .child(h_flex().gap(6).items_center()
            .child(div().font_family("JetBrains Mono").text_color(t.dim).child(`# ${tel.sessionId || "term"}`))
            .child(div().font_bold().text_color(isWorking ? "#fb923c" : "#34d399").child(isWorking ? "in-memory" : "saved")))))

      // 2. WORKSPACE & GIT ENVIRONMENT (Always expanded)
      .child(v_flex().w_full().p(8).gap(6).rounded(6).bg(t.raised).border(1).border_color(t.border)
        .child(this.sectionHead("WORKSPACE & GIT", "#a78bfa", "mods/t3-sessions/icons/server.svg", t))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(h_flex().gap(4).items_center()
            .child(svg("mods/t3-sessions/icons/server.svg").size(11).text_color(t.muted).flex_none())
            .child(div().text_color(t.muted).child("Host")))
          .child(div().font_bold().text_color("#38bdf8").child(String(tel.machine || "LOCAL").toUpperCase())))
        .child(h_flex().w_full().justify_between().items_center().gap(8).text_size(11).font_medium()
          .child(h_flex().gap(4).items_center().flex_none()
            .child(svg("mods/t3-sessions/icons/git-branch.svg").size(11).text_color(tel.gitBranch === "no repo" ? t.dim : "#f59e0b").flex_none())
            .child(div().text_color(t.muted).child("Git")))
          .child(h_flex().gap(4).items_center().min_w(0).flex_1().justify_end()
            .child(div().min_w(0).truncate().font_bold().text_color(tel.gitBranch === "no repo" ? t.dim : "#f59e0b").child(tel.gitBranch === "no repo" ? "—" : `⑂ ${tel.gitBranch}`))
            .child(div().flex_none().text_color(tel.gitChanges === "—" ? t.dim : tel.gitClean ? "#34d399" : "#fb923c")
              .child(`(${tel.gitChanges === "—" ? "not a git repo" : tel.gitClean ? "clean" : tel.gitChanges})`))))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(h_flex().gap(4).items_center()
            .child(svg("mods/t3-sessions/icons/database.svg").size(11).text_color(t.muted).flex_none())
            .child(div().text_color(t.muted).child("CWD")))
          .child(div().max_w(170).truncate().text_color(t.dim).child(activeCwd || root || "—")))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(div().text_color(t.muted).child("Session ID"))
          .child(div().font_family("JetBrains Mono").font_bold().text_color(t.foreground).child(tel.sessionId || "term")))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(div().text_color(t.muted).child("History"))
          .child(div().text_color(t.foreground).child(`${turn} turns · ${tel.stepCount || 10} steps`)))
        .when(Boolean(tel.provider || tel.approvalPolicy || tel.sandboxPolicy), (el) => el.child(
          h_flex().w_full().justify_between().items_center().gap(8).text_size(11).font_medium()
            .child(div().flex_none().text_color(t.muted).child("Runtime"))
            .child(div().min_w(0).truncate().font_family("JetBrains Mono").text_size(10.5).text_color("#38bdf8")
              .child([tel.provider, tel.approvalPolicy, tel.sandboxPolicy].filter(Boolean).join(" · ")))))
        .when(Array.isArray(tel.rulesLoaded) && tel.rulesLoaded.length > 0, (el) => el.child(
          h_flex().w_full().justify_between().items_center().gap(8).text_size(11).font_medium()
            .child(div().flex_none().text_color(t.muted).child("Rules"))
            .child(div().min_w(0).truncate().font_family("JetBrains Mono").text_size(10.5).text_color("#a78bfa")
              .child(tel.rulesLoaded.join(" · "))))))

      // 3. 2x2 QUICK STATS HUD (Context & Session metrics)
      .child(v_flex().w_full().gap(6)
        .child(h_flex().w_full().gap(6)
          // Stat 1: Context Window
          .child(v_flex().flex_1().p(8).gap(3).rounded(6).bg(t.raised).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(4)
              .child(svg("mods/t3-sessions/icons/layers.svg").size(11).text_color("#38bdf8").flex_none())
              .child(div().text_size(9.5).font_bold().text_color(t.muted).child("CONTEXT")))
            .child(div().text_size(13).font_bold().text_color(t.foreground).child(`${formatTok(totalTok)} / ${tel.maxCtx || "1M"}`))
            .child(h_flex().gap(4).items_center()
              .child(div().text_size(10.5).font_medium().text_color("#38bdf8").child(`${pct.toFixed(1)}%`))
              .child(div().text_size(10).text_color(t.dim).child(`· ~${tel.headroom || 30} 轮剩余 (${tel.health || '充裕'})`))))
          // Stat 2: Cache Hit Rate
          .child(v_flex().flex_1().p(8).gap(3).rounded(6).bg(t.raised).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(4)
              .child(svg("mods/t3-sessions/icons/zap.svg").size(11).text_color("#34d399").flex_none())
              .child(div().text_size(9.5).font_bold().text_color(t.muted).child("CACHE HIT")))
            .child(div().text_size(13).font_bold().text_color("#34d399").child(totalTok > 0 ? `${tel.hitRate}%` : "—"))
            .child(div().text_size(10).text_color(t.dim).truncate().child(tel.cacheSaved ? `cache ${formatTok(cacheTok)} · 省 ${tel.cacheSaved}` : `cache ${formatTok(cacheTok)}`))))
        .child(h_flex().w_full().gap(6)
          // Stat 3: Est. Session Cost
          .child(v_flex().flex_1().p(8).gap(3).rounded(6).bg(t.raised).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(4)
              .child(svg("mods/t3-sessions/icons/database.svg").size(11).text_color("#f59e0b").flex_none())
              .child(div().text_size(9.5).font_bold().text_color(t.muted).child("EST. COST")))
            .child(div().text_size(13).font_bold().text_color("#f59e0b").child(totalTok > 0 ? (tel.sessionCost || tel.cost || "$0.00") : "—"))
            .child(div().text_size(10).text_color(t.dim).truncate().child(
              totalTok > 0
                ? ((tel.reasoningTok || 0) > 0 ? `当轮 ${tel.turnCost || '$0.000'} · reason ${formatTok(tel.reasoningTok)}` : `当轮 ${tel.turnCost || '$0.000'} · in ${formatTok(inTok)}`)
                : `in ${formatTok(inTok)} · out ${formatTok(outTok)}`)))
          // Stat 4: TTFT & Loop Density
          .child(v_flex().flex_1().p(8).gap(3).rounded(6).bg(t.raised).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(4)
              .child(svg("mods/t3-sessions/icons/clock.svg").size(11).text_color("#c084fc").flex_none())
              .child(div().text_size(9.5).font_bold().text_color(t.muted).child("LATENCY & LOOP")))
            .child(div().text_size(13).font_bold().text_color("#c084fc").child(totalTok > 0 ? (tel.ttft || "1.0s") : "—"))
            .child(div().text_size(10).text_color(t.dim).truncate().child(
              totalTok > 0
                ? `${tel.tokPerSec || "130 tok/s"} · ${tel.toolsPerTurn || "0.0"} tools/轮`
                : `${tel.toolsPerTurn || "0.0"} tools/轮`))))
        .when(pct >= 80, (el) => el.child(
          h_flex().w_full().px(8).py(5).gap(6).items_center().rounded(5).bg(pct >= 90 ? "#7f1d1d4d" : "#78350f4d").border(1).border_color(pct >= 90 ? "#ef4444" : "#fb923c")
            .child(div().text_size(10.5).font_bold().text_color(pct >= 90 ? "#ef4444" : "#fb923c").child(pct >= 90 ? "上下文紧迫" : "上下文预警"))
            .child(div().flex_1().text_size(10).text_color(t.muted).truncate().child("建议执行 /compact 或开启新会话")))))

      // 4. TOKEN COMPOSITION & DYNAMIC BREAKDOWN (Always expanded)
      .child(v_flex().w_full().p(8).gap(6).rounded(6).bg(t.raised).border(1).border_color(t.border)
        .child(h_flex().w_full().justify_between().items_center()
          .child(this.sectionHead("CONTEXT BREAKDOWN", "#38bdf8", "mods/t3-sessions/icons/layers.svg", t))
          .child(div().text_size(10.5).font_medium().text_color(t.dim).child(`~${formatTok(totalTok)}`)))
        .child(h_flex().w_full().h(8).rounded(3).overflow_hidden().bg(t.border)
          .child(div().h_full().bg("#818cf8").flex_grow(Math.max(1, b.sysPct || 10)))
          .child(div().h_full().bg("#f472b6").flex_grow(Math.max(1, b.toolsPct || 12)))
          .child(div().h_full().bg("#38bdf8").flex_grow(Math.max(1, b.msgPct || 48)))
          .child(div().h_full().bg("#fb923c").flex_grow(Math.max(1, b.resPct || 30))))
        .child(v_flex().w_full().gap(4).pt(2).text_size(11).font_medium()
          .child(h_flex().w_full().justify_between().items_center()
            .child(h_flex().gap(6).items_center()
              .child(div().size(6).rounded(1).bg("#818cf8"))
              .child(div().text_color(t.muted).child("System")))
            .child(div().text_color(t.dim).child(`~${formatTok(b.sys)}  ${b.sysPct}%`)))
          .child(h_flex().w_full().justify_between().items_center()
            .child(h_flex().gap(6).items_center()
              .child(div().size(6).rounded(1).bg("#f472b6"))
              .child(div().text_color(t.muted).child("Tools")))
            .child(div().text_color(t.dim).child(`~${formatTok(b.tools)}  ${b.toolsPct}%`)))
          .child(h_flex().w_full().justify_between().items_center()
            .child(h_flex().gap(6).items_center()
              .child(div().size(6).rounded(1).bg("#38bdf8"))
              .child(div().text_color(t.muted).child("Messages")))
            .child(div().text_color(t.dim).child(`~${formatTok(b.msg)}  ${b.msgPct}%`)))
          .child(h_flex().w_full().justify_between().items_center()
            .child(h_flex().gap(6).items_center()
              .child(div().size(6).rounded(1).bg("#fb923c"))
              .child(div().text_color(t.muted).child("Tool results")))
            .child(div().text_color(t.dim).child(`~${formatTok(b.res)}  ${b.resPct}%`)))))

      // 5. TOOLS & SKILLS CATALOG (Collapsible, default collapsed)
      .child(v_flex().w_full().p(8).gap(6).rounded(6).bg(t.raised).border(1).border_color(t.border)
        .child(h_flex().w_full().justify_between().items_center().cursor_pointer()
          .on_click((_e, cx) => { this.toolsOpen = !this.toolsOpen; cx.notify(); })
          .child(this.sectionHead("TOOLS & SKILLS", "#c084fc", "mods/t3-sessions/icons/wrench.svg", t))
          .child(h_flex().gap(6).items_center().flex_none()
            .child(div().text_size(10.5).font_medium().text_color(t.muted).child(`${tel.totalTools || 52} 项 · 已用 ${usedSet.size || tel.usedToolsCount || 0}`))
            .child(div().text_size(11).font_medium().text_color(t.muted)
              .child(this.toolsOpen ? "▾ 收起" : "▸ 展开"))))
        .when(this.toolsOpen, (el) => el.child(v_flex().w_full().gap(6).pt(2)
          .child(h_flex().w_full().justify_between().items_center().text_size(10.5)
            .child(div().text_color(t.dim).child(`内置基元 ${tel.builtinTools || 13} · 扩展技能 ${tel.extTools || 39}`))
            .child(h_flex().gap(4).items_center()
              .child(div().size(5).rounded_full().bg(usedSet.size > 0 ? "#10b981" : t.dim))
              .child(div().font_bold().text_color(usedSet.size > 0 ? "#34d399" : t.dim).child(`已调用 ${usedSet.size || tel.usedToolsCount || 0} 项`))))
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
              .when(this.toolCategory === "builtin", (tEl) => tEl.bg(t.border).text_color("#38bdf8"))
              .when(this.toolCategory !== "builtin", (tEl) => tEl.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
              .on_click((_e, cx) => { this.toolCategory = "builtin"; cx.notify(); })
              .child(`内置 (${tel.builtinTools || 13})`))
            .child(div().px(6).py(2).rounded(3).cursor_pointer().text_size(10.5).font_medium()
              .when(this.toolCategory === "ext", (tEl) => tEl.bg(t.border).text_color("#c084fc"))
              .when(this.toolCategory !== "ext", (tEl) => tEl.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
              .on_click((_e, cx) => { this.toolCategory = "ext"; cx.notify(); })
              .child(`技能 (${tel.extTools || 39})`))
            .child(div().px(6).py(2).rounded(3).cursor_pointer().text_size(10.5).font_medium()
              .when(this.toolCategory === "used", (tEl) => tEl.bg("#065f46").text_color("#34d399"))
              .when(this.toolCategory !== "used", (tEl) => tEl.text_color(usedSet.size > 0 ? "#34d399" : t.muted).hover((s) => s.text_color("#34d399")))
              .on_click((_e, cx) => { this.toolCategory = "used"; cx.notify(); })
              .child(`已调用 (${usedSet.size})`)))
          // 2-Column Responsive Chips Matrix: Invoked tools prominently highlighted in Emerald
          .child(h_flex().id("tools-chips-grid").w_full().flex_wrap().gap(4).pt(2)
            .children(displayedTools.map((tool) => {
              const isUsed = usedSet.has(tool.name);
              const chipColor = isUsed ? "#34d399" : (tool.type === "builtin" ? "#38bdf8" : "#c084fc");
              return h_flex().id(`tool-chip-${tool.name}`).items_center().gap(4).px(6).py(3).rounded(4)
                .bg(isUsed ? "#064e3b4d" : t.background)
                .border(1)
                .border_color(isUsed ? "#10b981" : t.border)
                .cursor_pointer()
                .hover((s) => s.border_color(isUsed ? "#34d399" : (tool.type === "builtin" ? "#38bdf8" : "#c084fc")).bg(t.hover))
                .child(svg(isUsed ? "mods/t3-sessions/icons/check.svg" : (tool.type === "builtin" ? "mods/t3-sessions/icons/terminal.svg" : "mods/t3-sessions/icons/sparkles.svg")).size(10).text_color(chipColor).flex_none())
                .child(div().text_size(10.5).font_family("JetBrains Mono")
                  .when(isUsed, (d) => d.font_bold().text_color("#34d399"))
                  .when(!isUsed, (d) => d.text_color(tool.type === "builtin" ? "#38bdf8" : t.foreground))
                  .child(tool.name))
                .when(isUsed, (elChip) => elChip.child(div().text_size(8.5).font_bold().px(3).py(0.5).rounded(2).bg("#059669").text_color("#ffffff").child("ACTIVE")));
            })))
          .when(displayedTools.length === 0, (el3) => el3.child(
            div().p(8).text_size(11).text_color(t.dim).child("没有匹配的工具或技能"))))))

      // 6. LIVE ACTIVITY FEED (Collapsible, default collapsed)
      .child(v_flex().w_full().p(8).gap(6).rounded(6).bg(t.raised).border(1).border_color(t.border)
        .child(h_flex().w_full().justify_between().items_center().cursor_pointer()
          .on_click((_e, cx) => { this.activityOpen = !this.activityOpen; cx.notify(); })
          .child(this.sectionHead("ACTIVITY", "#34d399", "mods/t3-sessions/icons/terminal.svg", t))
          .child(h_flex().gap(5).items_center().text_size(10).flex_none()
            .when((tel.readFilesCount || 0) > 0 || (tel.editedFilesCount || 0) > 0, (el) => el.child(
              div().px(5).py(1).rounded(3).bg(t.background).text_color(t.muted).child(`读 ${tel.readFilesCount || 0} · 改 ${tel.editedFilesCount || 0}`)))
            .child(div().px(5).py(1).rounded(3).bg("#064e3b66").font_bold().text_color("#34d399").child(`${tel.toolsOk || 0} ok`))
            .when((tel.toolsErr || 0) > 0, (el) => el.child(
              div().px(5).py(1).rounded(3).bg("#7f1d1d66").font_bold().text_color("#ef4444").child(`${tel.toolsErr} err`)))
            .when(Boolean(tel.avgToolMs), (el) => el.child(
              div().px(5).py(1).rounded(3).bg(t.background).font_family("JetBrains Mono").text_color(t.dim).child(`avg ${tel.avgToolMs}`)))
            .child(div().text_size(11).font_medium().text_color(t.muted)
              .child(this.activityOpen ? "▾ 收起" : "▸ 展开"))))
        .when(this.activityOpen, (el) => el.child(v_flex().w_full().gap(6).pt(2)
          .children((tel.recentTools || []).map((tool, idx) => {
            const isOk = tool.status === "ok";
            const stColor = isOk ? "#34d399" : "#fb923c";
            return v_flex().id(`tool-${idx}`).w_full().gap(2).py(5).px(7).rounded(5).bg(t.background).border(1).border_color(t.border)
              .child(h_flex().w_full().justify_between().items_center().gap(6)
                .child(h_flex().gap(6).items_center().min_w(0).flex_1()
                  .child(div().size(6).flex_none().rounded_full().bg(stColor))
                  .child(div().text_size(11).font_bold().text_color(t.foreground).truncate().child(tool.name)))
                .child(h_flex().gap(6).items_center().flex_none().font_family("JetBrains Mono").text_size(10)
                  .when(Boolean(tool.time), (el2) => el2.child(div().text_color(t.dim).child(tool.time)))
                  .child(div().px(4).py(0.5).rounded(3).bg(t.raised).text_color(stColor).child(tool.ms || "—"))))
              .when(Boolean(tool.detail), (el2) => el2.child(
                div().pl(12).text_size(10).font_family("JetBrains Mono").text_color(t.dim).truncate().child(tool.detail)));
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
      if (!this.showAll && root && s.cwd && !pathMatches(root, s.cwd)) return false;
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
            this.categoryTab(AGY, "Antigravity", "mods/t3-sessions/icons/sparkles.svg", counts[AGY], "#818cf8", t)
          ))
          .when(counts[CDX] > 0 || this.historyAgentFilter === CDX, (el) => el.child(
            this.categoryTab(CDX, "Codex", "mods/t3-sessions/icons/terminal.svg", counts[CDX], "#10b981", t)
          ))
          .when(counts[CC] > 0 || this.historyAgentFilter === CC, (el) => el.child(
            this.categoryTab(CC, "Claude", "mods/t3-sessions/icons/sparkles.svg", counts[CC], "#f59e0b", t)
          ))
          .when(counts[PI] > 0 || this.historyAgentFilter === PI, (el) => el.child(
            this.categoryTab(PI, "Pi", "mods/t3-sessions/icons/zap.svg", counts[PI], "#a855f7", t)
          ))
          .when(counts[OMP] > 0 || this.historyAgentFilter === OMP, (el) => el.child(
            this.categoryTab(OMP, "OMP", "mods/t3-sessions/icons/terminal.svg", counts[OMP], "#38bdf8", t)
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
              .children(group.items.map((s, i) => this.row(s, i, t, short, root)))
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

    return v_flex().id("t3-sessions").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      // Top Mode Switch Toolbar
      .child(h_flex().id("t3-sessions-toolbar").h(40).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(h_flex().gap(3).p(2).rounded(6).bg(t.raised)
          .child(div().id("btn-inspector").px(8).py(3).rounded(4).cursor_pointer().text_size(11.5).font_medium()
            .when(this.viewMode === "inspector", (el) => el.bg(t.background).text_color(t.foreground).border_1().border_color(t.border))
            .when(this.viewMode !== "inspector", (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) => { this.viewMode = "inspector"; setShared("t3.sessions.mode", "inspector"); this.pollTelemetry(cx); cx.notify(); })
            .child("✦ Inspector"))
          .child(div().id("btn-history").px(8).py(3).rounded(4).cursor_pointer().text_size(11.5).font_medium()
            .when(this.viewMode === "history", (el) => el.bg(t.background).text_color(t.foreground).border_1().border_color(t.border))
            .when(this.viewMode !== "history", (el) => el.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) => { this.viewMode = "history"; setShared("t3.sessions.mode", "history"); this.refreshHistory(cx); cx.notify(); })
            .child(`📜 History (${this.sessions.length})`)))
        .child(div().flex_1())
        .when(this.viewMode === "inspector", (el) => el.child(
          h_flex().gap(4).items_center().text_size(10.5).font_medium().text_color("#34d399")
            .child(div().size(6).rounded_full().bg("#34d399"))
            .child("LIVE")))
        .when(this.viewMode === "history", (el) => el
          .child(div().id("sess-root").max_w(160).truncate().text_size(11).cursor_pointer()
            .text_color(this.showAll ? t.accent : t.dim)
            .hover((s) => s.text_color(t.accent))
            .on_click((_e, cx) => { this.showAll = !this.showAll; cx.notify(); })
            .child(this.showAll ? "🌐 全局模式" : (short(root) ? "📂 " + short(root) : "当前项目")))))

      .child(this.viewMode === "inspector" ? this.renderInspector(t, short, root) : this.renderHistory(t, short, root));
  }
}
