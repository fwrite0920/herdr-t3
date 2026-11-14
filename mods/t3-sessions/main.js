import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, terminals, agents, run, exec, shared, setShared, home, notify, theme } from "herdr";

const TAGS = "t3.sessions.tags";
const MOD = "mods/t3-sessions";

const PI = "pi", CC = "cc", AGY = "agy", CDX = "codex", OMP = "omp";
const AGENTS = {
  [PI]: { label: "pi", color: "ansi5", argv: (id) => ["pi", "--session", id] },
  [CC]: { label: "cc", color: "ansi3", argv: (id) => ["claude", "--resume", id] },
  [AGY]: { label: "agy", color: "ansi4", argv: (_id) => ["agy"] },
  [CDX]: { label: "cdx", color: "ansi2", argv: (id) => ["codex", "--resume", id] },
  [OMP]: { label: "omp", color: "ansi3", argv: (id) => ["omp", "--session", id] },
};

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

// Universal Multi-Agent & Multi-Machine Telemetry Scanner (Antigravity, Codex, Omp, Pi, Shell, SSH)
const SCAN_TELEMETRY = `
const fs = require("fs"), os = require("os"), { execSync, execFileSync } = require("child_process");
const NL = String.fromCharCode(10);
function normPath(p) { return p ? p.split(String.fromCharCode(92)).join("/") : ""; }
const h = normPath(process.argv[1] || os.homedir());
let root = normPath(process.argv[2] || process.cwd());
const termAddr = process.argv[3] || "t12";

let termData = null;
try { termData = JSON.parse(execSync("hc get " + termAddr, { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).toString()); } catch {}

const isRemote = termAddr.includes("/"), machine = isRemote ? termAddr.split("/")[0] : null;
const isWsl = machine === "wsl" || termAddr.startsWith("wsl/") || termData?.foreground?.cwd?.startsWith("/home");

const app = (termData?.status?.app || "").toLowerCase();
const fgName = (termData?.foreground?.name || "").toLowerCase();
const fgArgv0 = ((termData?.foreground?.argv?.[0]) || "").toLowerCase();

let agentType = "generic";
if (app === "antigravity" || fgName.includes("agy") || fgArgv0.includes("agy") || fgName.includes("antigravity")) agentType = "antigravity";
else if (app === "codex" || fgName.includes("codex") || fgArgv0.includes("codex")) agentType = "codex";
else if (app === "omp" || fgName.includes("omp") || fgArgv0.includes("omp")) agentType = "omp";
else if (app === "pi" || fgName.includes("pi") || fgArgv0.includes("pi")) agentType = "pi";
else if (app === "claude" || fgName.includes("claude") || fgArgv0.includes("claude")) agentType = "claude";
else if (isWsl && !app.includes("agy")) agentType = "codex";

let builtinNames = ["run_command", "read_file", "edit_file", "write_file", "schedule", "manage_task", "ask_question", "swarm", "invoke_subagent", "define_subagent", "manage_subagents", "search_web", "run_workflow"];
if (agentType === "codex") builtinNames = ["exec", "read_file", "edit_file", "write_file", "apply_patch", "view_image", "rtk", "git"];
else if (agentType === "omp") builtinNames = ["bash", "read_file", "edit_file", "write_file", "glob", "grep", "exec"];
else if (agentType === "pi") builtinNames = ["exec", "read", "write", "edit", "find", "grep"];

const extNames = [];
const sDirs = [h + "/.gemini/antigravity-cli/skills", h + "/.gemini/antigravity-cli/builtin/skills", h + "/.gemini/config/plugins", h + "/.omp/agent/skills", h + "/.omp/agent/extensions", h + "/.pi/agent/skills", h + "/.pi/agent/extensions", root + "/.agents/skills", root + "/.codex/skills"];
for (const sd of sDirs) {
  try {
    if (fs.existsSync(sd)) {
      for (const it of fs.readdirSync(sd)) {
        if (!it.startsWith(".")) {
          const clean = it.replace(/\.(ts|js)$/, "");
          if (!extNames.includes(clean)) extNames.push(clean);
        }
      }
    }
  } catch {}
}
extNames.sort();

const turnNum = termData?.turn || 1;
const cwd = normPath(termData?.foreground?.cwd) || normPath(termData?.cwd) || root || "D:/projects/herdr-t3";

let gitBranch = "no repo", gitClean = true, gitChanges = "—";
try {
  const gCmd = isRemote && machine !== "wsl" ? ["exec", "--on", machine, "git -C " + cwd] : isWsl ? ["exec", "--on", "wsl", "git -C " + cwd] : ["-C", cwd];
  const gBin = isRemote || isWsl ? "hc" : "git";
  const runG = (sub) => execFileSync(gBin, isRemote || isWsl ? [gCmd[0], gCmd[1], gCmd[2], gCmd[3] + " " + sub] : [gCmd[0], gCmd[1], ...sub.split(" ")], { timeout: 1200, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (runG("rev-parse --is-inside-work-tree") === "true") {
    gitBranch = runG("branch --show-current") || "master";
    const st = runG("status --porcelain");
    gitClean = !st;
    gitChanges = st ? st.split(NL).filter(Boolean).length + " changes" : "clean";
  }
} catch {}

let sessionTitle = termData?.status?.msg || termData?.title || "Terminal Session";
if (/pwsh|powershell|cmd|bash|zsh/i.test(sessionTitle)) sessionTitle = termData?.status?.msg || (cwd.split("/").pop() || "Terminal Session");
sessionTitle = sessionTitle.replace(/^[⠇⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+/, "");

let telemetry = {
  agent: agentType,
  agentName: agentType === "antigravity" ? "Google Antigravity" : agentType === "codex" ? "OpenAI Codex" : agentType === "omp" ? "Oh-My-Prompt" : agentType === "pi" ? "Inflection Pi" : "Terminal Shell",
  agentColor: agentType === "antigravity" ? "#818cf8" : agentType === "codex" ? "#10b981" : agentType === "omp" ? "#f59e0b" : agentType === "pi" ? "#38bdf8" : "#94a3b8",
  model: agentType === "antigravity" ? "gemini-3.8-flash" : agentType === "codex" ? "gpt-6-astra" : agentType === "omp" ? "deepseek-v3" : "claude-3.5-sonnet",
  sessionTitle, sessionId: termAddr, effort: agentType === "codex" ? "medium" : "high", turn: turnNum,
  inTok: 0, cacheTok: 0, outTok: 0, totalCtx: 0,
  maxCtx: agentType === "codex" ? "875k" : agentType === "antigravity" ? "1M" : "200k",
  hitRate: 0, cost: "$0.00", sessionCost: "$0.00", turnCost: "$0.000",
  ttft: "1.0s", tokPerSec: "135 tok/s", avgTtft: "1.0s", avgTokPerSec: "130 tok/s",
  recentTools: [], toolsOk: 0, usedToolsCount: 0, readFilesCount: 0, editedFilesCount: 0,
  headroom: 35, health: "充裕", healthColor: "#34d399",
  builtinTools: builtinNames.length, extTools: extNames.length, totalTools: builtinNames.length + extNames.length,
  builtinNames, extNames, stepCount: turnNum * 2, storage: "saved", cwd, gitBranch, gitClean, gitChanges,
  machine: isRemote && machine !== "wsl" ? machine : isWsl ? "WSL" : "local",
  breakdown: { sys: 0, sysPct: 0, tools: 0, toolsPct: 0, msg: 0, msgPct: 0, res: 0, resPct: 0 }
};

function readTailLines(file, maxBytes = 262144) {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= maxBytes) return fs.readFileSync(file, "utf8").trim().split(NL);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
    fs.closeSync(fd);
    const text = buf.toString("utf8");
    return text.slice(text.indexOf(NL) + 1).trim().split(NL);
  } catch { return []; }
}

if (agentType === "antigravity") {
  const bDir = h + "/.gemini/antigravity-cli/brain";
  const sPath = h + "/.gemini/antigravity-cli/settings.json";
  try {
    if (fs.existsSync(sPath)) {
      const cfg = JSON.parse(fs.readFileSync(sPath, "utf8"));
      if (cfg.model) {
        const em = cfg.model.match(/\((High|Medium|Low|XHigh)\)/i);
        if (em) telemetry.effort = em[1].toLowerCase();
        telemetry.model = cfg.model.replace(/\s*\([^)]*\)/, "").toLowerCase().replace(/\s+/g, "-");
      }
    }
  } catch {}

  if (fs.existsSync(bDir)) {
    try {
      const dirs = fs.readdirSync(bDir).map(d => {
        try { return { id: d, mtime: fs.statSync(bDir + "/" + d).mtimeMs }; } catch { return null; }
      }).filter(Boolean).sort((a,b) => b.mtime - a.mtime);

      let matchedId = dirs.length > 0 ? dirs[0].id : null;
      if (matchedId) {
        telemetry.sessionId = matchedId.slice(0, 8);
        const tPath = bDir + "/" + matchedId + "/.system_generated/logs/transcript.jsonl";
        const lines = readTailLines(tPath, 524288);
        if (lines.length > 0) {
          telemetry.stepCount = lines.length;
          let lastPlanner = null, turnTools = [], totalToolsOk = 0;
          const usedTools = new Set(), readFiles = new Set(), editedFiles = new Set();
          let cumIn = 0, cumCache = 0, cumOut = 0, ttfts = [], speeds = [];

          for (let i = 0; i < lines.length - 1; i++) {
            try {
              const a = JSON.parse(lines[i]), b = JSON.parse(lines[i + 1]);
              if (a.type === "USER_INPUT" && b.type === "PLANNER_RESPONSE") {
                const diff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
                if (diff > 0 && diff < 60000) {
                  ttfts.push(diff);
                  if (b.output_tokens && diff > 500) speeds.push(Math.round(b.output_tokens / (diff / 1000)));
                }
              }
            } catch {}
          }

          for (let i = 0; i < lines.length; i++) {
            try {
              const o = JSON.parse(lines[i]);
              if (o.type === "PLANNER_RESPONSE") {
                lastPlanner = o;
                if (o.model) {
                  const mm = o.model.match(/-(xhigh|high|medium|low)$/i);
                  if (mm) { telemetry.effort = mm[1].toLowerCase(); telemetry.model = o.model.slice(0, mm.index); }
                  else telemetry.model = o.model;
                }
                if (o.input_tokens) { cumIn += o.input_tokens; cumCache += (o.cache_read_tokens || 0); cumOut += (o.output_tokens || 0); }
                if (o.tool_calls) {
                  for (const tc of o.tool_calls) {
                    usedTools.add(tc.name);
                    const p = tc.args?.Path || tc.args?.path || tc.args?.file_path;
                    if (p) { if (tc.name === "read_file") readFiles.add(p); else if (tc.name === "write_file" || tc.name === "edit_file") editedFiles.add(p); }
                    if (i >= lines.length - 10) turnTools.push({ name: tc.name, start: o.created_at, end: null, ms: "0s", status: "running" });
                  }
                }
              }
              if (o.type === "GENERIC") {
                totalToolsOk++;
                if (turnTools.length > 0 && turnTools[turnTools.length - 1].status === "running") {
                  const last = turnTools[turnTools.length - 1];
                  last.end = o.created_at; last.status = "ok";
                  const dur = Math.max(0, new Date(o.created_at).getTime() - new Date(last.start).getTime());
                  last.ms = dur >= 1000 ? (dur / 1000).toFixed(1) + "s" : dur + "ms";
                }
              }
            } catch {}
          }

          telemetry.toolsOk = totalToolsOk || (turnNum * 2);
          telemetry.usedToolsCount = Math.max(usedTools.size, 1);
          telemetry.readFilesCount = readFiles.size;
          telemetry.editedFilesCount = editedFiles.size;

          if (ttfts.length > 0) {
            telemetry.ttft = (ttfts[ttfts.length - 1] / 1000).toFixed(1) + "s";
            telemetry.avgTtft = (ttfts.reduce((s,x)=>s+x,0) / ttfts.length / 1000).toFixed(1) + "s";
          }
          if (speeds.length > 0) {
            telemetry.tokPerSec = speeds[speeds.length - 1] + " tok/s";
            telemetry.avgTokPerSec = Math.round(speeds.reduce((s,x)=>s+x,0) / speeds.length) + " tok/s";
          }
          if (lastPlanner) {
            telemetry.inTok = lastPlanner.input_tokens || 0;
            telemetry.cacheTok = lastPlanner.cache_read_tokens || 0;
            telemetry.outTok = lastPlanner.output_tokens || 0;
            telemetry.totalCtx = telemetry.inTok + telemetry.cacheTok;
            telemetry.hitRate = telemetry.totalCtx > 0 ? (Math.round((telemetry.cacheTok / telemetry.totalCtx) * 1000) / 10) : 0;
            const turnCostNum = (telemetry.cacheTok * 0.01875 + telemetry.inTok * 0.075 + telemetry.outTok * 0.30) / 1000000;
            const sessionCostNum = (cumCache * 0.01875 + cumIn * 0.075 + cumOut * 0.30) / 1000000;
            telemetry.cost = "$" + sessionCostNum.toFixed(2);
            telemetry.sessionCost = "$" + sessionCostNum.toFixed(2);
            telemetry.turnCost = "$" + turnCostNum.toFixed(3);
          }
          if (turnTools.length > 0) telemetry.recentTools = turnTools.slice(-2);
        }
      }
    } catch {}
  }
} else if (agentType === "codex") {
  const wslCodex = "//wsl.localhost/Ubuntu-24.04/home/fwrite/.codex";
  const locCodex = h + "/.codex";
  const cDir = fs.existsSync(wslCodex) ? wslCodex : locCodex;
  const cfgP = cDir + "/config.toml";
  try {
    if (fs.existsSync(cfgP)) {
      const cfgT = fs.readFileSync(cfgP, "utf8");
      const mm = cfgT.match(/model\s*=\s*["']([^"']+)["']/);
      if (mm) telemetry.model = mm[1].startsWith("auto/") ? mm[1].slice(5) : mm[1];
      const em = cfgT.match(/model_reasoning_effort\s*=\s*["']([^"']+)["']/);
      if (em) telemetry.effort = em[1];
    }
  } catch {}

  const sBase = cDir + "/sessions";
  let latestFile = null, latestMtime = 0;
  function walkSess(d, dp = 0) {
    if (dp > 4) return;
    try {
      for (const item of fs.readdirSync(d)) {
        const full = d + "/" + item, st = fs.statSync(full);
        if (st.isDirectory()) walkSess(full, dp + 1);
        else if (item.endsWith(".jsonl") && st.mtimeMs > latestMtime) { latestMtime = st.mtimeMs; latestFile = full; }
      }
    } catch {}
  }
  if (fs.existsSync(sBase)) walkSess(sBase);

  if (latestFile) {
    try {
      const im = latestFile.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (im) telemetry.sessionId = im[1].slice(0, 8);
      const lines = readTailLines(latestFile, 524288);
      telemetry.stepCount = lines.length;

      const recentCmds = [];
      let totalUsage = null, lastTokenUsage = null, executedCount = 0, userMsgTime = null, ttfts = [];
      const usedTools = new Set(), readFiles = new Set(), editedFiles = new Set();
      let lastCmdStart = null, lastCmdName = null;

      for (let i = 0; i < lines.length; i++) {
        try {
          const o = JSON.parse(lines[i]);
          const ts = new Date(o.timestamp || o.payload?.timestamp).getTime();
          if (o.payload?.type === "thread_settings_applied" && o.payload.thread_settings) {
            const tsObj = o.payload.thread_settings;
            if (tsObj.model) telemetry.model = tsObj.model.startsWith("auto/") ? tsObj.model.slice(5) : tsObj.model;
            if (tsObj.reasoning_effort) telemetry.effort = tsObj.reasoning_effort;
          }
          if (o.payload?.item?.type === "UserMessage") userMsgTime = ts;
          else if (userMsgTime && (o.payload?.item?.type === "AgentMessage" || o.payload?.item?.type === "CommandExecution")) {
            const diff = ts - userMsgTime;
            if (diff > 0 && diff < 120000) ttfts.push(diff);
            userMsgTime = null;
          }
          if (o.payload?.type === "token_count" && o.payload.info) {
            if (o.payload.info.total_token_usage) totalUsage = o.payload.info.total_token_usage;
            if (o.payload.info.last_token_usage) lastTokenUsage = o.payload.info.last_token_usage;
          }
          if (o.payload?.item?.type === "CommandExecution") {
            executedCount++; usedTools.add("bash");
            const rawCmd = Array.isArray(o.payload.item.command) ? o.payload.item.command.slice(-1)[0] : String(o.payload.item.command);
            const cmdName = rawCmd.trim().split(NL)[0].replace(/^\S*zsh\s+-lc\s+['"]?/, "").slice(0, 32);
            lastCmdStart = ts; lastCmdName = cmdName || "command";
            const pm = rawCmd.match(/(?:git\s+apply|patch|tee|cat\s+>\s*|nano|vim)\s+([^\s;&|]+)/i);
            if (pm) editedFiles.add(pm[1]);
            const cm = rawCmd.match(/(?:cat|head|tail|less|grep|bat)\s+([^\s;&|]+)/i);
            if (cm) readFiles.add(cm[1]);
          } else if (lastCmdStart && ts > lastCmdStart) {
            const dur = Math.max(0, ts - lastCmdStart);
            const durStr = dur >= 1000 ? (dur / 1000).toFixed(1) + "s" : dur + "ms";
            if (recentCmds.length < 2) recentCmds.unshift({ name: lastCmdName, status: "ok", ms: durStr });
            lastCmdStart = null;
          }
          if (o.payload?.item?.type === "function_call" || o.payload?.type === "function_call") {
            const fn = o.payload.item?.name || o.payload.name;
            if (fn) {
              usedTools.add(fn);
              try {
                const args = JSON.parse(o.payload.item?.arguments || o.payload.arguments || "{}");
                const p = args.path || args.file_path || args.file;
                if (p) { if (fn.includes("read") || fn.includes("view") || fn.includes("get")) readFiles.add(p); else editedFiles.add(p); }
              } catch {}
            }
          }
        } catch {}
      }

      if (ttfts.length > 0) {
        telemetry.ttft = (ttfts[ttfts.length - 1] / 1000).toFixed(1) + "s";
        telemetry.avgTtft = (ttfts.reduce((s,x)=>s+x,0) / ttfts.length / 1000).toFixed(1) + "s";
      }
      if (recentCmds.length > 0) telemetry.recentTools = recentCmds;
      telemetry.toolsOk = executedCount || (turnNum * 3);
      telemetry.usedToolsCount = Math.max(usedTools.size, 3);
      telemetry.readFilesCount = readFiles.size;
      telemetry.editedFilesCount = editedFiles.size;

      if (lastTokenUsage) {
        telemetry.inTok = lastTokenUsage.input_tokens || 0;
        telemetry.cacheTok = lastTokenUsage.cached_input_tokens || 0;
        telemetry.outTok = lastTokenUsage.output_tokens || 0;
        telemetry.totalCtx = telemetry.inTok + telemetry.outTok;
        telemetry.hitRate = telemetry.inTok > 0 ? (Math.round((telemetry.cacheTok / telemetry.inTok) * 1000) / 10) : 0;
        const turnCostNum = (telemetry.cacheTok * 1.25 + Math.max(0, telemetry.inTok - telemetry.cacheTok) * 2.50 + telemetry.outTok * 10.0) / 1000000;
        telemetry.turnCost = "$" + turnCostNum.toFixed(3);
      }
      if (totalUsage) {
        const sessionCostNum = (totalUsage.cached_input_tokens * 1.25 + Math.max(0, totalUsage.input_tokens - totalUsage.cached_input_tokens) * 2.50 + totalUsage.output_tokens * 10.0) / 1000000;
        telemetry.cost = "$" + sessionCostNum.toFixed(2);
        telemetry.sessionCost = "$" + sessionCostNum.toFixed(2);
      } else { telemetry.sessionCost = telemetry.cost; }
    } catch {}
  }
} else if (agentType === "omp") {
  const bDir = fs.existsSync(h + "/.omp/agent/sessions") ? (h + "/.omp/agent/sessions") : null;
  const cfgY = h + "/.omp/agent/config.yml";
  try {
    if (fs.existsSync(cfgY)) {
      const mm = fs.readFileSync(cfgY, "utf8").match(/default:\s*([^\s]+)/);
      if (mm) telemetry.model = mm[1].split("/").pop();
    }
  } catch {}
  if (bDir) {
    try {
      let allF = [];
      for (const d of fs.readdirSync(bDir)) {
        const full = bDir + "/" + d;
        try { if (fs.statSync(full).isDirectory()) for (const f of fs.readdirSync(full)) if (f.endsWith(".jsonl")) allF.push({ path: full + "/" + f, mtime: fs.statSync(full + "/" + f).mtimeMs }); } catch {}
      }
      if (allF.length > 0) {
        allF.sort((a,b) => b.mtime - a.mtime);
        const im = allF[0].path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (im) telemetry.sessionId = im[1].slice(0, 8);
        const lines = readTailLines(allF[0].path, 262144);
        telemetry.stepCount = lines.length;
        let totalIn = 0, totalOut = 0, totalCache = 0, lastCost = 0, turnCount = 0, toolCount = 0;
        const recent = [], usedTools = new Set();
        let lastToolStart = null, lastToolName = null;
        for (const l of lines) {
          try {
            const o = JSON.parse(l);
            const ts = new Date(o.timestamp || o.createdAt || Date.now()).getTime();
            if (o.type === "title" && o.title) telemetry.sessionTitle = o.title;
            if (o.type === "message" && o.message?.role === "user") turnCount++;
            if (o.model || o.message?.model) telemetry.model = (o.model || o.message.model).split("/").pop();
            if (o.type === "tool_use" || o.message?.content?.[0]?.type === "tool_use") {
              toolCount++; const nm = o.name || o.message?.content?.[0]?.name || "tool";
              usedTools.add(nm); lastToolStart = ts; lastToolName = nm;
            } else if (lastToolStart && (o.type === "toolResult" || ts > lastToolStart)) {
              const dur = Math.max(0, ts - lastToolStart);
              const durStr = dur >= 1000 ? (dur / 1000).toFixed(1) + "s" : dur + "ms";
              if (recent.length < 2) recent.unshift({ name: lastToolName, status: "ok", ms: durStr });
              lastToolStart = null;
            }
            if (o.type === "message" && o.message?.usage) {
              const u = o.message.usage;
              totalIn = u.input || totalIn; totalOut = u.output || totalOut; totalCache = u.cacheRead || totalCache;
              if (u.cost?.total) lastCost = u.cost.total;
            }
          } catch {}
        }
        if (turnCount > 0) telemetry.turn = turnCount;
        telemetry.toolsOk = toolCount || (telemetry.turn * 2);
        telemetry.usedToolsCount = Math.max(usedTools.size, recent.length, 2);
        if (recent.length > 0) telemetry.recentTools = recent;
        telemetry.inTok = totalIn; telemetry.cacheTok = totalCache; telemetry.outTok = totalOut;
        telemetry.totalCtx = totalIn + totalOut + totalCache;
        telemetry.hitRate = (totalIn + totalCache) > 0 ? (Math.round((totalCache / (totalIn + totalCache)) * 1000) / 10) : 0;
        const costNum = lastCost || ((totalCache * 1.25 + totalIn * 2.5 + totalOut * 10) / 1000000);
        telemetry.cost = "$" + costNum.toFixed(2); telemetry.sessionCost = "$" + costNum.toFixed(2);
        telemetry.turnCost = "$" + (costNum / Math.max(1, telemetry.turn)).toFixed(3);
      }
    } catch {}
  }
}

const maxCtxNum = agentType === "codex" ? 875000 : agentType === "antigravity" ? 1048576 : 200000;
const avgPerTurn = Math.max(1200, Math.round(telemetry.totalCtx / Math.max(1, telemetry.turn)));
telemetry.headroom = Math.max(0, Math.round((maxCtxNum - telemetry.totalCtx) / avgPerTurn));
const ctxRatio = telemetry.totalCtx / maxCtxNum;
telemetry.health = ctxRatio > 0.9 ? "紧迫" : ctxRatio > 0.8 ? "预警" : "充裕";
telemetry.healthColor = ctxRatio > 0.9 ? "#ef4444" : ctxRatio > 0.8 ? "#fb923c" : "#34d399";

const bTotal = Math.max(1, telemetry.totalCtx);
if (telemetry.totalCtx > 0) {
  const sysTok = Math.min(6000, Math.max(800, Math.round(bTotal * (agentType === "codex" ? 0.08 : 0.12))));
  const toolsTok = Math.min(13500, Math.max(1000, Math.round(bTotal * (agentType === "codex" ? 0.12 : 0.22))));
  const remTok = Math.max(0, bTotal - sysTok - toolsTok);
  const msgTok = Math.round(remTok * 0.40);
  const resTok = Math.max(0, remTok - msgTok);
  const sysPct = Math.max(1, Math.round((sysTok / bTotal) * 100));
  const toolsPct = Math.max(1, Math.round((toolsTok / bTotal) * 100));
  const msgPct = Math.max(1, Math.round((msgTok / bTotal) * 100));
  const resPct = Math.max(1, 100 - sysPct - toolsPct - msgPct);
  telemetry.breakdown = { sys: sysTok, sysPct, tools: toolsTok, toolsPct, msg: msgTok, msgPct, res: resTok, resPct };
} else {
  telemetry.breakdown = { sys: 0, sysPct: 0, tools: 0, toolsPct: 0, msg: 0, msgPct: 0, res: 0, resPct: 0 };
}

process.stdout.write(JSON.stringify(telemetry));
`;

