const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

async function main() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const mod = await import(pathToFileURL(path.join(__dirname, "model.js")).href);
  const {
    VIEW_MODE_KEY,
    readViewMode,
    writeViewMode,
    buildChangeTree,
    orderedTreeFiles,
    expandAncestors,
    buildStageCommands,
    buildDiscardCommands,
  } = mod;

  // 1. Default view mode is "list" and remembers last selection
  assert.equal(readViewMode(), "list", "defaults to list view");
  assert.equal(writeViewMode("tree"), "tree");
  assert.equal(store.get(VIEW_MODE_KEY), "tree");
  assert.equal(readViewMode(), "tree");
  assert.equal(writeViewMode("list"), "list");
  assert.equal(readViewMode(), "list");

  // 2. Compact folder chains, natural sort, folder-first ordering, and aggregated stats
  const files = [
    { path: "README.md", status: "M", fresh: false, staged: false, unstaged: true, add: 3, del: 1 },
    { path: "mods/t3-changes/file10.js", status: "A", fresh: true, staged: false, unstaged: true, add: 10, del: 0 },
    { path: "mods/t3-changes/file2.js", status: "M", fresh: false, staged: false, unstaged: true, add: 2, del: 4 },
    { path: "mods/t3-changes/icons/a.svg", status: "A", fresh: true, staged: false, unstaged: true, add: 5, del: 0 },
    { path: "a/b/c/deep.txt", status: "D", fresh: false, staged: true, unstaged: false, add: 0, del: 7 },
  ];

  const rows = buildChangeTree(files, new Set(), "all");
  assert.deepEqual(
    rows.map((r) => [r.kind, r.depth, r.name, r.path]),
    [
      ["dir", 0, "a / b / c", "a/b/c"],
      ["file", 1, "deep.txt", "a/b/c/deep.txt"],
      ["dir", 0, "mods / t3-changes", "mods/t3-changes"],
      ["dir", 1, "icons", "mods/t3-changes/icons"],
      ["file", 2, "a.svg", "mods/t3-changes/icons/a.svg"],
      ["file", 1, "file2.js", "mods/t3-changes/file2.js"],
      ["file", 1, "file10.js", "mods/t3-changes/file10.js"],
      ["file", 0, "README.md", "README.md"],
    ],
    "compacts single-child folder chains and sorts folders before files naturally"
  );

  const modsDir = rows.find((r) => r.kind === "dir" && r.path === "mods/t3-changes");
  assert.equal(modsDir.count, 3);
  assert.equal(modsDir.add, 17);
  assert.equal(modsDir.del, 4);
  assert.equal(modsDir.allStaged, false);
  assert.deepEqual(
    modsDir.files.map((f) => f.path),
    ["mods/t3-changes/icons/a.svg", "mods/t3-changes/file2.js", "mods/t3-changes/file10.js"]
  );

  const deepDir = rows.find((r) => r.kind === "dir" && r.path === "a/b/c");
  assert.equal(deepDir.allStaged, true);
  assert.equal(deepDir.del, 7);

  // 3. Collapsing hides descendants while keeping compacted label & stats; separate groups stay independent
  const collapsed = new Set(["all:mods/t3-changes"]);
  const foldedRows = buildChangeTree(files, collapsed, "all");
  assert.deepEqual(
    foldedRows.map((r) => [r.kind, r.path, r.open ?? null]),
    [
      ["dir", "a/b/c", true],
      ["file", "a/b/c/deep.txt", null],
      ["dir", "mods/t3-changes", false],
      ["file", "README.md", null],
    ]
  );
  const stagedRows = buildChangeTree(files, collapsed, "staged");
  assert.equal(stagedRows.find((r) => r.path === "mods/t3-changes").open, true, "other section group unaffected");

  // 4. Visual tree order & ancestor expansion
  assert.deepEqual(
    orderedTreeFiles(files).map((f) => f.path),
    [
      "a/b/c/deep.txt",
      "mods/t3-changes/icons/a.svg",
      "mods/t3-changes/file2.js",
      "mods/t3-changes/file10.js",
      "README.md",
    ]
  );
  expandAncestors(collapsed, "mods/t3-changes/icons/a.svg");
  assert.equal(collapsed.has("all:mods/t3-changes"), false, "expands collapsed ancestor");

  // 5. Folder-level stage / unstage commands (with chunking and no-HEAD handling)
  assert.deepEqual(
    buildStageCommands(modsDir.files, { unstage: false, hasHead: true, chunkSize: 2 }),
    [
      ["add", "--", "mods/t3-changes/icons/a.svg", "mods/t3-changes/file2.js"],
      ["add", "--", "mods/t3-changes/file10.js"],
    ]
  );
  assert.deepEqual(
    buildStageCommands(modsDir.files, { unstage: true, hasHead: true }),
    [["reset", "HEAD", "--", "mods/t3-changes/icons/a.svg", "mods/t3-changes/file2.js", "mods/t3-changes/file10.js"]]
  );
  assert.deepEqual(
    buildStageCommands(modsDir.files, { unstage: true, hasHead: false }),
    [["rm", "--cached", "--", "mods/t3-changes/icons/a.svg", "mods/t3-changes/file2.js", "mods/t3-changes/file10.js"]]
  );

  // 6. Folder-level discard commands for mixed file states
  const mixed = [
    { path: "dir/untracked.js", status: "A", fresh: true },
    { path: "dir/staged-new.js", status: "A", fresh: false },
    { path: "dir/modified.js", status: "M", fresh: false },
    { path: "dir/deleted.js", status: "D", fresh: false },
  ];
  assert.deepEqual(
    buildDiscardCommands(mixed, { hasHead: true }),
    [
      ["reset", "HEAD", "--", "dir/staged-new.js"],
      ["clean", "-fd", "--", "dir/staged-new.js"],
      ["clean", "-fd", "--", "dir/untracked.js"],
      ["checkout", "HEAD", "--", "dir/modified.js", "dir/deleted.js"],
    ]
  );
  assert.deepEqual(
    buildDiscardCommands(mixed.slice(0, 2), { hasHead: false }),
    [
      ["rm", "--cached", "--", "dir/staged-new.js"],
      ["clean", "-fd", "--", "dir/staged-new.js"],
      ["clean", "-fd", "--", "dir/untracked.js"],
    ]
  );

  console.log("check-changes passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
