const fs = require("fs");
const os = require("os");
const NL = String.fromCharCode(10);

function unquote(v) {
  if (typeof v !== "string") return v ?? "";
  let s = v.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try { s = JSON.parse(s); } catch { s = s.slice(1, -1); }
  }
  return String(s ?? "");
}

function norm(p) {
  const raw = unquote(p);
  return raw ? raw.split(String.fromCharCode(92)).join("/").replace(/\/+/g, "/").replace(/\/+$/, "") : "";
}

const h = norm(process.argv[2] || os.homedir());
const cacheFile = norm(os.tmpdir()) + "/herdr-t3-sessions-cache-v3.json";
let cache = {};
let cacheDirty = false;
try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { cache = {}; }

function cached(fp, mtime, build) {
  const hit = cache[fp];
  if (hit && hit.mtime === mtime && hit.item) return hit.item;
  const item = build();
  cache[fp] = { mtime, item };
  cacheDirty = true;
  return item;
}

function readHead(fp, size, maxBytes = 32768) {
  const len = Math.min(size, maxBytes);
  if (len <= 0) return "";
  const fd = fs.openSync(fp, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function scanPi(h) {
  const out = [];
  const base = h + "/.pi/agent/sessions";
  try {
    const subs = fs.readdirSync(base);
    for (const sub of subs) {
      const dir = base + "/" + sub;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          const fp = dir + "/" + file;
          try {
            const stat = fs.statSync(fp);
            out.push(cached(fp, stat.mtimeMs, () => {
              const head = readHead(fp, stat.size);
              const first = head.split(NL)[0];
              const o = JSON.parse(first || "{}");
              const ident = o.id || file.replace(/\.jsonl$/, "").split("_").pop() || file;
              let title = "";
              for (const line of head.split(NL)) {
                if (!line.trim()) continue;
                try {
                  const row = JSON.parse(line);
                  if (row.type === "session_info" && row.name) { title = row.name; break; }
                  const msg = row.message || {};
                  if ((row.type === "user" || msg.role === "user") && !title) {
                    const c = msg.content || row.content;
                    title = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text || "").join(" ") : "";
                    if (title.trim()) break;
                  }
                } catch {}
              }
              return { agent: "pi", id: ident, file, cwd: norm(o.cwd || ""), mtime: stat.mtimeMs, title: title.trim().slice(0, 200) };
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
  const base = h + "/.omp/agent/sessions";
  try {
    const subs = fs.readdirSync(base);
    for (const sub of subs) {
      const dir = base + "/" + sub;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          const fp = dir + "/" + file;
          try {
            const stat = fs.statSync(fp);
            out.push(cached(fp, stat.mtimeMs, () => {
              const head = readHead(fp, stat.size);
              let title = "", ident = file.replace(/\.jsonl$/, "").split("_").pop() || file, cwd = "";
              for (const line of head.split(NL)) {
                if (!line.trim()) continue;
                try {
                  const row = JSON.parse(line);
                  if ((row.type === "title" || row.type === "title_change") && row.title) title = row.title;
                  if (row.type === "session") {
                    if (row.id) ident = row.id;
                    if (row.cwd) cwd = norm(row.cwd);
                    if (row.title && !title) title = row.title;
                  }
                  if (!title && row.type === "message" && row.message?.role === "user") {
                    const c = row.message.content;
                    title = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text || "").join(" ") : "";
                  }
                  if (title && cwd) break;
                } catch {}
              }
              return { agent: "omp", id: ident, file, cwd, mtime: stat.mtimeMs, title: title.trim().slice(0, 200) || "Omp Session" };
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
  const base = h + "/.claude/projects";
  try {
    const subs = fs.readdirSync(base);
    for (const sub of subs) {
      const dir = base + "/" + sub;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          const fp = dir + "/" + file;
          try {
            const stat = fs.statSync(fp);
            out.push(cached(fp, stat.mtimeMs, () => {
              const head = readHead(fp, stat.size);
              const first = head.split(NL)[0];
              const o = JSON.parse(first || "{}");
              const ident = file.replace(/\.jsonl$/, "");
              let title = "";
              for (const line of head.split(NL)) {
                if (!line.trim()) continue;
                try {
                  const row = JSON.parse(line);
                  const msg = row.message || {};
                  if (row.type === "user" || msg.role === "user") {
                    const c = msg.content || row.content;
                    title = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text || "").join(" ") : "";
                    if (title.trim()) break;
                  }
                } catch {}
              }
              return { agent: "cc", id: ident, file, cwd: norm(o.cwd || ""), mtime: stat.mtimeMs, title: title.trim().slice(0, 200) };
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
  const base = h + "/.gemini/antigravity-cli/brain";
  try {
    const dirs = fs.readdirSync(base);
    for (const id of dirs) {
      const transcript = base + "/" + id + "/.system_generated/logs/transcript.jsonl";
      if (fs.existsSync(transcript)) {
        try {
          const stat = fs.statSync(transcript);
          if (stat.size <= 0) continue;
          out.push(cached(transcript, stat.mtimeMs, () => {
            const data = readHead(transcript, stat.size, 32768);
            let title = "", cwd = "";
            for (const line of data.split(NL)) {
              if (!line.trim()) continue;
              try {
                const o = JSON.parse(line);
                if (o.type === "USER_INPUT") {
                  const c = typeof o.content === "string" ? o.content : "";
                  if (!title) {
                    const sReq = c.indexOf("<USER_REQUEST>");
                    if (sReq !== -1) {
                      const eReq = c.indexOf("</USER_REQUEST>", sReq);
                      if (eReq !== -1) title = c.slice(sReq + 14, eReq).trim();
                    }
                    if (!title && c) title = c.replace(/<[^>]+>/g, "").trim().slice(0, 200);
                  }
                  if (!cwd && c) {
                    const cwM = c.match(/Command Working Directory:\s*([^\r\n<]+)/);
                    if (cwM && cwM[1].trim()) cwd = norm(cwM[1].trim());
                  }
                }
                if (o.tool_calls) {
                  for (const tc of o.tool_calls) {
                    const args = tc.args || tc.function?.arguments;
                    const a = typeof args === "string" ? JSON.parse(args) : args;
                    const rawP = norm(a?.Cwd || a?.Path || a?.Workspace || "");
                    if (rawP && !rawP.includes("/.gemini/") && !rawP.includes("/AppData/")) {
                      const dirP = rawP.replace(/\/[^/]+\.[a-zA-Z0-9_-]{1,10}$/, "");
                      if (dirP.length > 3) {
                        cwd = dirP;
                        break;
                      }
                    }
                  }
                }
                if (title && cwd && cwd.split("/").length > 2) break;
              } catch {}
            }
            return { agent: "agy", id: id.slice(0, 8), file: id, cwd: norm(cwd), mtime: stat.mtimeMs, title: (title || "Antigravity Session").slice(0, 200) };
          }));
        } catch {}
      }
    }
  } catch {}
  return out;
}

function scanCodexDirs(base, prefix = "", wslDistro = "") {
  const out = [];
  if (!fs.existsSync(base)) return out;
  try {
    function walk(dir, depth = 0) {
      if (depth > 4) return;
      for (const item of fs.readdirSync(dir)) {
        const full = dir + "/" + item;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full, depth + 1);
        else if (item.endsWith(".jsonl") && stat.size > 200) {
          try {
            out.push(cached(full, stat.mtimeMs, () => {
              const head = readHead(full, stat.size, 131072);
              let title = "", cwd = "";
              for (const line of head.split(NL)) {
                if (!line.trim()) continue;
                try {
                  const o = JSON.parse(line);
                  if ((o.type === "session_meta" || o.type === "turn_context") && o.payload?.cwd && !cwd) cwd = o.payload.cwd;
                  if (o.payload?.item?.type === "UserMessage" && !title) {
                    const c = o.payload.item.content;
                    title = Array.isArray(c) ? c.map((x) => x?.text || "").join(" ").trim() : String(c || o.payload.item.text || "").trim();
                  }
                  if (title && cwd) break;
                } catch {}
              }
              const um = item.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
              const id = um ? um[1] : item.replace(/\.jsonl$/, "").split("-").pop();
              return { agent: "codex", id: prefix ? prefix + "/" + id : id, file: item, cwd: norm(cwd), mtime: stat.mtimeMs, title: (title.slice(0, 200) || "Codex Session"), ...(wslDistro ? { wslDistro } : {}) };
            }));
          } catch {}
        }
      }
    }
    walk(base);
  } catch {}
  return out;
}

const wslCodex = [];
if (process.platform === "win32") {
  try {
    const { execFileSync } = require("child_process");
    const rawD = execFileSync("wsl.exe", ["-l", "-q"], { timeout: 1200, stdio: ["ignore", "pipe", "ignore"] }).toString("utf16le").replace(/\0/g, "");
    const distros = rawD.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const distro of distros) {
      const homeBase = "//wsl.localhost/" + distro + "/home";
      try {
        for (const user of fs.readdirSync(homeBase)) {
          wslCodex.push(...scanCodexDirs(homeBase + "/" + user + "/.codex/sessions", "wsl", distro));
        }
      } catch {}
    }
  } catch {}
}
const localCodex = scanCodexDirs(h + "/.codex/sessions");

const remoteList = [];
try {
  const { execFileSync } = require("child_process");
  const lsOut = execFileSync("hc", ["ls"], { timeout: 1200, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const lsObj = JSON.parse(lsOut);
  const remotes = (lsObj.machines || []).filter((m) => m.state === "connected" && m.name && m.name !== "wsl");
  if (remotes.length > 0) {
    const py = [
      "import os,json,re",
      "home=os.path.expanduser('~')",
      "out=[]",
      "def head_read(fp,mb=131072):",
      "  with open(fp,'r',encoding='utf-8',errors='ignore') as f: return f.read(mb)",
      "cb=home+'/.codex/sessions'",
      "if os.path.isdir(cb):",
      "  for r,_ds,fs in os.walk(cb):",
      "    for fn in fs:",
      "      if not fn.endswith('.jsonl'): continue",
      "      fp=os.path.join(r,fn)",
      "      try:",
      "        mt=os.path.getmtime(fp)*1000",
      "        cwd=''; title=''",
      "        for ln in head_read(fp).splitlines():",
      "          if not ln.strip(): continue",
      "          try:",
      "            o=json.loads(ln)",
      "            if o.get('type') in ('session_meta','turn_context') and (o.get('payload') or {}).get('cwd') and not cwd: cwd=o['payload']['cwd']",
      "            it=(o.get('payload') or {}).get('item') or {}",
      "            if it.get('type')=='UserMessage' and not title:",
      "              c=it.get('content')",
      "              title=' '.join(x.get('text','') for x in c).strip() if isinstance(c,list) else str(c or it.get('text','')).strip()",
      "            if cwd and title: break",
      "          except Exception: pass",
      "        sid=fn[:-6].split('-')[-1]",
      "        m=re.search(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',fn,re.I)",
      "        if m: sid=m.group(1)",
      "        out.append({'agent':'codex','id':sid,'file':fn,'cwd':cwd,'mtime':mt,'title':(title[:200] or 'Codex Session')})",
      "      except Exception: pass",
      "print(json.dumps(out))"
    ].join("\n");
    const b64 = Buffer.from(py).toString("base64");
    const cmd = "echo " + b64 + " | base64 -d | python3 -";
    for (const rm of remotes.slice(0, 4)) {
      try {
        const rout = execFileSync("hc", ["exec", "--on", rm.name, cmd], { timeout: 2200, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const arr = JSON.parse(rout.trim() || "[]");
        for (const it of arr) {
          remoteList.push({ ...it, id: rm.name + "/" + it.id, machine: rm.name });
        }
      } catch {}
    }
  }
} catch {}

const list = [...scanPi(h), ...scanOmp(h), ...scanClaude(h), ...scanAgy(h), ...wslCodex, ...localCodex, ...remoteList];
if (cacheDirty) { try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch {} }
process.stdout.write(JSON.stringify(list));
