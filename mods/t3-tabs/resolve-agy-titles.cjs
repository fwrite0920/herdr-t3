// Read-only Antigravity conversation title resolver for Herdr T3.
// Reads ~/.gemini/antigravity-cli/conversation_summaries.db (via Node's built-in node:sqlite)
// and falls back to ~/.gemini/antigravity-cli/history.jsonl when sqlite is unavailable.
// Usage: node resolve-agy-titles.cjs <homeDir> <targetsJson>
// targetsJson: [{ address, cwd, status, convId? }]
const fs = require("node:fs");
const path = require("node:path");

function normPath(p) {
  if (!p) return "";
  let s = String(p).trim();
  if (/^file:\/\//i.test(s)) {
    try { s = decodeURIComponent(s.replace(/^file:\/\/(?:localhost)?/i, "")); } catch {}
    if (/^\/[a-zA-Z]:\//.test(s)) s = s.slice(1);
  }
  s = s.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\/+$/.test(s)) return (s.slice(0, 2) + "/").toLowerCase();
  if (/^\/+$/.test(s)) return "/";
  s = s.replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(s) ? s.toLowerCase() : s;
}

function pathScore(candCwd, targetCwd) {
  const a = normPath(candCwd), b = normPath(targetCwd);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (b.startsWith(a + "/") || a.startsWith(b + "/")) return 1;
  return 0;
}

function parseWorkspaceUris(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(normPath).filter(Boolean) : [];
  } catch { return []; }
}

function readDbRows(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(
        "SELECT conversation_id, title, workspace_uris, status, last_modified_time FROM conversation_summaries WHERE title != '' ORDER BY last_modified_time DESC LIMIT 80"
      ).all();
      return rows.map((r) => ({
        id: String(r.conversation_id || ""),
        title: String(r.title || "").trim(),
        workspaces: parseWorkspaceUris(r.workspace_uris),
        running: String(r.status || "").includes("RUNNING"),
        modified: String(r.last_modified_time || ""),
      })).filter((r) => r.id && r.title);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readHistoryRows(histPath) {
  if (!fs.existsSync(histPath)) return [];
  try {
    const raw = fs.readFileSync(histPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const byId = new Map();
    const order = [];
    let lastUntagged = null;
    for (const line of lines.slice(-500)) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const ws = normPath(row.workspace || "");
      const disp = String(row.display || "").trim().replace(/\s+/g, " ");
      const isCmd = row.type === "slash_command" || disp.startsWith("/");
      const id = row.conversationId ? String(row.conversationId) : "";
      if (!id) {
        if (!isCmd && disp.length >= 2 && ws) lastUntagged = { ws, disp, ts: Number(row.timestamp) || 0 };
        continue;
      }
      let entry = byId.get(id);
      if (!entry) {
        entry = { id, title: "", workspaces: ws ? [ws] : [], running: false, ts: 0 };
        if (lastUntagged && lastUntagged.ws === ws && (Number(row.timestamp) || 0) - lastUntagged.ts < 30 * 60 * 1000) {
          entry.title = lastUntagged.disp.slice(0, 120);
        }
        byId.set(id, entry);
        order.push(entry);
      }
      if (ws && !entry.workspaces.includes(ws)) entry.workspaces.push(ws);
      entry.ts = Math.max(entry.ts, Number(row.timestamp) || 0);
      if (!isCmd && disp.length >= 2 && !entry.title) entry.title = disp.slice(0, 120);
    }
    return order.filter((e) => e.title).sort((a, b) => b.ts - a.ts);
  } catch {
    return [];
  }
}

function resolveTargets(homeDir, targets) {
  const base = path.join(homeDir, ".gemini", "antigravity-cli");
  const rows = readDbRows(path.join(base, "conversation_summaries.db")) ?? readHistoryRows(path.join(base, "history.jsonl"));
  const out = {};
  if (!rows.length || !Array.isArray(targets)) return out;
  const used = new Set();

  for (const t of targets) {
    if (!t?.address) continue;
    let best = null, bestScore = -1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (t.convId && (r.id === t.convId || r.id.startsWith(t.convId))) {
        best = r; bestScore = 1000; break;
      }
      let wsScore = 0;
      for (const w of r.workspaces) wsScore = Math.max(wsScore, pathScore(w, t.cwd));
      if (wsScore === 0) continue;
      let score = wsScore * 100 - i;
      if (t.status === "working" && r.running) score += 40;
      if (used.has(r.id)) score -= 50;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (best?.title) {
      used.add(best.id);
      out[t.address] = best.title;
    }
  }
  return out;
}

if (require.main === module) {
  const homeDir = process.argv[2] || "";
  let targets = [];
  try { targets = JSON.parse(process.argv[3] || "[]"); } catch {}
  process.stdout.write(JSON.stringify(resolveTargets(homeDir, targets)));
}

module.exports = { resolveTargets, normPath, pathScore };