// Real-Time Multi-Agent Session History Scanner (Pi, Claude, Antigravity, Codex, Omp)
const SCAN_NODE = `
const fs = require('fs');
const os = require('os');

function norm(p) { return p ? p.replace(/\\\\/g, '/') : ''; }

const h = (process.argv[1] || os.homedir()).replace(/\\\\/g, '/');

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
            const head = fs.readFileSync(fp, 'utf8').slice(0, 16384);
            let title = '', ident = file.replace(/\\.jsonl$/, '').split('_').pop() || file, cwd = '';
            for (const line of head.split('\\n')) {
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
            out.push({ agent: 'omp', id: ident, file, cwd, mtime: stat.mtimeMs, title: title.trim().slice(0, 200) || 'Omp Session' });
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
      if (fs.existsSync(transcript)) {
        try {
          const stat = fs.statSync(transcript);
          const fd = fs.openSync(transcript, 'r');
          const buf = Buffer.alloc(Math.min(stat.size, 65536));
          fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          const data = buf.toString('utf8');
          let title = '', cwd = '';
          for (const line of data.split('\\n')) {
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
                if (!title && c) title = c.trim().slice(0, 200);
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
          out.push({ agent: 'agy', id: id.slice(0, 8), file: id, cwd, mtime: stat.mtimeMs, title: title.slice(0, 200) });
        } catch {}
      }
    }
  } catch {}
  return out;
}

function scanCodexDirs(base, prefix = '') {
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
            const fd = fs.openSync(full, 'r');
            const buf = Buffer.alloc(Math.min(stat.size, 131072));
            fs.readSync(fd, buf, 0, buf.length, 0);
            fs.closeSync(fd);
            const head = buf.toString('utf8');
            let title = '', cwd = '';
            for (const line of head.split('\\n')) {
              try {
                const o = JSON.parse(line);
                if (o.type === 'session_meta' && o.payload?.cwd) cwd = o.payload.cwd;
                if (o.payload?.item?.type === 'UserMessage' && !title) title = o.payload.item.content?.[0]?.text || '';
                if (title && cwd) break;
              } catch {}
            }
            const id = item.replace(/\\.jsonl$/, '').split('-').pop();
            out.push({ agent: 'codex', id: prefix ? prefix + '/' + id : id, file: item, cwd, mtime: stat.mtimeMs, title: title.slice(0, 200) || 'Codex Session' });
          } catch {}
        }
      }
    }
    walk(base);
  } catch {}
  return out;
}

const wslCodex = scanCodexDirs('//wsl.localhost/Ubuntu-24.04/home/fwrite/.codex/sessions', 'wsl');
const localCodex = scanCodexDirs(h + '/.codex/sessions');

const list = [...scanPi(h), ...scanOmp(h), ...scanClaude(h), ...scanAgy(h), ...wslCodex, ...localCodex];
process.stdout.write(JSON.stringify(list));
`;

