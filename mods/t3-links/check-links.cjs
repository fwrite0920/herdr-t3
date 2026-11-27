// Unit tests for mods/t3-links: line/column parsing, path resolution (Windows, POSIX, remote, file://),
// binary filtering, space root mapping, and handleLink behavior.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const parserSrc = fs.readFileSync(path.join(__dirname, "parser.js"), "utf8")
  .replace(/^export (function|const) /gm, "$1 ");
const linkSrc = fs.readFileSync(path.join(__dirname, "link.js"), "utf8")
  .replace(/^import [^;]*;\r?\n/gm, "")
  .replace(/^export (async function|function|const) /gm, "$1 ");

const ctx = vm.createContext({});
vm.runInContext(parserSrc + "\nglobalThis.p = { BINARY, normPath, parseLinkPlace, resolveLinkPath, resolveSpaceRoot, relativeToRoot };", ctx);
const p = ctx.p;
const plain = (v) => JSON.parse(JSON.stringify(v));

// 1. Line/column/range/anchor parsing
assert.deepEqual(plain(p.parseLinkPlace("src/app.ts:42")), { line: 42, col: null, rest: "src/app.ts" });
assert.deepEqual(plain(p.parseLinkPlace("src/app.ts:42:7")), { line: 42, col: 7, rest: "src/app.ts" });
assert.deepEqual(plain(p.parseLinkPlace("src/app.ts(42,7)")), { line: 42, col: 7, rest: "src/app.ts" });
assert.deepEqual(plain(p.parseLinkPlace("src/app.ts(42, 7).")), { line: 42, col: 7, rest: "src/app.ts" });
assert.deepEqual(plain(p.parseLinkPlace("src/app.ts:5-12")), { line: 5, col: null, rest: "src/app.ts" });
assert.deepEqual(plain(p.parseLinkPlace("src/app.ts#L42")), { line: 42, col: null, rest: "src/app.ts" });
assert.deepEqual(plain(p.parseLinkPlace("src/app.ts#L5-L12.")), { line: 5, col: null, rest: "src/app.ts" });
assert.deepEqual(plain(p.parseLinkPlace("src/app.ts")), { line: null, col: null, rest: "src/app.ts" });

// 2. Path resolution (Windows, POSIX, relative, file://, remote ~)
assert.equal(p.resolveLinkPath({ path: "D:\\Code\\proj\\src\\a.ts" }, {}, "src/a.ts"), "D:/Code/proj/src/a.ts");
assert.equal(p.resolveLinkPath({ path: null }, { cwd: "D:\\Code\\proj" }, "./src/a.ts"), "D:/Code/proj/src/a.ts");
assert.equal(p.resolveLinkPath({ path: null }, { cwd: "/work/app", machine: "vps" }, "lib/x.js"), "/work/app/lib/x.js");
assert.equal(p.resolveLinkPath({ path: null }, { cwd: "/work/app", machine: "vps" }, "~/x.js"), null, "remote ~ passes through");
assert.equal(p.resolveLinkPath({ path: null }, { cwd: "/work/app" }, "file:///D:/Code/proj/a.ts"), "D:/Code/proj/a.ts");

// 3. Relative-to-root mapping (Windows case-insensitive, POSIX case-sensitive, rejects outside root)
assert.equal(p.relativeToRoot("d:/code/proj/src/main.js", "D:/Code/proj"), "src/main.js");
assert.equal(p.relativeToRoot("D:/Code/other/main.js", "D:/Code/proj"), null);
assert.equal(p.relativeToRoot("/work/app/README.md", "/work/app"), "README.md");
assert.equal(p.relativeToRoot("/work/app2/README.md", "/work/app"), null);
assert.equal(p.relativeToRoot("/work/app", "/work/app"), null);

// 4. Binary filter: images open in t3-files, archives/PDFs pass through
assert.equal(p.BINARY.test("shot.png"), false);
assert.equal(p.BINARY.test("diagram.svg"), false);
assert.equal(p.BINARY.test("spec.pdf"), true);
assert.equal(p.BINARY.test("bundle.zip"), true);

