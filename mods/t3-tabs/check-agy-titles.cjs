// Unit tests for mods/t3-tabs/resolve-agy-titles.cjs: SQLite conversation_summaries.db lookup,
// running-status tie-breaking, duplicate-session avoidance, and history.jsonl fallback.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { resolveTargets, normPath } = require("./resolve-agy-titles.cjs");

assert.equal(normPath("file:///D:/Code/Personal/herdr-t3"), "d:/code/personal/herdr-t3");
assert.equal(normPath("file:///d%3A/Code/Work/Vi-Link"), "d:/code/work/vi-link");
assert.equal(normPath("D:\\Code\\Personal\\herdr-t3\\"), "d:/code/personal/herdr-t3");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-agy-titles-"));
try {
  const cliDir = path.join(tmp, ".gemini", "antigravity-cli");
  fs.mkdirSync(cliDir, { recursive: true });

  // 1. history.jsonl fallback when DB is absent
  fs.writeFileSync(path.join(cliDir, "history.jsonl"), [
    JSON.stringify({ display: "/usage", timestamp: 1000, workspace: "D:\\Code\\App", type: "slash_command" }),
    JSON.stringify({ display: "Fix login redirect loop", timestamp: 1100, workspace: "D:\\Code\\App" }),
    JSON.stringify({ display: "ok", timestamp: 1200, workspace: "D:\\Code\\App", conversationId: "c1" }),
  ].join("\n") + "\n");
  const fromHist = resolveTargets(tmp, [{ address: "t1", cwd: "D:\\Code\\App", status: "idle" }]);
  assert.equal(fromHist.t1, "Fix login redirect loop", "falls back to history.jsonl and links untagged first prompt");

  // 2. conversation_summaries.db takes precedence and prefers RUNNING row for working terminals
  const dbPath = path.join(cliDir, "conversation_summaries.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id text PRIMARY KEY,
    title text NOT NULL DEFAULT '',
    workspace_uris text NOT NULL,
    status text NOT NULL DEFAULT '',
    last_modified_time text NOT NULL
  )`);
  const ins = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)");
  ins.run("c-old", "Old Completed Task", '["file:///D:/Code/Personal/herdr-t3"]', "CASCADE_RUN_STATUS_IDLE", "2026-11-27 02:30:00+00:00");
  ins.run("c-run", "GitHub Repository Layout Analysis", '["file:///D:/Code/Personal/herdr-t3"]', "CASCADE_RUN_STATUS_RUNNING", "2026-11-27 02:29:00+00:00");
  ins.run("c-other", "Other Repo Task", '["file:///d%3A/Code/Work/Vi-Link"]', "CASCADE_RUN_STATUS_IDLE", "2026-11-27 02:20:00+00:00");
  db.close();

  const fromDb = resolveTargets(tmp, [
    { address: "t28", cwd: "D:\\Code\\Personal\\herdr-t3", status: "working" },
    { address: "t29", cwd: "D:\\Code\\Work\\Vi-Link", status: "done" },
  ]);
  assert.equal(fromDb.t28, "GitHub Repository Layout Analysis", "prefers RUNNING conversation for working terminal");
  assert.equal(fromDb.t29, "Other Repo Task", "decodes percent-encoded Windows file:///d%3A URI");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("ok: resolve-agy-titles resolves Antigravity titles from conversation_summaries.db and history.jsonl.");