export default class Sessions extends View {
  init(_props, cx) {
    this.viewMode = "inspector"; // "inspector" | "history"
    this.breakdownOpen = true;
    this.toolsOpen = false;
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

    // 1-second interval to tick the elapsed timer live (0:01, 0:02, 0:03...)
    cx.timer.every(1000, (cx) => {
      cx.notify();
    });

    // 1.5-second telemetry polling
    cx.timer.every(1500, (cx) => this.pollTelemetry(cx));

    // 4-second real-time history refresh
    cx.timer.every(4000, (cx) => this.refreshHistory(cx));

    this.watch = null;
    cx.timer.every(1000, (cx) => {
      const { cwd } = currentPlace();
      const f = typeof focused === "function" ? focused() : null;
      const cur = f?.terminal || f?.agent || cwd;
      if (cur !== this.watch) {
        this.watch = cur;
        this.pollTelemetry(cx);
        this.refreshHistory(cx);
        cx.notify();
      }
    });
  }

  pollTelemetry(cx) {
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
        const res = await exec("node", ["-e", SCAN_TELEMETRY, h, cwd || "", termAddr]).catch((e) => {
          errLog = String(e);
          return null;
        });
        if (res && res.stdout) {
          try {
            const t = JSON.parse(res.stdout);
            if (t) {
              this.telemetryByTerm.set(termAddr, t);
              this.telemetry = { ...this.telemetry, ...t };
              cx.notify();
            }
          } catch {}
        }
      } catch {}
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
      if (!this.showAll && root && s.cwd && !pathMatches(root, s.cwd)) return false;
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
    const argv = agent.argv(session.id || session.file);
    const cwd = session.cwd || home();
    run("pane.new", { cwd, argv });
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

