// The file menu's items and Mention-in-agent behavior across Files and Review.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const calls = [];
let clip = undefined;
let focusedTerm = null;
let workHidden = true;

const src = fs.readFileSync(path.join(__dirname, "file-menu.js"), "utf8")
  .replace(/^import [^;]*;\r?\n/gm, "").replace(/^export (function|const) /gm, "$1 ")
  + "\nglobalThis.menu = { fileMenuItems, agentFor, mention };";
const context = vm.createContext({
  spaces: () => [{ id: "s1", active: true, tabs: [{ id: "tab1", active: true }] }],
  agents: () => [{ address: "t1", space: "s1", tab: "tab1", focused: false, program: { name: "codex" } }],
  panes: () => [{ pane: "p1", tab: "tab1", terminal: "t1", focused: false }],
  focused: () => ({ terminal: focusedTerm }),
  layout: () => ({ id: "root", children: [{ id: "work", hidden: workHidden }] }),
  run: (name, args) => {
    calls.push([name, args ?? null]);
    if (name === "agent.focus" || name === "pane.focus") focusedTerm = "t1";
  },
  notify() {},
  exec: async () => ({ code: 0 }),
  shared: () => null,
  setShared() {},
});
vm.runInContext(src, context);
const { fileMenuItems, mention } = context.menu;
const ids = (o) => [...fileMenuItems(o).map((it) => it.id)];
const agent = { address: "t1" };

assert.deepEqual(ids({ page: "files", platform: "macos", agent }), ["copy-path", "copy-relative", "mention", "reveal", "open"]);
assert.deepEqual(ids({ page: "files", platform: "macos", agent, changed: true }), ["copy-path", "copy-relative", "mention", "reveal", "open"], "a changed file stays within Files");
assert.deepEqual(ids({ page: "files", platform: "macos", dir: true, changed: true }), ["copy-path", "copy-relative", "cd-terminal", "reveal"], "a folder: terminal action, nothing that opens it");
assert.deepEqual(ids({ page: "files", platform: "macos", remote: true }), ["copy-path", "copy-relative"], "another machine's: nothing that runs here");
assert.deepEqual(ids({ page: "files", platform: "linux" }), ["copy-path", "copy-relative", "open"]);
assert.deepEqual(ids({ page: "review", platform: "macos", agent, files: true }), ["copy-path", "copy-relative", "mention", "reveal", "open", "review"]);
assert.deepEqual(ids({ page: "review", platform: "macos", reviewed: true }), ["copy-path", "copy-relative", "reveal", "open", "unreview"], "reviewed files can be marked unreviewed");
assert.deepEqual(ids({ page: "review", platform: "macos", dir: true, files: true }), ["copy-path", "copy-relative", "reveal", "review"], "a folder marks its files");
for (const page of ["files", "review"]) assert.ok(!ids({ page, platform: "macos", files: true, changed: true }).some(id => id.startsWith("open-")), "neither page offers a cross-page action");

(async () => {
  // Mention works even when clipboard starts empty (`undefined`), reveals hidden `work`, waits before pasting.
  const tasks = [];
  const cx = {
    read_from_clipboard: () => clip,
    write_to_clipboard: (v) => { clip = v; },
    sleep: async () => {},
    spawn: (fn) => { tasks.push(fn(cx)); },
  };
  mention("src\\app.js", "t1", cx);
  await Promise.all(tasks);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["layout.show", { id: "work" }],
    ["agent.focus", { terminal: "t1" }],
    ["pane.focus", { pane: "p1" }],
    ["terminal.paste", null],
  ]);
  assert.equal(clip, "@src/app.js ", "empty clipboard stays with mention text rather than throwing or aborting");

  // With prior text in clipboard, mention pastes then restores prior text.
  calls.length = 0;
  tasks.length = 0;
  workHidden = false;
  clip = "old text";
  mention("README.md", "t1", cx);
  await Promise.all(tasks);
  assert.equal(clip, "old text", "prior text clipboard is restored after paste");
  console.log("ok: file menu and reliable async mention");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
