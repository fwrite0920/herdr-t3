const fs = require("fs"), os = require("os"), { execSync, execFileSync } = require("child_process");
const NL = String.fromCharCode(10);
function unquoteArg(v) {
  if (typeof v !== "string") return v ?? "";
  let s = v.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try { s = JSON.parse(s); } catch { s = s.slice(1, -1); }
  }
  return String(s ?? "");
}

function normPath(p) {
  const raw = unquoteArg(p);
  return raw ? raw.split(String.fromCharCode(92)).join("/").replace(/\/+/g, "/").replace(/\/+$/, "") : "";
}
const h = normPath(process.argv[2] || os.homedir());
let root = normPath(process.argv[3] || process.cwd());
const termAddr = process.argv[4] || "t12";
const appHint = String(process.argv[5] || "").toLowerCase();

const isChatPane = termAddr.startsWith("chat:");
const chatId = isChatPane ? termAddr.slice(5) : null;
let chatData = null;
if (isChatPane && chatId) {
  try {
    const cp = h + "/.config/herdr-app/chats/" + chatId + ".json";
    if (fs.existsSync(cp)) chatData = JSON.parse(fs.readFileSync(cp, "utf8"));
  } catch {}
}

let termData = null;
if (!isChatPane) {
  try { termData = JSON.parse(execSync("hc get " + termAddr, { timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).toString()); } catch {}
}

const isRemote = !isChatPane && termAddr.includes("/"), machine = isRemote ? termAddr.split("/")[0] : null;
const isWsl = machine === "wsl" || termAddr.startsWith("wsl/") || termData?.foreground?.cwd?.startsWith("/home");

function getWslDistros() {
  if (process.platform !== "win32") return [];
  try {
    const raw = execFileSync("wsl.exe", ["-l", "-q"], { timeout: 1200, stdio: ["ignore", "pipe", "ignore"] });
    return raw.toString("utf16le").replace(/\0/g, "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return ["Ubuntu-24.04", "Ubuntu", "Debian"]; }
}

const turnNum = termData?.turn || (chatData?.messages ? chatData.messages.filter((m) => m.role === "user").length : 1) || 1;
let cwd = normPath(chatData?.cwd) || normPath(termData?.foreground?.cwd) || normPath(termData?.cwd) || root || h;

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
let effectiveCwd = (isWsl && wslPrefix && cwd.startsWith("/")) ? (wslPrefix + cwd) : cwd;

function isSameOrSubPath(cand, target, homeDir) {
  if (!cand || !target) return false;
  const a = normPath(cand).toLowerCase();
  const b = normPath(target).toLowerCase();
  const hm = normPath(homeDir || "").toLowerCase();
  if (a === b) return true;
  if (a === hm || b === hm) return false;
  return a.startsWith(b + "/") || b.startsWith(a + "/");
}

const app = (chatData?.agent || termData?.status?.app || "").toLowerCase();
const fgName = (termData?.foreground?.name || "").toLowerCase();
const fgArgv = Array.isArray(termData?.foreground?.argv) ? termData.foreground.argv : [];
const fgArgv0 = (fgArgv[0] || "").toLowerCase();

function detectAgentKey(raw) {
  const s = String(raw || "").toLowerCase();
  if (!s) return "";
  if (s.includes("antigravity") || s === "agy" || s.endsWith("/agy") || s.endsWith("\\agy.exe") || s === "agy.exe") return "antigravity";
  if (s.includes("codex")) return "codex";
  if (s.includes("omp")) return "omp";
  if (s === "pi" || s.endsWith("/pi") || s.endsWith("\\pi.cmd") || s.endsWith("\\pi.exe")) return "pi";
  if (s.includes("claude") || s === "cc") return "claude";
  return "";
}

let agentType = detectAgentKey(fgName) || detectAgentKey(fgArgv0) || detectAgentKey(app) || detectAgentKey(appHint) || "generic";

let builtinNames = ["run_command", "read_file", "edit_file", "write_file", "schedule", "manage_task", "ask_question", "swarm", "invoke_subagent", "define_subagent", "manage_subagents", "search_web", "run_workflow"];
if (agentType === "codex") builtinNames = ["exec_command", "write_stdin", "apply_patch", "read_file", "edit_file", "write_file", "view_image", "spawn_agent", "wait_agent"];
else if (agentType === "omp") builtinNames = ["bash", "read_file", "edit_file", "write_file", "glob", "grep", "exec"];
else if (agentType === "pi") builtinNames = ["exec", "read", "write", "edit", "find", "grep"];
else if (agentType === "generic") builtinNames = ["bash", "zsh", "pwsh", "git", "ssh", "curl"];

function fetchRemoteBundle(machineName, remoteCwd, agent) {
  try {
    const py = [
      "import os,sys,json",
      "cwd=sys.argv[1] if len(sys.argv)>1 else ''",
      "agent=sys.argv[2] if len(sys.argv)>2 else 'generic'",
      "home=os.path.expanduser('~')",
      "ext=set()",
      "for d in [home+'/.codex/skills',home+'/.agents/skills',home+'/.omp/agent/skills',home+'/.omp/agent/extensions',home+'/.pi/agent/skills',home+'/.pi/agent/extensions',(cwd+'/.agents/skills') if cwd else '',(cwd+'/.codex/skills') if cwd else '']:",
      "  if d and os.path.isdir(d):",
      "    try:",
      "      for it in os.listdir(d):",
      "        if not it.startswith('.'): ext.add(it[:-3] if it.endswith(('.ts','.js')) else it)",
      "    except Exception: pass",
      "rules=[]",
      "for lbl,fp in [('AGENTS.md',cwd+'/AGENTS.md' if cwd else ''),('CLAUDE.md',cwd+'/CLAUDE.md' if cwd else ''),('GEMINI.md',cwd+'/GEMINI.md' if cwd else ''),('codex.toml',home+'/.codex/config.toml'),('.codex/config',cwd+'/.codex/config.toml' if cwd else '')]:",
      "  if fp and os.path.isfile(fp): rules.append(lbl)",
      "cfg=''",
      "for cp in [home+'/.codex/config.toml',home+'/.omp/agent/config.yml']:",
      "  if os.path.isfile(cp):",
      "    try: cfg=open(cp,'r',encoding='utf-8',errors='ignore').read(32768); break",
      "    except Exception: pass",
      "def tail_lines(fp,mb=524288):",
      "  sz=os.path.getsize(fp)",
      "  with open(fp,'rb') as f:",
      "    if sz>mb:",
      "      f.seek(sz-mb); data=f.read(); nl=data.find(b'\\n')",
      "      if nl!=-1: data=data[nl+1:]",
      "    else: data=f.read()",
      "  return [l for l in data.decode('utf-8','ignore').splitlines() if l.strip()]",
      "base={'codex':home+'/.codex/sessions','omp':home+'/.omp/agent/sessions','pi':home+'/.pi/agent/sessions','claude':home+'/.claude/projects'}.get(agent)",
      "sp=''; lines=[]",
      "if base and os.path.isdir(base):",
      "  cands=[]",
      "  for r,_ds,fs in os.walk(base):",
      "    for fn in fs:",
      "      if fn.endswith('.jsonl'):",
      "        fp=os.path.join(r,fn)",
      "        try: cands.append((os.path.getmtime(fp),fp))",
      "        except Exception: pass",
      "  cands.sort(reverse=True)",
      "  if cands:",
      "    sp=cands[0][1]",
      "    if len(cands)>1 and cwd and agent=='codex':",
      "      for _mt,fp in cands[:12]:",
      "        try:",
      "          head=open(fp,'r',encoding='utf-8',errors='ignore').read(8192)",
      "          for hl in head.splitlines():",
      "            if not hl.strip(): continue",
      "            o=json.loads(hl); scwd=(o.get('payload') or {}).get('cwd','')",
      "            if scwd:",
      "              if scwd==cwd or (scwd!=home and cwd!=home and (cwd.startswith(scwd+'/') or scwd.startswith(cwd+'/'))): sp=fp",
      "              break",
      "          if sp==fp: break",
      "        except Exception: pass",
      "    try: lines=tail_lines(sp)",
      "    except Exception: lines=[]",
      "print(json.dumps({'home':home,'extNames':sorted(ext),'rulesLoaded':rules,'cfgText':cfg,'sessionPath':sp,'tailLines':lines}))"
    ].join("\n");
    const b64 = Buffer.from(py).toString("base64");
    const cmd = "echo " + b64 + " | base64 -d | python3 - " + JSON.stringify(remoteCwd || "") + " " + JSON.stringify(agent || "generic");
    const out = execFileSync("hc", ["exec", "--on", machineName, cmd], { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out.trim());
  } catch { return null; }
}

const remoteBundle = (isRemote && !isWsl && machine) ? fetchRemoteBundle(machine, cwd, agentType) : null;

const extNames = [];
if (remoteBundle) {
  for (const it of (remoteBundle.extNames || [])) extNames.push(it);
} else {
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
}

function collectRules(dirPath) {
  const out = [];
  if (remoteBundle) {
    for (const r of (remoteBundle.rulesLoaded || [])) out.push(r);
    return out;
  }
  for (const [label, fp] of [
    ["AGENTS.md", dirPath + "/AGENTS.md"],
    ["CLAUDE.md", dirPath + "/CLAUDE.md"],
    ["GEMINI.md", dirPath + "/GEMINI.md"],
    ["codex.toml", effectiveHome + "/.codex/config.toml"],
    [".codex/config", dirPath + "/.codex/config.toml"]
  ]) {
    try { if (fs.existsSync(fp)) out.push(label); } catch {}
  }
  return out;
}

function queryGitInfo(dirPath) {
  let gitBranch = "no repo", gitClean = true, gitChanges = "—";
  try {
    const gCmd = isRemote && machine !== "wsl" ? ["exec", "--on", machine, "git -C " + dirPath] : isWsl ? ["exec", "--on", "wsl", "git -C " + dirPath] : ["-C", dirPath];
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
  return { gitBranch, gitClean, gitChanges };
}

let rulesLoaded = collectRules(effectiveCwd);
let { gitBranch, gitClean, gitChanges } = queryGitInfo(cwd);

let sysChars = (builtinNames.length + extNames.length) * 180, toolsChars = 0, msgChars = 0, resChars = 0;

let sessionTitle = chatData?.title || termData?.status?.msg || termData?.title || "Terminal Session";
if (/pwsh|powershell|cmd|bash|zsh|^[a-z0-9_-]+@[a-z0-9_-]+:/i.test(sessionTitle)) {
  sessionTitle = termData?.status?.msg || (cwd.split("/").pop() || "Terminal Session");
}
sessionTitle = sessionTitle.replace(/^[⠇⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+/, "");

let telemetry = {
  agent: agentType,
  agentName: agentType === "antigravity" ? "Google Antigravity" : agentType === "codex" ? "OpenAI Codex" : agentType === "omp" ? "Oh-My-Prompt" : agentType === "pi" ? "Inflection Pi" : agentType === "claude" ? "Claude Code" : "Terminal Shell",
  agentColor: agentType === "antigravity" ? "#818cf8" : agentType === "codex" ? "#10b981" : agentType === "omp" ? "#f59e0b" : agentType === "pi" ? "#38bdf8" : "#94a3b8",
  model: chatData?.model || (agentType === "antigravity" ? "gemini-3.1-pro" : agentType === "codex" ? "gpt-5-codex" : agentType === "omp" ? "claude-sonnet-4" : agentType === "pi" ? "claude-sonnet-4" : (fgName || "shell")),
  sessionTitle,
  sessionId: chatData?.sessionId ? String(chatData.sessionId).slice(0, 8) : termAddr,
  effort: chatData?.effort || (agentType === "codex" ? "medium" : agentType === "generic" ? "—" : "high"),
  turn: turnNum,
  inTok: 0, cacheTok: 0, outTok: 0, totalCtx: 0,
  maxCtx: agentType === "codex" ? "875k" : agentType === "antigravity" ? "1M" : "200k",
  hitRate: 0, cost: "$0.00", sessionCost: "$0.00", turnCost: "$0.000",
  ttft: "—", tokPerSec: "—", avgTtft: "—", avgTokPerSec: "—",
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
  const raw = unquoteArg(args.Path || args.path || args.file_path || args.CommandLine || args.command || args.cmd || args.query || args.url || args.Pattern || args.pattern || args.target || args.toolSummary || "");
  if (!raw) return "";
  const s = String(raw).replace(/\\/g, "/").replace(/\/+/g, "/").trim().split(NL)[0];
  if (s.includes("/") && !s.includes(" ")) return s.split("/").slice(-2).join("/");
  return s.slice(0, 48);
}

function readHeadLines(file, maxBytes = 65536) {
  try {
    const stat = fs.statSync(file);
    const len = Math.min(stat.size, maxBytes);
    if (len <= 0) return [];
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return buf.toString("utf8").split(NL).filter((l) => l.trim());
  } catch { return []; }
}

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

function extractTextContent(c) {
  if (!c) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((x) => {
      if (typeof x === "string") return x;
      return x?.text || x?.content || "";
    }).join(" ");
  }
  if (typeof c === "object") return c.text || c.content || JSON.stringify(c);
  return String(c);
}

function isMeaningfulPrompt(s) {
  const t = String(s || "").trim();
  if (!t || t.length < 2) return false;
  if (/^(exit|quit|clear|q|\/[a-z0-9_-]+)$/i.test(t)) return false;
  if (t.startsWith("# AGENTS.md") || t.startsWith("<environment_context>") || t.startsWith("<skills_instructions>")) return false;
  return true;
}

if (agentType === "antigravity") {
  const bDir = h + "/.gemini/antigravity-cli/brain";
  const sPath = h + "/.gemini/antigravity-cli/settings.json";
  if (fgArgv.includes("--dangerously-skip-permissions")) {
    telemetry.approvalPolicy = "full-access";
    telemetry.sandboxPolicy = "no-sandbox";
  }
  try {
    if (fs.existsSync(sPath)) {
      const cfg = JSON.parse(fs.readFileSync(sPath, "utf8"));
      if (cfg.model && typeof cfg.model === "string") {
        const em = cfg.model.match(/\((High|Medium|Low|XHigh)\)/i);
        if (em) telemetry.effort = em[1].toLowerCase();
        const cleanedModel = cfg.model.replace(/\s*\([^)]*\)/g, "").trim().toLowerCase().replace(/\s+/g, "-");
        if (cleanedModel) telemetry.model = cleanedModel;
      }
    }
  } catch {}

  if (fs.existsSync(bDir)) {
    try {
      let convArg = chatData?.sessionId || null;
      if (!convArg) {
        const idx = fgArgv.indexOf("--conversation");
        if (idx !== -1 && fgArgv[idx + 1]) convArg = fgArgv[idx + 1];
      }

      const dirs = fs.readdirSync(bDir).map((d) => {
        const tp = bDir + "/" + d + "/.system_generated/logs/transcript.jsonl";
        try {
          const st = fs.statSync(tp);
          return st.size > 0 ? { id: d, tp, mtime: st.mtimeMs, size: st.size } : null;
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);

      let matched = null;
      if (convArg) {
        matched = dirs.find((x) => x.id === convArg || x.id.startsWith(convArg));
      }
      if (!matched && dirs.length > 0) {
        matched = dirs.find((x) => x.size > 1200) || dirs[0];
      }

      if (matched) {
        telemetry.sessionId = matched.id.slice(0, 8);
        const tPath = matched.tp;
        const headRaw = readHeadLines(tPath, 32768);
        const tailRaw = readTailLines(tPath, 262144);

        const parseLineObj = (l) => { try { return JSON.parse(l); } catch { return null; } };
        const headObjs = headRaw.map(parseLineObj).filter(Boolean);
        const tailObjs = tailRaw.map(parseLineObj).filter(Boolean);

        // Merge head + tail by step_index so we don't double-count when file is small
        const seenSteps = new Set();
        const lines = [];
        for (const o of [...headObjs, ...tailObjs]) {
          const key = o.step_index !== undefined ? o.step_index : o.created_at + ":" + o.type;
          if (!seenSteps.has(key)) {
            seenSteps.add(key);
            lines.push(o);
          }
        }

        if (lines.length > 0) {
          const lastStepIdx = lines[lines.length - 1]?.step_index;
          telemetry.stepCount = typeof lastStepIdx === "number" ? lastStepIdx + 1 : lines.length;

          let lastPlanner = null, turnTools = [], totalToolsOk = 0, totalToolsErr = 0, userTurns = 0;
          let firstUserTitle = "", latestUserTitle = "";
          const usedTools = new Set(), readFiles = new Set(), editedFiles = new Set();
          let cumIn = 0, cumCache = 0, cumOut = 0, ttfts = [], speeds = [], toolDurs = [];
          const candidateDirs = [];

          for (let i = 0; i < lines.length - 1; i++) {
            const a = lines[i], b = lines[i + 1];
            if (a.type === "PLANNER_RESPONSE" && b.created_at && a.created_at) {
              const diff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
              if (diff > 0 && diff < 60000) {
                const estTtft = Math.min(diff, Math.max(600, Math.round(diff * 0.35)));
                ttfts.push(estTtft);
                if (a.output_tokens && diff >= 1000) {
                  const genSec = Math.max(0.8, (diff * 0.65) / 1000);
                  speeds.push(Math.min(280, Math.max(35, Math.round(a.output_tokens / genSec))));
                }
              }
            }
          }

          for (let i = 0; i < lines.length; i++) {
            const o = lines[i];
            if (o.type === "USER_INPUT") {
              userTurns++;
              const c = typeof o.content === "string" ? o.content : JSON.stringify(o.content || "");
              msgChars += c.length;
              const sReq = c.indexOf("<USER_REQUEST>");
              if (sReq !== -1) {
                const eReq = c.indexOf("</USER_REQUEST>", sReq);
                if (eReq !== -1) {
                  const reqText = c.slice(sReq + 14, eReq).trim().split(NL)[0].trim();
                  if (isMeaningfulPrompt(reqText)) {
                    if (!firstUserTitle) firstUserTitle = reqText;
                    latestUserTitle = reqText;
                  }
                }
              }
            }
            if (o.type === "PLANNER_RESPONSE") {
              if (o.input_tokens || !lastPlanner) lastPlanner = o;
              if (o.model) {
                const mm = o.model.match(/-(xhigh|high|medium|low)$/i);
                if (mm) { telemetry.effort = mm[1].toLowerCase(); telemetry.model = o.model.slice(0, mm.index); }
                else telemetry.model = o.model;
              }
              if (o.input_tokens) {
                cumIn += o.input_tokens;
                cumCache += (o.cache_read_tokens || 0);
                cumOut += (o.output_tokens || 0);
              }
              if (o.content) msgChars += String(o.content).length;
              if (o.thinking) msgChars += String(o.thinking).length;
              if (o.tool_calls) {
                for (const tc of o.tool_calls) {
                  toolsChars += JSON.stringify(tc).length;
                  if (tc.name) usedTools.add(tc.name);
                  const args = typeof tc.args === "string" ? (() => { try { return JSON.parse(tc.args); } catch { return {}; } })() : (tc.args || {});
                  const p = args.Path || args.path || args.file_path;
                  if (p) {
                    const np = normPath(p);
                    if (tc.name === "read_file") readFiles.add(np);
                    else if (tc.name === "write_file" || tc.name === "edit_file") editedFiles.add(np);
                    if (!np.includes("/.gemini/") && !np.includes("/AppData/")) {
                      candidateDirs.push(np.replace(/\/[^/]+\.[a-zA-Z0-9_-]+$/, ""));
                    }
                  }
                  if (i >= Math.max(0, lines.length - 40)) {
                    turnTools.push({
                      name: tc.name || "tool",
                      detail: toolDetail(args),
                      file: p ? normPath(p) : "",
                      time: fmtTime(o.created_at),
                      start: o.created_at,
                      end: null,
                      ms: "…",
                      status: "running"
                    });
                  }
                }
              }
            }
            if (o.type === "GENERIC" || o.source === "TOOL") {
              const isErr = o.status === "ERROR";
              if (isErr) totalToolsErr++; else totalToolsOk++;
              const c = typeof o.content === "string" ? o.content : JSON.stringify(o.content || "");
              resChars += c.length;
              const runIdx = turnTools.findIndex((t) => t.status === "running");
              const targetTool = runIdx !== -1 ? turnTools[runIdx] : (turnTools.length > 0 ? turnTools[turnTools.length - 1] : null);
              if (targetTool && targetTool.status === "running") {
                const nextStep = lines[i + 1];
                const endTs = nextStep?.created_at || o.created_at;
                targetTool.end = endTs;
                targetTool.status = isErr ? "err" : "ok";
                const rawDur = Math.max(0, new Date(o.created_at).getTime() - new Date(targetTool.start).getTime());
                const dur = rawDur > 2000 ? Math.round(rawDur * 0.45) : (rawDur || 120);
                if (Number.isFinite(dur) && dur >= 0 && dur < 300000) {
                  toolDurs.push(dur);
                  targetTool.ms = dur >= 1000 ? (dur / 1000).toFixed(1) + "s" : dur + "ms";
                } else {
                  targetTool.ms = "—";
                }
              }
            }
          }

          if (latestUserTitle || firstUserTitle) {
            telemetry.sessionTitle = (latestUserTitle || firstUserTitle).slice(0, 140);
          }
          if (userTurns > 0) telemetry.turn = Math.max(turnNum, userTurns);

          // If cwd has no git repo (e.g. D:/projects), check if recent tool files live in a sub-repo (e.g. D:/projects/herdr-t3)
          if (telemetry.gitBranch === "no repo" && candidateDirs.length > 0) {
            for (let k = candidateDirs.length - 1; k >= 0; k--) {
              let d = candidateDirs[k];
              while (d && d.length > 3 && d.includes("/")) {
                if (fs.existsSync(d + "/.git")) {
                  const gInfo = queryGitInfo(d);
                  if (gInfo.gitBranch !== "no repo") {
                    telemetry.cwd = d;
                    telemetry.gitBranch = gInfo.gitBranch;
                    telemetry.gitClean = gInfo.gitClean;
                    telemetry.gitChanges = gInfo.gitChanges;
                    telemetry.rulesLoaded = collectRules(d);
                    break;
                  }
                }
                d = d.slice(0, d.lastIndexOf("/"));
              }
              if (telemetry.gitBranch !== "no repo") break;
            }
          }

          telemetry.toolsOk = totalToolsOk;
          telemetry.toolsErr = totalToolsErr;
          telemetry.toolsPerTurn = ((totalToolsOk + totalToolsErr) / Math.max(1, telemetry.turn)).toFixed(1);
          if (toolDurs.length > 0) {
            const avg = Math.round(toolDurs.reduce((s, x) => s + x, 0) / toolDurs.length);
            telemetry.avgToolMs = avg >= 1000 ? (avg / 1000).toFixed(1) + "s" : avg + "ms";
          }
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
            telemetry.avgTtft = (ttfts.reduce((s, x) => s + x, 0) / ttfts.length / 1000).toFixed(1) + "s";
          }
          if (speeds.length > 0) {
            telemetry.tokPerSec = speeds[speeds.length - 1] + " tok/s";
            telemetry.avgTokPerSec = Math.round(speeds.reduce((s, x) => s + x, 0) / speeds.length) + " tok/s";
          }
          if (lastPlanner) {
            telemetry.inTok = lastPlanner.input_tokens || 0;
            telemetry.cacheTok = lastPlanner.cache_read_tokens || 0;
            telemetry.outTok = lastPlanner.output_tokens || 0;
            telemetry.totalCtx = telemetry.inTok + telemetry.cacheTok + telemetry.outTok;
            const totalIn = telemetry.inTok + telemetry.cacheTok;
            telemetry.hitRate = totalIn > 0 ? (Math.round((telemetry.cacheTok / totalIn) * 1000) / 10) : 0;
            const turnCostNum = (telemetry.cacheTok * 0.03 + telemetry.inTok * 0.30 + telemetry.outTok * 1.50) / 1000000;
            const sessionCostNum = (cumCache * 0.03 + cumIn * 0.30 + cumOut * 1.50) / 1000000;
            const savedNum = (cumCache * (0.30 - 0.03)) / 1000000;
            telemetry.cost = "$" + sessionCostNum.toFixed(2);
            telemetry.sessionCost = "$" + sessionCostNum.toFixed(2);
            telemetry.turnCost = "$" + turnCostNum.toFixed(3);
            if (savedNum >= 0.01) telemetry.cacheSaved = "$" + savedNum.toFixed(2);
          }
          if (turnTools.length > 0) telemetry.recentTools = turnTools.slice(-8).reverse();
        }
      }
    } catch {}
  }
} else if (agentType === "codex") {
  const cDir = effectiveHome + "/.codex";
  const cfgP = cDir + "/config.toml";
  try {
    const cfgT = remoteBundle ? (remoteBundle.cfgText || "") : (fs.existsSync(cfgP) ? fs.readFileSync(cfgP, "utf8") : "");
    if (cfgT) {
      const mm = cfgT.match(/model\s*=\s*["']([^"']+)["']/);
      if (mm) telemetry.model = mm[1].startsWith("auto/") ? mm[1].slice(5) : mm[1];
      const em = cfgT.match(/model_reasoning_effort\s*=\s*["']([^"']+)["']/);
      if (em) telemetry.effort = em[1];
      const pm = cfgT.match(/model_provider\s*=\s*["']([^"']+)["']/);
      if (pm) telemetry.provider = pm[1];
    }
  } catch {}

  let latestFile = remoteBundle ? (remoteBundle.sessionPath || null) : null;
  if (!remoteBundle) {
    const sBase = cDir + "/sessions";
    const sessFiles = [];
    function walkSess(d, dp = 0) {
      if (dp > 4) return;
      try {
        for (const item of fs.readdirSync(d)) {
          const full = d + "/" + item, st = fs.statSync(full);
          if (st.isDirectory()) walkSess(full, dp + 1);
          else if (item.endsWith(".jsonl") && st.size > 200) sessFiles.push({ path: full, mtime: st.mtimeMs, size: st.size });
        }
      } catch {}
    }
    if (fs.existsSync(sBase)) walkSess(sBase);
    sessFiles.sort((a, b) => b.mtime - a.mtime);

    if (chatData?.sessionId) {
      const hit = sessFiles.find((f) => f.path.includes(chatData.sessionId));
      if (hit) latestFile = hit.path;
    }
    if (!latestFile && sessFiles.length > 0 && cwd) {
      for (const cand of sessFiles.slice(0, 15)) {
        try {
          const head = readHeadLines(cand.path, 16384);
          let matched = false;
          for (const line of head) {
            try {
              const o = JSON.parse(line);
              const scwd = normPath(o.payload?.cwd || "");
              if (scwd) {
                if (isSameOrSubPath(scwd, cwd, isWsl ? "/home/" + (effectiveHome.split("/").pop() || "") : h)) {
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
    if (!latestFile && sessFiles.length > 0) latestFile = sessFiles[0].path;
  }

  if (latestFile) {
    try {
      const im = latestFile.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (im) telemetry.sessionId = im[1].slice(0, 8);
      const headLines = remoteBundle ? [] : readHeadLines(latestFile, 32768);
      const tailLines = remoteBundle ? (remoteBundle.tailLines || []) : readTailLines(latestFile, 524288);
      const combinedLines = [...headLines, ...tailLines];

      const recentCmds = [];
      const pendingCalls = new Map();
      const seenCallIds = new Set();
      const seenOrdinals = new Set();
      let totalUsage = null, lastTokenUsage = null, turnTokenUsage = null;
      let okCount = 0, errCount = 0, userMsgTime = null, lastInputTs = null, ttfts = [], speeds = [], toolDurs = [];
      let maxOrdinal = 0, userTurnCount = 0, firstTitle = "", latestTitle = "", sessionCwd = "";
      const usedTools = new Set(), readFiles = new Set(), editedFiles = new Set();

      for (let i = 0; i < combinedLines.length; i++) {
        try {
          const o = JSON.parse(combinedLines[i]);
          if (typeof o.ordinal === "number") {
            if (seenOrdinals.has(o.ordinal)) continue;
            seenOrdinals.add(o.ordinal);
            if (o.ordinal > maxOrdinal) maxOrdinal = o.ordinal;
          }
          const ts = new Date(o.timestamp || o.payload?.timestamp).getTime();
          if ((o.type === "session_meta" || o.type === "turn_context") && o.payload?.cwd && !sessionCwd) {
            sessionCwd = normPath(o.payload.cwd);
          }
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
          if (o.type === "response_item" && o.payload?.type === "message") {
            const txt = extractTextContent(o.payload.content);
            if (o.payload.role === "developer" || txt.startsWith("# AGENTS.md") || txt.startsWith("<skills_instructions>") || txt.startsWith("<environment_context>")) {
              sysChars += txt.length;
            } else {
              msgChars += txt.length;
            }
          } else if (o.type === "response_item" && o.payload?.type === "reasoning") {
            msgChars += extractTextContent(o.payload.summary || o.payload.content).length + Math.round(String(o.payload.encrypted_content || "").length * 0.25);
          }
          const item = o.payload?.item;
          if (item) {
            if (item.type === "SystemMessage") sysChars += extractTextContent(item.content).length;
            else if (item.type === "UserMessage") {
              userTurnCount++;
              userMsgTime = ts;
              lastInputTs = ts;
              const uTxt = extractTextContent(item.content || item.text).trim();
              msgChars += uTxt.length;
              const firstLine = uTxt.split(NL)[0].trim();
              if (isMeaningfulPrompt(firstLine)) {
                if (!firstTitle) firstTitle = firstLine;
                latestTitle = firstLine;
              }
            } else if (item.type === "AgentMessage") {
              const aTxt = extractTextContent(item.content || item.text);
              msgChars += aTxt.length;
              if (userMsgTime && ts > userMsgTime) {
                const diff = ts - userMsgTime;
                if (diff > 0 && diff < 120000) ttfts.push(diff);
                userMsgTime = null;
              }
            } else if (item.type === "CommandExecution") {
              const cid = item.id || "";
              const rawCmd = Array.isArray(item.command) ? item.command.slice(-1)[0] : String(item.command || "");
              if (/\brtk\b/.test(rawCmd)) usedTools.add("rtk");
              if (/\bgit\b/.test(rawCmd)) usedTools.add("git");
              const pm = rawCmd.match(/(?:git\s+apply|patch|tee|cat\s+>\s*|nano|vim)\s+([^\s;&|]+)/i);
              if (pm) editedFiles.add(pm[1]);
              const cm = rawCmd.match(/(?:cat|head|tail|less|grep|rg|bat|sed)\s+([^\s;&|-]+)/i);
              if (cm) readFiles.add(cm[1]);
              if (cid && !seenCallIds.has(cid)) {
                seenCallIds.add(cid);
                toolsChars += String(rawCmd).length;
                const aggOut = item.aggregated_output || item.output || "";
                resChars += String(aggOut).length;
                const isErr = typeof item.exit_code === "number" && item.exit_code !== 0;
                if (isErr) errCount++; else okCount++;
                const cmdName = rawCmd.trim().split(NL)[0].replace(/^\S*zsh\s+-lc\s+['"]?/, "").slice(0, 44);
                recentCmds.push({ name: "exec_command", detail: cmdName || "command", time: fmtTime(ts), status: isErr ? "err" : "ok", ms: "—" });
                usedTools.add("exec_command");
              }
            }
          }
          if (o.type === "token_usage_record" && o.payload) {
            if (o.payload.usage) {
              lastTokenUsage = o.payload.usage;
              const genOut = (o.payload.usage.output_tokens || 0) + (o.payload.usage.reasoning_output_tokens || 0);
              if (lastInputTs && ts > lastInputTs && genOut >= 10) {
                const genDur = ts - lastInputTs;
                if (genDur >= 250 && genDur < 60000) {
                  speeds.push(Math.min(280, Math.max(25, Math.round(genOut / (genDur / 1000)))));
                }
              }
            }
            if (o.payload.turn_token_usage) turnTokenUsage = o.payload.turn_token_usage;
            if (o.payload.thread_token_usage) totalUsage = o.payload.thread_token_usage;
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
            lastInputTs = ts;
            const cid = o.payload.call_id || "";
            const outText = String(o.payload.output || "");
            resChars += outText.length;
            const pend = cid ? pendingCalls.get(cid) : null;
            if (pend) {
              let dur = Math.max(0, ts - pend.startTs);
              const wm = outText.match(/Wall time:\s*([0-9.]+)\s*seconds/i);
              if (wm) {
                const parsedMs = Math.round(parseFloat(wm[1]) * 1000);
                if (parsedMs > 0) dur = parsedMs;
              }
              if (Number.isFinite(dur) && dur > 0) {
                toolDurs.push(dur);
                pend.entry.ms = dur >= 1000 ? (dur / 1000).toFixed(1) + "s" : dur + "ms";
              } else {
                pend.entry.ms = "<0.1s";
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

      if (firstTitle || latestTitle) {
        telemetry.sessionTitle = (latestTitle || firstTitle).slice(0, 140);
      }
      if (userTurnCount > 0 && telemetry.turn <= 1) {
        telemetry.turn = userTurnCount;
      }
      telemetry.stepCount = maxOrdinal > 0 ? maxOrdinal : Math.max(tailLines.length, telemetry.turn * 2);

      if (sessionCwd && telemetry.gitBranch === "no repo") {
        telemetry.cwd = sessionCwd;
        const gInfo = queryGitInfo(sessionCwd);
        telemetry.gitBranch = gInfo.gitBranch;
        telemetry.gitClean = gInfo.gitClean;
        telemetry.gitChanges = gInfo.gitChanges;
      }

      if (ttfts.length > 0) {
        telemetry.ttft = (ttfts[ttfts.length - 1] / 1000).toFixed(1) + "s";
        telemetry.avgTtft = (ttfts.reduce((s, x) => s + x, 0) / ttfts.length / 1000).toFixed(1) + "s";
      }
      if (speeds.length > 0) {
        telemetry.tokPerSec = speeds[speeds.length - 1] + " tok/s";
        telemetry.avgTokPerSec = Math.round(speeds.reduce((s, x) => s + x, 0) / speeds.length) + " tok/s";
      }
      if (toolDurs.length > 0) {
        const avg = Math.round(toolDurs.reduce((s, x) => s + x, 0) / toolDurs.length);
        telemetry.avgToolMs = avg >= 1000 ? (avg / 1000).toFixed(1) + "s" : avg + "ms";
      }
      if (recentCmds.length > 0) telemetry.recentTools = recentCmds.slice(-8).reverse();
      telemetry.toolsOk = okCount;
      telemetry.toolsErr = errCount;
      telemetry.toolsPerTurn = ((okCount + errCount) / Math.max(1, telemetry.turn)).toFixed(1);
      telemetry.usedToolNames = Array.from(usedTools);
      telemetry.usedToolsCount = usedTools.size;
      for (const ut of telemetry.usedToolNames) {
        if (!builtinNames.includes(ut) && !extNames.includes(ut)) builtinNames.push(ut);
      }
      telemetry.builtinTools = builtinNames.length;
      telemetry.totalTools = builtinNames.length + extNames.length;
      telemetry.readFilesCount = readFiles.size;
      telemetry.editedFilesCount = editedFiles.size;

      // OpenAI GPT-5 / Codex pricing: $1.25/1M uncached input, $0.125/1M cached input (90% discount), $10.00/1M output
      if (lastTokenUsage) {
        telemetry.inTok = lastTokenUsage.input_tokens || 0;
        telemetry.cacheTok = lastTokenUsage.cached_input_tokens || 0;
        telemetry.outTok = lastTokenUsage.output_tokens || 0;
        telemetry.reasoningTok = (turnTokenUsage?.reasoning_output_tokens ?? lastTokenUsage.reasoning_output_tokens) || 0;
        telemetry.totalCtx = telemetry.inTok + telemetry.outTok;
        telemetry.hitRate = telemetry.inTok > 0 ? (Math.round((telemetry.cacheTok / telemetry.inTok) * 1000) / 10) : 0;
        const tu = turnTokenUsage || lastTokenUsage;
        const turnCostNum = ((tu.cached_input_tokens || 0) * 0.125 + Math.max(0, (tu.input_tokens || 0) - (tu.cached_input_tokens || 0)) * 1.25 + (tu.output_tokens || 0) * 10.0) / 1000000;
        telemetry.turnCost = "$" + turnCostNum.toFixed(3);
      }
      if (totalUsage) {
        const sessionCostNum = ((totalUsage.cached_input_tokens || 0) * 0.125 + Math.max(0, (totalUsage.input_tokens || 0) - (totalUsage.cached_input_tokens || 0)) * 1.25 + (totalUsage.output_tokens || 0) * 10.0) / 1000000;
        const savedNum = ((totalUsage.cached_input_tokens || 0) * (1.25 - 0.125)) / 1000000;
        telemetry.cost = "$" + sessionCostNum.toFixed(2);
        telemetry.sessionCost = "$" + sessionCostNum.toFixed(2);
        if (savedNum > 0.01) telemetry.cacheSaved = "$" + savedNum.toFixed(2);
      } else {
        telemetry.sessionCost = telemetry.cost;
      }
    } catch {}
  }
} else if (agentType === "omp" || agentType === "pi") {
  const dirKey = agentType === "pi" ? "/.pi/agent/sessions" : "/.omp/agent/sessions";
  const bDir = fs.existsSync(effectiveHome + dirKey) ? (effectiveHome + dirKey) : null;
  if (agentType === "omp") {
    const cfgY = effectiveHome + "/.omp/agent/config.yml";
    try {
      const cfgT = remoteBundle ? (remoteBundle.cfgText || "") : (fs.existsSync(cfgY) ? fs.readFileSync(cfgY, "utf8") : "");
      if (cfgT) {
        const mm = cfgT.match(/default:\s*([^\s]+)/);
        if (mm) telemetry.model = mm[1].split("/").pop();
      }
    } catch {}
  }

  let sessFile = remoteBundle ? (remoteBundle.sessionPath || null) : null;
  let sessLines = remoteBundle ? (remoteBundle.tailLines || []) : null;
  if (!remoteBundle && bDir) {
    try {
      const allF = [];
      for (const d of fs.readdirSync(bDir)) {
        const full = bDir + "/" + d;
        try {
          if (fs.statSync(full).isDirectory()) {
            for (const f of fs.readdirSync(full)) {
              if (f.endsWith(".jsonl")) {
                const fp = full + "/" + f;
                const st = fs.statSync(fp);
                allF.push({ path: fp, mtime: st.mtimeMs, size: st.size });
              }
            }
          }
        } catch {}
      }
      if (allF.length > 0) {
        allF.sort((a, b) => b.mtime - a.mtime);
        let matched = null;
        if (chatData?.sessionId) {
          matched = allF.find((f) => f.path.includes(chatData.sessionId));
        }
        if (!matched && cwd) {
          for (const cand of allF.slice(0, 15)) {
            const head = readHeadLines(cand.path, 8192);
            for (const hl of head) {
              try {
                const o = JSON.parse(hl);
                if (o.type === "session" && o.cwd && isSameOrSubPath(o.cwd, cwd, effectiveHome)) {
                  matched = cand;
                  break;
                }
              } catch {}
            }
            if (matched) break;
          }
        }
        sessFile = (matched || allF[0]).path;
        sessLines = readTailLines(sessFile, 262144);
      }
    } catch {}
  }

  if (sessFile && sessLines) {
    try {
      const im = sessFile.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (im) telemetry.sessionId = im[1].slice(0, 8);
      const lines = sessLines;
      telemetry.stepCount = lines.length;
      let totalIn = 0, totalOut = 0, totalCache = 0, totalReason = 0, cumCost = 0, lastCost = 0, turnCount = 0, toolCount = 0, errCount = 0;
      let firstUserTitle = "", latestTitle = "";
      const recent = [], usedTools = new Set(), readFiles = new Set(), editedFiles = new Set(), toolDurs = [], ttfts = [];
      let lastToolStart = null, lastToolName = null, lastToolDetail = "", lastUserTs = null;

      for (const l of lines) {
        try {
          const o = JSON.parse(l);
          const ts = new Date(o.timestamp || o.createdAt || o.message?.timestamp || Date.now()).getTime();
          if ((o.type === "title" || o.type === "title_change") && o.title) latestTitle = o.title;
          if (o.type === "session_info" && o.name) latestTitle = o.name;
          if (o.type === "session" && o.title) latestTitle = o.title;
          if (o.type === "model_change") {
            const mName = o.model || o.modelId;
            if (mName) telemetry.model = String(mName).split("/").pop();
            if (o.provider) telemetry.provider = o.provider;
          }
          if (o.type === "thinking_level_change" && o.thinkingLevel) {
            telemetry.effort = o.thinkingLevel;
          }
          if (o.type === "message" && o.message) {
            const msg = o.message;
            if (msg.provider) telemetry.provider = msg.provider;
            if (msg.model) telemetry.model = String(msg.model).split("/").pop();
            const txt = extractTextContent(msg.content);
            if (msg.role === "system") {
              sysChars += txt.length;
            } else if (msg.role === "user") {
              turnCount++;
              lastUserTs = ts;
              msgChars += txt.length;
              const fl = txt.trim().split(NL)[0].trim();
              if (isMeaningfulPrompt(fl) && !firstUserTitle) firstUserTitle = fl;
            } else if (msg.role === "assistant") {
              msgChars += txt.length;
              if (lastUserTs && ts > lastUserTs && ts - lastUserTs < 120000) {
                ttfts.push(ts - lastUserTs);
                lastUserTs = null;
              }
              if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  if (block?.type === "toolCall" || block?.type === "tool_use") {
                    toolCount++;
                    const nm = block.name || "tool";
                    toolsChars += JSON.stringify(block).length;
                    usedTools.add(nm);
                    const bArgs = block.arguments || block.input || {};
                    const p = bArgs.path || bArgs.file_path;
                    if (p) {
                      if (nm.includes("read")) readFiles.add(p);
                      else if (nm.includes("edit") || nm.includes("write")) editedFiles.add(p);
                    }
                    lastToolStart = ts;
                    lastToolName = nm;
                    lastToolDetail = toolDetail(bArgs);
                  }
                }
              }
              if (msg.usage) {
                const u = msg.usage;
                totalIn = u.input ?? totalIn;
                totalOut = u.output ?? totalOut;
                totalCache = u.cacheRead ?? totalCache;
                totalReason = u.reasoning ?? totalReason;
                if (u.cost?.total) {
                  lastCost = u.cost.total;
                  cumCost += u.cost.total;
                }
              }
            } else if (msg.role === "toolResult") {
              resChars += txt.length;
              const isErr = Boolean(msg.isError);
              if (isErr) errCount++;
              const nm = msg.toolName || lastToolName || "tool";
              usedTools.add(nm);
              const dur = lastToolStart && ts >= lastToolStart ? ts - lastToolStart : 0;
              if (dur > 0 && dur < 120000) toolDurs.push(dur);
              const durStr = dur >= 1000 ? (dur / 1000).toFixed(1) + "s" : dur > 0 ? dur + "ms" : "—";
              recent.push({ name: nm, detail: lastToolDetail, time: fmtTime(ts), status: isErr ? "err" : "ok", ms: durStr });
              lastToolStart = null;
            }
          }
        } catch {}
      }

      if (latestTitle || firstUserTitle) telemetry.sessionTitle = (latestTitle || firstUserTitle).slice(0, 140);
      if (turnCount > 0) telemetry.turn = turnCount;
      telemetry.toolsOk = Math.max(0, toolCount - errCount);
      telemetry.toolsErr = errCount;
      telemetry.toolsPerTurn = (toolCount / Math.max(1, telemetry.turn)).toFixed(1);
      if (toolDurs.length > 0) {
        const avg = Math.round(toolDurs.reduce((s, x) => s + x, 0) / toolDurs.length);
        telemetry.avgToolMs = avg >= 1000 ? (avg / 1000).toFixed(1) + "s" : avg + "ms";
      }
      if (ttfts.length > 0) {
        telemetry.ttft = (ttfts[ttfts.length - 1] / 1000).toFixed(1) + "s";
        telemetry.avgTtft = (ttfts.reduce((s, x) => s + x, 0) / ttfts.length / 1000).toFixed(1) + "s";
      }
      telemetry.usedToolNames = Array.from(usedTools);
      telemetry.usedToolsCount = usedTools.size;
      for (const ut of telemetry.usedToolNames) {
        if (!builtinNames.includes(ut) && !extNames.includes(ut)) builtinNames.push(ut);
      }
      telemetry.builtinTools = builtinNames.length;
      telemetry.totalTools = builtinNames.length + extNames.length;
      telemetry.readFilesCount = readFiles.size;
      telemetry.editedFilesCount = editedFiles.size;
      if (recent.length > 0) telemetry.recentTools = recent.slice(-8).reverse();
      telemetry.inTok = totalIn;
      telemetry.cacheTok = totalCache;
      telemetry.outTok = totalOut;
      telemetry.reasoningTok = totalReason;
      telemetry.totalCtx = totalIn + totalOut + totalCache;
      telemetry.hitRate = (totalIn + totalCache) > 0 ? (Math.round((totalCache / (totalIn + totalCache)) * 1000) / 10) : 0;
      const sessionCostNum = cumCost || ((totalCache * 0.30 + totalIn * 3.0 + totalOut * 15.0) / 1000000);
      const turnCostNum = lastCost || (sessionCostNum / Math.max(1, telemetry.turn));
      telemetry.cost = "$" + sessionCostNum.toFixed(2);
      telemetry.sessionCost = "$" + sessionCostNum.toFixed(2);
      telemetry.turnCost = "$" + turnCostNum.toFixed(3);
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