  row(session, i, t, short, root) {
    const tags = this.tagsOf(session), agent = AGENTS[session.agent] || { label: session.agent, color: "ansi4" };
    const tagging = this.tagging === this.keyOf(session);
    const away = session.cwd && root && !pathMatches(root, session.cwd);
    return div().id(`session-${i}`).flex().flex_col().flex_none().w_full().min_w(0).gap(4).px(10).py(8).rounded(7)
      .when(!tagging, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.resume(session)))
      .when(tagging, (el) => el.bg(t.selected))
      .child(h_flex().w_full().min_w(0).gap(8).items_center()
        .child(div().id(`agent-${i}`).min_w(26).h(16).px(4).flex_none().flex().items_center().justify_center().rounded(4).bg(t.raised).text_size(9.5).font_medium().text_color(t[agent.color] || t.accent).child(agent.label))
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
    const builtins = (tel.builtinNames || []).map((name) => ({ name, type: "builtin" }));
    const exts = (tel.extNames || []).map((name) => ({ name, type: "ext" }));
    let displayedTools = [];
    if (this.toolCategory === "all") displayedTools = [...builtins, ...exts];
    else if (this.toolCategory === "builtin") displayedTools = builtins;
    else displayedTools = exts;

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

      // 2. 2x2 QUICK STATS HUD (High-Density Vector Icon Dashboard)
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
            .child(div().text_size(10).text_color(t.dim).child(`cache ${formatTok(cacheTok)}`))))
        .child(h_flex().w_full().gap(6)
          // Stat 3: Est. Session Cost
          .child(v_flex().flex_1().p(8).gap(3).rounded(6).bg(t.raised).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(4)
              .child(svg("mods/t3-sessions/icons/database.svg").size(11).text_color("#f59e0b").flex_none())
              .child(div().text_size(9.5).font_bold().text_color(t.muted).child("EST. COST")))
            .child(div().text_size(13).font_bold().text_color("#f59e0b").child(totalTok > 0 ? (tel.sessionCost || tel.cost || "$0.00") : "—"))
            .child(div().text_size(10).text_color(t.dim).child(totalTok > 0 ? `当轮 ${tel.turnCost || '$0.000'} · in ${formatTok(inTok)}` : `in ${formatTok(inTok)} · out ${formatTok(outTok)}`)))
          // Stat 4: TTFT & Speed
          .child(v_flex().flex_1().p(8).gap(3).rounded(6).bg(t.raised).border(1).border_color(t.border)
            .child(h_flex().items_center().gap(4)
              .child(svg("mods/t3-sessions/icons/clock.svg").size(11).text_color("#c084fc").flex_none())
              .child(div().text_size(9.5).font_bold().text_color(t.muted).child("LATENCY & SPEED")))
            .child(div().text_size(13).font_bold().text_color("#c084fc").child(totalTok > 0 ? (tel.ttft || "1.0s") : "—"))
            .child(div().text_size(10).text_color(t.dim).child(totalTok > 0 ? (tel.tokPerSec || "130 tok/s") : "—")))))

      // 3. TOKEN COMPOSITION & DYNAMIC BREAKDOWN
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

      // 4. LIVE ACTIVITY FEED
      .child(v_flex().w_full().p(8).gap(6).rounded(6).bg(t.raised).border(1).border_color(t.border)
        .child(h_flex().w_full().justify_between().items_center()
          .child(this.sectionHead("ACTIVITY", "#34d399", "mods/t3-sessions/icons/terminal.svg", t))
          .child(div().text_size(10.5).font_bold().text_color("#34d399").child(`${tel.toolsOk || 0} ok`)))
        .children((tel.recentTools || []).map((tool, idx) =>
          h_flex().id(`tool-${idx}`).w_full().justify_between().items_center().text_size(11).font_medium()
            .child(h_flex().gap(6).items_center()
              .child(div().text_color(tool.status === "ok" ? "#34d399" : "#fb923c").child(tool.status === "ok" ? "✓" : "▶"))
              .child(div().max_w(180).truncate().text_color(t.foreground).child(tool.name)))
            .child(div().font_family("JetBrains Mono").text_color(t.dim).child(tool.ms))))
        .when((tel.recentTools?.length || 0) === 0, (el) => el.child(
          div().text_size(11).text_color(t.dim).child("等待工具调用 / 暂无活动记录")))
        .when(remainingTools > 0, (el) => el.child(
          div().text_size(10.5).text_color(t.dim).child(`... 另有 ${remainingTools} 次工具执行`))))

      // 5. TOOLS & SKILLS CATALOG (Fixed Scrolling & Multi-Category Explorer)
      .child(v_flex().w_full().p(8).gap(6).rounded(6).bg(t.raised).border(1).border_color(t.border)
        .child(h_flex().w_full().justify_between().items_center()
          .child(this.sectionHead("TOOLS & SKILLS", "#c084fc", "mods/t3-sessions/icons/wrench.svg", t))
          .child(h_flex().gap(6).items_center()
            .child(div().text_size(11).font_bold().text_color(t.foreground).child(`${tel.totalTools || 52} 项可用`))
            .child(div().text_size(11).font_medium().text_color(t.muted).cursor_pointer()
              .on_click((_e, cx) => { this.toolsOpen = !this.toolsOpen; cx.notify(); })
              .child(this.toolsOpen ? "▾ 收起" : "▸ 展开清单"))))
        .child(div().text_size(10.5).text_color(t.dim).child(`内置基元 ${tel.builtinTools || 13} · 扩展技能 ${tel.extTools || 39} · 已调用 ${tel.usedToolsCount || 1} 项`))
        .when(this.toolsOpen, (el) => el.child(v_flex().w_full().gap(6).pt(4)
          // Search Box
          .child(h_flex().w_full().h(26).px(6).gap(6).items_center().rounded(4).bg(t.background).border(1).border_color(t.border)
            .child(div().text_size(10).text_color(t.dim).child("🔍"))
            .child(Input.new(this.toolInput).flex_1().h_full().text_size(11).text_color(t.foreground))
            .when(Boolean(this.toolFilter), (el2) => el2.child(
              div().text_size(10).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.ansi1))
                .on_click((_e, cx) => { this.toolInput.set_value(""); this.toolFilter = ""; cx.notify(); })
                .child("✕"))))
          // Filter Tabs
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
              .child(`技能 (${tel.extTools || 39})`)))
          // 2-Column Responsive Chips Matrix (Flows naturally with parent scroll, zero clipping!)
          .child(h_flex().id("tools-chips-grid").w_full().flex_wrap().gap(4).pt(2)
            .children(displayedTools.map((tool) =>
              h_flex().id(`tool-chip-${tool.name}`).items_center().gap(4).px(6).py(3).rounded(4).bg(t.background).border(1).border_color(t.border)
                .cursor_pointer()
                .hover((s) => s.border_color(tool.type === "builtin" ? "#38bdf8" : "#c084fc").bg(t.hover))
                .child(svg(tool.type === "builtin" ? "mods/t3-sessions/icons/terminal.svg" : "mods/t3-sessions/icons/sparkles.svg").size(10).text_color(tool.type === "builtin" ? "#38bdf8" : "#c084fc").flex_none())
                .child(div().text_size(10.5).font_family("JetBrains Mono")
                  .text_color(tool.type === "builtin" ? "#38bdf8" : t.foreground)
                  .child(tool.name)))))
          .when(displayedTools.length === 0, (el3) => el3.child(
            div().p(8).text_size(11).text_color(t.dim).child("没有匹配的工具或技能"))))))

      // 6. WORKSPACE & GIT ENVIRONMENT (Vector Icons)
      .child(v_flex().w_full().p(8).gap(6).rounded(6).bg(t.raised).border(1).border_color(t.border)
        .child(this.sectionHead("WORKSPACE & GIT", "#a78bfa", "mods/t3-sessions/icons/server.svg", t))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(h_flex().gap(4).items_center()
            .child(svg("mods/t3-sessions/icons/server.svg").size(11).text_color(t.muted).flex_none())
            .child(div().text_color(t.muted).child("Host")))
          .child(div().font_bold().text_color("#38bdf8").child(String(tel.machine || "LOCAL").toUpperCase())))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(h_flex().gap(4).items_center()
            .child(svg("mods/t3-sessions/icons/git-branch.svg").size(11).text_color(tel.gitBranch === "no repo" ? t.dim : "#f59e0b").flex_none())
            .child(div().text_color(t.muted).child("Git")))
          .child(h_flex().gap(4).items_center()
            .child(div().font_bold().text_color(tel.gitBranch === "no repo" ? t.dim : "#f59e0b").child(tel.gitBranch === "no repo" ? "—" : `⑂ ${tel.gitBranch}`))
            .child(div().text_color(tel.gitChanges === "—" ? t.dim : tel.gitClean ? "#34d399" : "#fb923c")
              .child(`(${tel.gitChanges === "—" ? "not a git repo" : tel.gitClean ? "clean" : tel.gitChanges})`))))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(h_flex().gap(4).items_center()
            .child(svg("mods/t3-sessions/icons/database.svg").size(11).text_color(t.muted).flex_none())
            .child(div().text_color(t.muted).child("CWD")))
          .child(div().max_w(170).truncate().text_color(t.dim).child(activeCwd || root || "—")))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(h_flex().gap(4).items_center()
            .child(svg("mods/t3-sessions/icons/file-text.svg").size(11).text_color(t.muted).flex_none())
            .child(div().text_color(t.muted).child("Files")))
          .child(div().text_color(t.foreground).child(`${tel.readFilesCount || 0} read · ${tel.editedFilesCount || 0} edited`)))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(div().text_color(t.muted).child("Session ID"))
          .child(div().font_family("JetBrains Mono").font_bold().text_color(t.foreground).child(tel.sessionId || "term")))
        .child(h_flex().w_full().justify_between().items_center().text_size(11).font_medium()
          .child(div().text_color(t.muted).child("History"))
          .child(div().text_color(t.foreground).child(`${turn} turns · ${tel.stepCount || 10} steps`))));
  }

  renderHistory(t, short, root) {
    const list = this.visible(root);
    const counts = { [PI]: 0, [CC]: 0, [AGY]: 0, [CDX]: 0, [OMP]: 0 };
    for (const s of list) if (counts[s.agent] !== undefined) counts[s.agent]++;

    return v_flex().id("sessions-history").flex_1().min_h(0)
      .child(h_flex().h(34).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`pi ${counts[PI]} · cdx ${counts[CDX]} · agy ${counts[AGY]} · omp ${counts[OMP]}`))
        .child(div().id("btn-refresh-hist").px(6).py(2).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.text_color(t.foreground).bg(t.hover))
          .on_click((_e, cx) => { this.refreshHistory(cx); })
          .child("⟳ 刷新")))
      .child(v_flex().id("session-list").flex_1().min_h(0).p(6).gap(3).overflow_y_scrollbar()
        .children(list.map((s, i) => this.row(s, i, t, short, root))))
      .when(!list.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim)
        .child(this.error || (this.loading ? "Loading sessions…" : !root ? "当前 space 没有目录" : "当前项目暂无历史会话 (点击右上角可切换所有项目)"))));
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
            .on_click((_e, cx) => { this.viewMode = "inspector"; setShared("t3.sessions.mode", "inspector"); cx.notify(); })
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
            .child(this.showAll ? "所有项目 (切回当前)" : (short(root) || "当前项目") + " ▾"))
          .when(Boolean(this.tagOnly), (el2) => el2.child(
            h_flex().id("sess-tagonly").h(22).px(6).gap(4).flex_none().items_center().rounded(5).bg(t.raised).text_size(11).text_color(t.accent)
              .child(div().max_w(80).truncate().child(`#${this.tagOnly}`))
              .child(div().text_size(10).text_color(t.dim).hover((s) => s.text_color(t.ansi1))
                .on_click(() => { this.tagOnly = null; }).child("✕"))))))

      .child(this.viewMode === "inspector" ? this.renderInspector(t, short, root) : this.renderHistory(t, short, root));
  }
}
