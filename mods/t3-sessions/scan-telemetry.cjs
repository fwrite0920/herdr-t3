const fs = require("fs"), os = require("os"), { execSync, execFileSync } = require("child_process");
const NL = String.fromCharCode(10);
function normPath(p) { return p ? p.split(String.fromCharCode(92)).join("/") : ""; }
const h = normPath(process.argv[2] || os.homedir());
let root = normPath(process.argv[3] || process.cwd());
const termAddr = process.argv[4] || "t12";

let termData = null;
try { termData = JSON.parse(execSync("hc get " + termAddr, { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).toString()); } catch {}

const isRemote = termAddr.includes("/"), machine = isRemote ? termAddr.split("/")[0] : null;
const isWsl = machine === "wsl" || termAddr.startsWith("wsl/") || termData?.foreground?.cwd?.startsWith("/home");

function getWslDistros() {
  if (process.platform !== "win32") return [];
  try {
    const raw = execFileSync("wsl.exe", ["-l", "-q"], { timeout: 1200, stdio: ["ignore", "pipe", "ignore"] });
    return raw.toString("utf16le").replace(/\0/g, "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return ["Ubuntu-24.04", "Ubuntu", "Debian"]; }
}

const turnNum = termData?.turn || 1;
const cwd = normPath(termData?.foreground?.cwd) || normPath(termData?.cwd) || root || h;

let wslPrefix = "", wslHome = "";
if (isWsl && process.platform === "win32") {
  const userHint = (cwd.match(/^\/home\/([^/]+)/) || [])[1] || "";
  for (const distro of getWslDistros()) {
    const base = "//wsl.localhost/" + distro;
    if (userHint && fs.existsSync(base + "/home/" + userHint)) {
      wslPrefix = base; wslHome = base + "/home/" + userHint; break;
    }
    try {
      const users = fs.readdirSync(base + "/home");
      if (users.length > 0) { wslPrefix = base; wslHome = base + "/home/" + users[0]; break; }
    } catch {}
  }
}
const effectiveHome = wslHome || h;
const effectiveCwd = (isWsl && wslPrefix && cwd.startsWith("/")) ? (wslPrefix + cwd) : cwd;

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
if (agentType === "codex") builtinNames = ["exec_command", "write_stdin", "apply_patch", "read_file", "edit_file", "write_file", "view_image", "spawn_agent", "wait_agent"];
else if (agentType === "omp") builtinNames = ["bash", "read_file", "edit_file", "write_file", "glob", "grep", "exec"];
else if (agentType === "pi") builtinNames = ["exec", "read", "write", "edit", "find", "grep"];

const extNames = [];
const sDirs = isWsl
  ? [effectiveHome + "/.codex/skills", effectiveHome + "/.agents/skills", effectiveHome + "/.omp/agent/skills", effectiveHome + "/.pi/agent/skills", effectiveCwd + "/.agents/skills", effectiveCwd + "/.codex/skills"]
  : [h + "/.gemini/antigravity-cli/skills", h + "/.gemini/antigravity-cli/builtin/skills", h + "/.gemini/config/plugins", h + "/.omp/agent/skills", h + "/.omp/agent/extensions", h + "/.pi/agent/skills", h + "/.pi/agent/extensions", root + "/.agents/skills", root + "/.codex/skills"];
for (const sd of sDirs) {
  try {
    for (const it of fs.readdirSync(sd)) {
      if (!it.startsWith(".")) {
        const clean = it.replace(/\.(ts|js)$/, "");
        if (!extNames.includes(clean)) extNames.push(clean);
      }
    }
  } catch {}
}
extNames.sort();

const rulesLoaded = [];
for (const [label, fp] of [
  ["AGENTS.md", effectiveCwd + "/AGENTS.md"],
  ["CLAUDE.md", effectiveCwd + "/CLAUDE.md"],
  ["GEMINI.md", effectiveCwd + "/GEMINI.md"],
  ["codex.toml", effectiveHome + "/.codex/config.toml"],
  [".codex/config", effectiveCwd + "/.codex/config.toml"]
]) {
  try { if (fs.existsSync(fp)) rulesLoaded.push(label); } catch {}
}

let sysChars = (builtinNames.length + extNames.length) * 180, toolsChars = 0, msgChars = 0, resChars = 0;

let gitBranch = "no repo", gitClean = true, gitChanges = "—";
try {
  const gCmd = isRemote && machine !== "wsl" ? ["exec", "--on", machine, "git -C " + cwd] : isWsl ? ["exec", "--on", "wsl", "git -C " + cwd] : ["-C", cwd];
  const gBin = isRemote || isWsl ? "hc" : "git";
  const args = isRemote || isWsl ? [gCmd[0], gCmd[1], gCmd[2], gCmd[3] + " status --porcelain -b"] : [gCmd[0], gCmd[1], "status", "--porcelain", "-b"];
  const out = execFileSync(gBin, args, { timeout: 1200, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (out) {
    const lines = out.split(NL);
    const bLine = lines[0] || "";
    const cleaned = bLine.replace(/^##\s*/, "").split("...")[0].split(/\s+/)[0];
    gitBranch = cleaned || "master";
    const changed = lines.slice(1).filter(Boolean);
    gitClean = changed.length === 0;
    gitChanges = changed.length > 0 ? changed.length + " changes" : "clean";
  }
} catch {}

let sessionTitle = termData?.status?.msg || termData?.title || "Terminal Session";
if (/pwsh|powershell|cmd|bash|zsh/i.test(sessionTitle)) sessionTitle = termData?.status?.msg || (cwd.split("/").pop() || "Terminal Session");
sessionTitle = sessionTitle.replace(/^[⠇⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏s]+/, "");

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
  recentTools: [], toolsOk: 0, toolsErr: 0, avgToolMs: "", toolsPerTurn: "0.0",
  usedToolsCount: 0, usedToolNames: [], readFilesCount: 0, editedFilesCount: 0,
  reasoningTok: 0, cacheSaved: "", provider: "", sandboxPolicy: "", approvalPolicy: "", rulesLoaded,
  headroom: 35, health: "充裕", healthColor: "#34d399",
  builtinTools: builtinNames.length, extTools: extNames.length, totalTools: builtinNames.length + extNames.length,
  builtinNames, extNames, stepCount: turnNum * 2, storage: "saved", cwd, gitBranch, gitClean, gitChanges,
  machine: isRemote && machine !== "wsl" ? machine : isWsl ? "WSL" : "local",
  breakdown: { sys: 0, sysPct: 0, tools: 0, toolsPct: 0, msg: 0, msgPct: 0, res: 0, resPct: 0 }
};

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

function toolDetail(args) {
  if (!args || typeof args !== "object") return "";
  const raw = args.Path || args.path || args.file_path || args.CommandLine || args.command || args.cmd || args.query || args.url || args.Pattern || args.pattern || args.target || "";
  if (!raw) return "";
  const s = String(raw).replace(/\\/g, "/").trim();
  if (s.includes("/") && !s.includes(" ")) return s.split("/").slice(-2).join("/");
  return s.slice(0, 48);
}

function readTailLines(file, maxBytes = 131072) {
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
        const em = cfg.model.match(/((High|Medium|Low|XHigh))/i);
        if (em) telemetry.effort = em[1].toLowerCase();
        telemetry.model = cfg.model.replace(/s*([^)]*)/, "").toLowerCase().replace(/s+/g, "-");
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
        const rawLines = readTailLines(tPath, 131072);
        if (rawLines.length > 0) {
          telemetry.stepCount = rawLines.length;
          const lines = [];
          for (const l of rawLines) {
            if (!l.trim()) continue;
            try { lines.push(JSON.parse(l)); } catch {}
          }
          let lastPlanner = null, turnTools = [], totalToolsOk = 0;
          const usedTools = new Set(), readFiles = new Set(), editedFiles = new Set();
          let cumIn = 0, cumCache = 0, cumOut = 0, ttfts = [], speeds = [];

          for (let i = 0; i < lines.length - 1; i++) {
            const a = lines[i], b = lines[i + 1];
            if (a.type === "USER_INPUT" && b.type === "PLANNER_RESPONSE") {
              const diff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
              if (diff > 0 && diff < 60000) {
                ttfts.push(diff);
                if (b.output_tokens && diff > 500) speeds.push(Math.round(b.output_tokens / (diff / 1000)));
              }
            }
          }

          for (let i = 0; i < lines.length; i++) {
            const o = lines[i];
            if (o.type === "USER_INPUT") {
              const c = typeof o.content === "string" ? o.content : JSON.stringify(o.content || "");
              msgChars += c.length;
            }
            if (o.type === "PLANNER_RESPONSE") {
              lastPlanner = o;
              if (o.model) {
                const mm = o.model.match(/-(xhigh|high|medium|low)$/i);
                if (mm) { telemetry.effort = mm[1].toLowerCase(); telemetry.model = o.model.slice(0, mm.index); }
                else telemetry.model = o.model;
              }
              if (o.input_tokens) { cumIn += o.input_tokens; cumCache += (o.cache_read_tokens || 0); cumOut += (o.output_tokens || 0); }
              if (o.content) msgChars += String(o.content).length;
              if (o.thinking) msgChars += String(o.thinking).length;
              if (o.tool_calls) {
                for (const tc of o.tool_calls) {
                  toolsChars += JSON.stringify(tc).length;
                  usedTools.add(tc.name);
                  const p = tc.args?.Path || tc.args?.path || tc.args?.file_path;
                  if (p) { if (tc.name === "read_file") readFiles.add(p); else if (tc.name === "write_file" || tc.name === "edit_file") editedFiles.add(p); }
                  if (i >= lines.length - 30) turnTools.push({ name: tc.name, detail: toolDetail(tc.args), file: p ? normPath(p) : "", time: fmtTime(o.created_at), start: o.created_at, end: null, ms: "0s", status: "running" });
                }
              }
            }
            if (o.type === "GENERIC" || o.source === "TOOL") {
              totalToolsOk++;
              const c = typeof o.content === "string" ? o.content : JSON.stringify(o.content || "");
              resChars += c.length;
              if (turnTools.length > 0 && turnTools[turnTools.length - 1].status === "running") {
                const last = turnTools[turnTools.length - 1];
                last.end = o.created_at; last.status = "ok";
                const dur = Math.max(0, new Date(o.created_at).getTime() - new Date(last.start).getTime());
                last.ms = dur >= 1000 ? (dur / 1000).toFixed(1) + "s" : dur + "ms";
              }
            }
          }

          telemetry.toolsOk = totalToolsOk || (turnNum * 2);
          telemetry.usedToolNames = Array.from(usedTools);
          telemetry.usedToolsCount = usedTools.size;
          for (const ut of telemetry.usedToolNames) {
            if (!builtinNames.includes(ut) && !extNames.includes(ut)) builtinNames.push(ut);
          }
          telemetry.builtinTools = builtinNames.length;
          telemetry.totalTools = builtinNames.length + extNames.length;
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
          if (turnTools.length > 0) telemetry.recentTools = turnTools.slice(-6).reverse();
        }
      }
    } catch {}
  }
} else if (agentType === "codex") {
  const cDir = effectiveHome + "/.codex";
  const cfgP = cDir + "/config.toml";
  try {
    if (fs.existsSync(cfgP)) {
      const cfgT = fs.readFileSync(cfgP, "utf8");
      const mm = cfgT.match(/model\s*=\s*["']([^"']+)["']/);
      if (mm) telemetry.model = mm[1].startsWith("auto/") ? mm[1].slice(5) : mm[1];
      const em = cfgT.match(/model_reasoning_effort\s*=\s*["']([^"']+)["']/);
      if (em) telemetry.effort = em[1];
      const pm = cfgT.match(/model_provider\s*=\s*["']([^"']+)["']/);
      if (pm) telemetry.provider = pm[1];
    }
  } catch {}

  const sBase = cDir + "/sessions";
  const sessFiles = [];
  function walkSess(d, dp = 0) {
    if (dp > 4) return;
    try {
      for (const item of fs.readdirSync(d)) {
        const full = d + "/" + item, st = fs.statSync(full);
        if (st.isDirectory()) walkSess(full, dp + 1);
        else if (item.endsWith(".jsonl")) sessFiles.push({ path: full, mtime: st.mtimeMs, size: st.size });
      }
    } catch {}
  }
  if (fs.existsSync(sBase)) walkSess(sBase);
  sessFiles.sort((a, b) => b.mtime - a.mtime);

  let latestFile = sessFiles[0]?.path || null;
  if (sessFiles.length > 1 && cwd) {
    for (const cand of sessFiles.slice(0, 12)) {
      try {
        const fd = fs.openSync(cand.path, "r");
        const buf = Buffer.alloc(Math.min(8192, cand.size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        let matched = false;
        for (const line of buf.toString("utf8").split(NL)) {
          if (!line.trim()) continue;
          try {
            const o = JSON.parse(line);
            const scwd = normPath(o.payload?.cwd || "");
            if (scwd) {
              if (scwd === cwd || cwd.startsWith(scwd + "/") || scwd.startsWith(cwd + "/")) {
                latestFile = cand.path;
                matched = true;
              }
              break;
            }
          } catch {}
        }
        if (matched) break;
      } catch {}
    }
  }

  if (latestFile) {
    try {
      const im = latestFile.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (im) telemetry.sessionId = im[1].slice(0, 8);
      const lines = readTailLines(latestFile, 524288);
      telemetry.stepCount = lines.length;

      const recentCmds = [];
      const pendingCalls = new Map();
      const seenCallIds = new Set();
      let totalUsage = null, lastTokenUsage = null, okCount = 0, errCount = 0, userMsgTime = null, ttfts = [], toolDurs = [];
      const usedTools = new Set(), readFiles = new Set(), editedFiles = new Set();

      for (let i = 0; i < lines.length; i++) {
        try {
          const o = JSON.parse(lines[i]);
          const ts = new Date(o.timestamp || o.payload?.timestamp).getTime();
          if (o.type === "turn_context" && o.payload) {
            if (o.payload.approval_policy) telemetry.approvalPolicy = o.payload.approval_policy;
            if (o.payload.sandbox_policy?.type) telemetry.sandboxPolicy = o.payload.sandbox_policy.type;
            if (o.payload.model) telemetry.model = o.payload.model.startsWith("auto/") ? o.payload.model.slice(5) : o.payload.model;
            if (o.payload.effort) telemetry.effort = o.payload.effort;
          }
          if (o.payload?.type === "thread_settings_applied" && o.payload.thread_settings) {
            const tsObj = o.payload.thread_settings;
            if (tsObj.model) telemetry.model = tsObj.model.startsWith("auto/") ? tsObj.model.slice(5) : tsObj.model;
            if (tsObj.model_provider_id) telemetry.provider = tsObj.model_provider_id;
            if (tsObj.reasoning_effort) telemetry.effort = tsObj.reasoning_effort;
          }
          const item = o.payload?.item;
          if (item) {
            if (item.type === "SystemMessage") sysChars += String(item.content || "").length;
            else if (item.type === "UserMessage") { userMsgTime = ts; msgChars += String(item.content || item.text || "").length; }
            else if (item.type === "AgentMessage") {
              msgChars += String(item.content || item.text || "").length;
              if (userMsgTime && ts > userMsgTime) {
                const diff = ts - userMsgTime;
                if (diff > 0 && diff < 120000) ttfts.push(diff);
                userMsgTime = null;
              }
            } else if (item.type === "CommandExecution") {
              const cid = item.id || "";
              const rawCmd = Array.isArray(item.command) ? item.command.slice(-1)[0] : String(item.command || "");
              toolsChars += String(rawCmd).length;
              const aggOut = item.aggregated_output || item.output || "";
              resChars += String(aggOut).length;
              if (/\brtk\b/.test(rawCmd)) usedTools.add("rtk");
              if (/\bgit\b/.test(rawCmd)) usedTools.add("git");
              const pm = rawCmd.match(/(?:git\s+apply|patch|tee|cat\s+>\s*|nano|vim)\s+([^\s;&|]+)/i);
              if (pm) editedFiles.add(pm[1]);
              const cm = rawCmd.match(/(?:cat|head|tail|less|grep|rg|bat|sed|head)\s+([^\s;&|-]+)/i);
              if (cm) readFiles.add(cm[1]);
              if (cid && !seenCallIds.has(cid)) {
                seenCallIds.add(cid);
                const isErr = typeof item.exit_code === "number" && item.exit_code !== 0;
                if (isErr) errCount++; else okCount++;
                const cmdName = rawCmd.trim().split(NL)[0].replace(/^\S*zsh\s+-lc\s+['"]?/, "").slice(0, 44);
                recentCmds.push({ name: "exec_command", detail: cmdName || "command", time: fmtTime(ts), status: isErr ? "err" : "ok", ms: "—" });
                usedTools.add("exec_command");
              }
            }
          }
          if (o.payload?.type === "token_count" && o.payload.info) {
            if (o.payload.info.total_token_usage) totalUsage = o.payload.info.total_token_usage;
            if (o.payload.info.last_token_usage) lastTokenUsage = o.payload.info.last_token_usage;
          }
          if (o.type === "response_item" && o.payload?.type === "function_call") {
            const fn = o.payload.name || "tool";
            const cid = o.payload.call_id || o.payload.id || "";
            if (userMsgTime && ts > userMsgTime) {
              const diff = ts - userMsgTime;
              if (diff > 0 && diff < 120000) ttfts.push(diff);
              userMsgTime = null;
            }
            toolsChars += JSON.stringify(o.payload).length;
            usedTools.add(fn);
            let detail = "", file = "";
            const rawArgs = o.payload.arguments || "{}";
            try {
              const args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
              detail = toolDetail(args);
              if (!detail && fn === "write_stdin") detail = args.chars ? String(args.chars).slice(0, 32) : ("session " + (args.session_id || ""));
              if (!detail && fn === "apply_patch" && typeof args.input === "string") {
                const fm = args.input.match(/\*\*\* (?:Update|Add|Delete) File: ([^\n]+)/);
                if (fm) { detail = fm[1].trim().split("/").slice(-2).join("/"); editedFiles.add(fm[1].trim()); }
              }
              const p = args.path || args.file_path || args.file;
              if (p) {
                file = normPath(p);
                if (fn.includes("read") || fn.includes("view") || fn.includes("get")) readFiles.add(p);
                else editedFiles.add(p);
              }
              if (args.cmd && /\b(cat|head|tail|rg|grep|sed)\s+([^\s;&|-]+)/.test(args.cmd)) {
                const m2 = args.cmd.match(/\b(?:cat|head|tail|rg|grep|sed)\s+([^\s;&|-]+)/);
                if (m2) readFiles.add(m2[1]);
              }
            } catch {}
            const entry = { name: fn, detail, file, time: fmtTime(ts), status: "ok", ms: "…" };
            recentCmds.push(entry);
            if (cid) {
              seenCallIds.add(cid);
              pendingCalls.set(cid, { entry, startTs: ts });
            }
            okCount++;
          } else if (o.type === "response_item" && o.payload?.type === "function_call_output") {
            const cid = o.payload.call_id || "";
            const outText = String(o.payload.output || "");
            resChars += outText.length;
            const pend = cid ? pendingCalls.get(cid) : null;
            if (pend) {
              let dur = Math.max(0, ts - pend.startTs);
              const wm = outText.match(/Wall time:\s*([0-9.]+)\s*seconds/i);
              if (wm) dur = Math.round(parseFloat(wm[1]) * 1000);
              if (Number.isFinite(dur) && dur >= 0) {
                toolDurs.push(dur);
                pend.entry.ms = dur >= 1000 ? (dur / 1000).toFixed(1) + "s" : dur + "ms";
              } else {
                pend.entry.ms = "—";
              }
              const exitM = outText.match(/Process exited with code\s+(\d+)/i);
              const isErr = (exitM && exitM[1] !== "0") || /^\s*(?:Error:|failed:|Permission denied)/im.test(outText);
              if (isErr) {
                pend.entry.status = "err";
                if (okCount > 0) okCount--;
                errCount++;
              }
              pendingCalls.delete(cid);
            }
          }
        } catch {}
      }

      if (ttfts.length > 0) {
        telemetry.ttft = (ttfts[ttfts.length - 1] / 1000).toFixed(1) + "s";
        telemetry.avgTtft = (ttfts.reduce((s,x)=>s+x,0) / ttfts.length / 1000).toFixed(1) + "s";
      }
      if (toolDurs.length > 0) {
        const avg = Math.round(toolDurs.reduce((s,x)=>s+x,0) / toolDurs.length);
        telemetry.avgToolMs = avg >= 1000 ? (avg / 1000).toFixed(1) + "s" : avg + "ms";
      }
      if (recentCmds.length > 0) telemetry.recentTools = recentCmds.slice(-8).reverse();
      telemetry.toolsOk = okCount;
      telemetry.toolsErr = errCount;
      telemetry.toolsPerTurn = ((okCount + errCount) / Math.max(1, turnNum)).toFixed(1);
      telemetry.usedToolNames = Array.from(usedTools);
      telemetry.usedToolsCount = usedTools.size;
      for (const ut of telemetry.usedToolNames) {
        if (!builtinNames.includes(ut) && !extNames.includes(ut)) builtinNames.push(ut);
      }
      telemetry.builtinTools = builtinNames.length;
      telemetry.totalTools = builtinNames.length + extNames.length;
      telemetry.readFilesCount = readFiles.size;
      telemetry.editedFilesCount = editedFiles.size;

      if (lastTokenUsage) {
        telemetry.inTok = lastTokenUsage.input_tokens || 0;
        telemetry.cacheTok = lastTokenUsage.cached_input_tokens || 0;
        telemetry.outTok = lastTokenUsage.output_tokens || 0;
        telemetry.reasoningTok = lastTokenUsage.reasoning_output_tokens || 0;
        telemetry.totalCtx = telemetry.inTok + telemetry.outTok;
        telemetry.hitRate = telemetry.inTok > 0 ? (Math.round((telemetry.cacheTok / telemetry.inTok) * 1000) / 10) : 0;
        const turnCostNum = (telemetry.cacheTok * 1.25 + Math.max(0, telemetry.inTok - telemetry.cacheTok) * 2.50 + telemetry.outTok * 10.0) / 1000000;
        telemetry.turnCost = "$" + turnCostNum.toFixed(3);
      }
      if (totalUsage) {
        const sessionCostNum = (totalUsage.cached_input_tokens * 1.25 + Math.max(0, totalUsage.input_tokens - totalUsage.cached_input_tokens) * 2.50 + totalUsage.output_tokens * 10.0) / 1000000;
        const savedNum = (totalUsage.cached_input_tokens * (2.50 - 1.25)) / 1000000;
        telemetry.cost = "$" + sessionCostNum.toFixed(2);
        telemetry.sessionCost = "$" + sessionCostNum.toFixed(2);
        if (savedNum > 0.01) telemetry.cacheSaved = "$" + savedNum.toFixed(2);
      } else { telemetry.sessionCost = telemetry.cost; }
    } catch {}
  }
} else if (agentType === "omp") {
  const bDir = fs.existsSync(effectiveHome + "/.omp/agent/sessions") ? (effectiveHome + "/.omp/agent/sessions") : null;
  const cfgY = effectiveHome + "/.omp/agent/config.yml";
  try {
    if (fs.existsSync(cfgY)) {
      const mm = fs.readFileSync(cfgY, "utf8").match(/default:s*([^s]+)/);
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
            if (o.type === "message") {
              if (o.message?.role === "system") sysChars += String(o.message.content || "").length;
              else if (o.message?.role === "user") { turnCount++; msgChars += String(o.message.content || "").length; }
              else if (o.message?.role === "assistant") msgChars += String(o.message.content || "").length;
            }
            if (o.model || o.message?.model) telemetry.model = (o.model || o.message.model).split("/").pop();
            if (o.type === "tool_use" || o.message?.content?.[0]?.type === "tool_use") {
              toolCount++; const nm = o.name || o.message?.content?.[0]?.name || "tool";
              toolsChars += JSON.stringify(o).length;
              usedTools.add(nm); lastToolStart = ts; lastToolName = nm;
            } else if (lastToolStart && (o.type === "toolResult" || ts > lastToolStart)) {
              if (o.type === "toolResult") resChars += String(o.content || "").length;
              const dur = Math.max(0, ts - lastToolStart);
              const durStr = dur >= 1000 ? (dur / 1000).toFixed(1) + "s" : dur + "ms";
              recent.push({ name: lastToolName, detail: "", time: fmtTime(lastToolStart), status: "ok", ms: durStr });
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
        telemetry.usedToolNames = Array.from(usedTools);
        telemetry.usedToolsCount = usedTools.size;
        if (recent.length > 0) telemetry.recentTools = recent.slice(-6).reverse();
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

const charTotal = Math.max(1, sysChars + toolsChars + msgChars + resChars);
if (telemetry.totalCtx > 0) {
  const sysTok = Math.max(100, Math.round(telemetry.totalCtx * (sysChars / charTotal)));
  const toolsTok = Math.max(100, Math.round(telemetry.totalCtx * (toolsChars / charTotal)));
  const msgTok = Math.max(100, Math.round(telemetry.totalCtx * (msgChars / charTotal)));
  const resTok = Math.max(0, telemetry.totalCtx - sysTok - toolsTok - msgTok);
  const sysPct = Math.max(1, Math.round((sysTok / telemetry.totalCtx) * 100));
  const toolsPct = Math.max(1, Math.round((toolsTok / telemetry.totalCtx) * 100));
  const msgPct = Math.max(1, Math.round((msgTok / telemetry.totalCtx) * 100));
  const resPct = Math.max(1, 100 - sysPct - toolsPct - msgPct);
  telemetry.breakdown = { sys: sysTok, sysPct, tools: toolsTok, toolsPct, msg: msgTok, msgPct, res: resTok, resPct };
} else {
  telemetry.breakdown = { sys: 0, sysPct: 0, tools: 0, toolsPct: 0, msg: 0, msgPct: 0, res: 0, resPct: 0 };
}

process.stdout.write(JSON.stringify(telemetry));
