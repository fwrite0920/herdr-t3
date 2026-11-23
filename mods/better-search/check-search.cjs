// Checks for mods/better-search/model.js and its Herdr T3 integration helpers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  const model = await import(pathToFileURL(path.join(__dirname, "model.js")).href);
  const layoutJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../../layouts/herdr-t3.json"), "utf8"));

  // 1. reveal() locates t3-files in Herdr T3's layout and produces show steps for hidden panel.
  const steps = model.reveal(layoutJson, "t3-files");
  assert.ok(Array.isArray(steps), "reveal should find t3-files in herdr-t3.json");
  assert.deepEqual(steps, [["layout.show", { id: "panel" }]]);

  // If panel-body is on another page, reveal selects files before showing panel.
  const alt = JSON.parse(JSON.stringify(layoutJson));
  const panel = alt.children.find((c) => c.id === "panel");
  panel.children.find((c) => c.id === "panel-body").active = "sessions";
  assert.deepEqual(model.reveal(alt, "t3-files"), [
    ["layout.select", { stack: "panel-body", child: "files" }],
    ["layout.show", { id: "panel" }],
  ]);

  // 2. relToFolder handles Windows drive case, slashes, sub-folders, and out-of-folder paths.
  assert.equal(model.relToFolder("D:/Code/repo", "d:\\Code\\repo\\", "src\\app.js"), "src/app.js");
  assert.equal(model.relToFolder("D:/Code/repo", "D:/Code/repo/packages/web", "packages/web/index.ts"), "index.ts");
  assert.equal(model.relToFolder("D:/Code/repo", "D:/Code/repo/packages/web", "README.md"), null);

  // 3. askOf & outputRows handle Windows CRLF output.
  assert.equal(model.askOf("line 1\r\n│ Should I proceed?\r\n"), "Should I proceed?");
  const out = model.outputRows(
    {
      agents: [{ address: "a1", tab_name: "Build", space_name: "app", status: "working" }],
      output: { a1: "ok\r\nError: missing token\r\nError: missing token\r\n" },
    },
    "missing token",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].agent, "a1");

  // 4. Tab urgency ordering & mixed search drill-down.
  const data = {
    spaces: [
      { id: "s1", name: "app", index: 0, active: true, status: "blocked", tabs: [
        { id: "t1", name: "Quiet", index: 0, status: "idle", active: false },
        { id: "t2", name: "Blocked", index: 1, status: "blocked", active: true, changed_at: Date.now() },
      ] },
    ],
    agents: [{ address: "ag1", tab: "t2", tab_name: "Blocked", space_name: "app", status: "blocked", pinned: false, seq: 1 }],
    machines: [],
    commands: [],
    recent: [],
    files: ["README.md", "src/main.js"],
  };
  const top = model.search(data, "");
  assert.equal(top[0].id, "t2", "blocked tab ranks first");
  const mixed = model.search(data, "main");
  const fileIdx = mixed.findIndex((r) => r.kind === "file");
  assert.ok(fileIdx > 0);
  assert.equal(model.drill(mixed, fileIdx, "main"), "/main");

  // 5. message() formats optional file attachment.
  assert.equal(model.message("Fix this", "D:/Code/a.js"), "Fix this\n\nFile: D:/Code/a.js");
  assert.equal(model.message("Hi", null), "Hi");

  console.log("better-search checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