// 5. Integration test of handleLink (local, remote, out-of-root, binary, directory)
async function checkHandleLink() {
  const ran = [], shared = {};
  const sp = { id: "s1", active: true, folder: "D:/Code/proj", machine: null, tabs: [{ id: "t1", active: true }] };
  const spRemote = { id: "s2", active: false, folder: "/srv/app", machine: "vps", tabs: [{ id: "t2", active: true }] };
  const existing = new Set(["D:/Code/proj/src/app.ts", "D:/Code/other/ext.ts"]);
  const linkCtx = vm.createContext({
    KEY: { filesOpen: "t3.filesOpen" },
    ...p,
    spaces: () => [sp, spRemote],
    panes: () => [{ pane: "p1", tab: "t1", cwd: "D:/Code/proj/src" }, { pane: "p2", tab: "t2", cwd: "/srv/app" }],
    home: () => "C:/Users/test",
    run: (name, args) => ran.push([name, args]),
    setShared: (k, v) => { shared[k] = v; },
    exec: async (cmd, args, opts) => (cmd === "test" && args[0] === "-f" && opts.on === "vps" && args[1] === "/srv/app/api/x.py" ? { code: 0 } : { code: 1 }),
    fs: { stat: async (fp) => existing.has(fp) ? { isFile: () => true } : Promise.reject(new Error("ENOENT")) },
  });
  vm.runInContext(linkSrc, linkCtx);

  // Local file with :line:col inside space opens in t3-files
  const res1 = await linkCtx.handleLink({
    link: { kind: "file", raw: "src/app.ts:42:7", path: "D:\\Code\\proj\\src\\app.ts", line: 42, column: 7 },
    source: { terminal: "term1", machine: null, cwd: "D:\\Code\\proj", pane: "p1", tab: "t1", space: "s1" },
  });
  assert.equal(res1, "handled");
  assert.equal(shared["t3.filesOpen"].space, "s1");
  assert.equal(shared["t3.filesOpen"].path, "src/app.ts");
  assert.equal(shared["t3.filesOpen"].line, 42);
  assert.equal(shared["t3.filesOpen"].col, 7);
  assert.deepEqual(plain(ran), [["layout.select", { stack: "panel-body", child: "files" }], ["layout.show", { id: "panel" }]]);

  // Outside space root passes through
  ran.length = 0;
  const res2 = await linkCtx.handleLink({
    link: { kind: "file", raw: "D:/Code/other/ext.ts:10", path: "D:/Code/other/ext.ts", line: 10 },
    source: { terminal: "term1", machine: null, cwd: "D:\\Code\\proj", pane: "p1", tab: "t1", space: "s1" },
  });
  assert.equal(res2, "pass");
  assert.deepEqual(plain(ran), []);

  // Remote file with (12, 3) switches to its space and opens in t3-files
  const res3 = await linkCtx.handleLink({
    link: { kind: "file", raw: "api/x.py(12, 3)", path: null },
    source: { terminal: "vps/t2", machine: "vps", cwd: "/srv/app", pane: "p2", tab: "t2", space: "s2" },
  });
  assert.equal(res3, "handled");
  assert.equal(shared["t3.filesOpen"].space, "s2");
  assert.equal(shared["t3.filesOpen"].path, "api/x.py");
  assert.equal(shared["t3.filesOpen"].line, 12);
  assert.equal(shared["t3.filesOpen"].col, 3);
  assert.deepEqual(plain(ran[0]), ["space.select", { id: "s2" }]);

  // URL or binary passes through
  assert.equal(await linkCtx.handleLink({ link: { kind: "url", raw: "https://herdr.dev", url: "https://herdr.dev" }, source: { tab: "t1" } }), "pass");
  assert.equal(await linkCtx.handleLink({ link: { kind: "file", raw: "docs/a.pdf", path: "D:/Code/proj/docs/a.pdf" }, source: { tab: "t1", space: "s1" } }), "pass");
}

checkHandleLink().then(() => {
  console.log("ok: t3-links parses line/col/range/anchor, maps local/remote paths into space root, and passes through binaries/out-of-root.");
}).catch((e) => { console.error(e); process.exit(1); });
