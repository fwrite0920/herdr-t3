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
    TAB_KEY,
    LOG_SCOPE_KEY,
    DIFF_WRAP_KEY,
    CHANGES_SPLIT_KEY,
    readViewMode,
    writeViewMode,
    readActiveTab,
    writeActiveTab,
    readLogScope,
    writeLogScope,
    readDiffWrap,
    writeDiffWrap,
    readSplitHeight,
    writeSplitHeight,
    parseBranchHeader,
    parseRefDecorations,
    parseUnpushedShas,
    parseGitLog,
    parseLogQuery,
    buildLogArgs,
    filterCommits,
    parseCommitFiles,
    parseBranches,
    parseStashes,
    parseWorktrees,
    buildWorkingDiffArgs,
    diffRows,
    formatAgentMention,
    buildChangeTree,
    orderedTreeFiles,
    expandAncestors,
  } = mod;

  // 1. Persisted preferences (view mode, sub-tab, log scope, diff wrap, split height)
  assert.equal(readViewMode(), "list", "defaults to list view");
  assert.equal(writeViewMode("tree"), "tree");
  assert.equal(store.get(VIEW_MODE_KEY), "tree");
  assert.equal(readViewMode(), "tree");

  assert.equal(readActiveTab(), "changes", "defaults to changes sub-tab");
  assert.equal(writeActiveTab("log"), "log");
  assert.equal(store.get(TAB_KEY), "log");
  assert.equal(writeActiveTab("invalid"), "changes");

  assert.equal(readLogScope(), "current");
  assert.equal(writeLogScope("all"), "all");
  assert.equal(store.get(LOG_SCOPE_KEY), "all");

  assert.equal(readDiffWrap(), false);
  assert.equal(writeDiffWrap(true), true);
  assert.equal(store.get(DIFF_WRAP_KEY), "true");
  assert.equal(readDiffWrap(), true);

  assert.equal(readSplitHeight(CHANGES_SPLIT_KEY, 200), 200);
  assert.equal(writeSplitHeight(CHANGES_SPLIT_KEY, 600, 90, 440), 440, "clamps to max");
  assert.equal(readSplitHeight(CHANGES_SPLIT_KEY, 200, 90, 440), 440);

  // 2. Branch header parsing
  assert.deepEqual(
    parseBranchHeader("## main...origin/main [ahead 2, behind 1]", "375454a"),
    { branch: "main", upstream: "origin/main", ahead: 2, behind: 1, gone: false, detached: false, unborn: false, headSha: "375454a" }
  );
  assert.deepEqual(
    parseBranchHeader("## feat/git...origin/feat/git [gone]", "abc1234"),
    { branch: "feat/git", upstream: "origin/feat/git", ahead: 0, behind: 0, gone: true, detached: false, unborn: false, headSha: "abc1234" }
  );
  assert.deepEqual(
    parseBranchHeader("## No commits yet on main", ""),
    { branch: "main", upstream: "", ahead: 0, behind: 0, gone: false, detached: false, unborn: true, headSha: "" }
  );
  assert.deepEqual(
    parseBranchHeader("## HEAD (no branch)", "1358f24"),
    { branch: "HEAD@1358f24", upstream: "", ahead: 0, behind: 0, gone: false, detached: true, unborn: false, headSha: "1358f24" }
  );

  // 3. Ref decorations, unpushed set, Git Log parsing & backend query builder
  const remotes = new Set(["origin", "upstream"]);
  assert.deepEqual(
    parseRefDecorations("HEAD -> main, origin/main, origin/HEAD, tag: v1.2.0, feat/log", remotes),
    [
      { kind: "head", label: "main", isHead: true },
      { kind: "remote", label: "origin/main", isHead: false },
      { kind: "tag", label: "v1.2.0", isHead: false },
      { kind: "local", label: "feat/log", isHead: false },
    ]
  );

  const unpushed = parseUnpushedShas("375454aaaa\nnot-a-sha\n");
  assert.equal(unpushed.has("375454aaaa"), true);
  assert.equal(unpushed.size, 1);

  const sampleLog = [
    "\x1e375454aaaa\x1f375454a\x1f1358f24bbb\x1fHEAD -> main, origin/main\x1fAlice\x1falice@example.com\x1f2 hours ago\x1f2026-11-24T12:00:00+08:00\x1ffeat(git): add log viewer\x1fBody line 1\nBody line 2",
    "\x1e1358f24bbb\x1f1358f24\x1f000111 222333\x1ftag: v1.0\x1fBob\x1fbob@example.com\x1f3 days ago\x1f2026-11-21T10:00:00+08:00\x1fMerge branch 'feat/x'\x1f",
  ].join("\n");
  const commits = parseGitLog(sampleLog, remotes, unpushed);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].unpushed, true);
  assert.equal(commits[1].unpushed, false);
  assert.equal(commits[1].isMerge, true);

  assert.deepEqual(parseLogQuery("author:Alice path:mods/t3-changes/main.js viewer"), {
    path: "mods/t3-changes/main.js",
    author: "Alice",
    grep: "viewer",
    sha: "",
    active: true,
  });
  assert.deepEqual(parseLogQuery("375454a"), {
    path: "",
    author: "",
    grep: "",
    sha: "375454a",
    active: true,
  });

  const argsWithFilters = buildLogArgs({ limit: 50, scope: "current", branch: "origin/main", query: "author:Alice path:src/a.js fix" });
  assert.ok(argsWithFilters.includes("origin/main"));
  assert.ok(argsWithFilters.includes("--author=Alice"));
  assert.ok(argsWithFilters.includes("--grep=fix"));
  assert.deepEqual(argsWithFilters.slice(-2), ["--", "src/a.js"]);

  assert.equal(filterCommits(commits, "alice viewer").length, 1);
  assert.equal(filterCommits(commits, "path:README.md").length, 2, "path-only query preserves list until backend runs");

  // 4. Commit changed files parsing (normal, binary, and rename entries)
  const nameStatus = ["M", "src/app.js", "A", "assets/logo.png", "R100", "old/name.js", "new/name.js", ""].join("\0");
  const numstat = ["10\t2\tsrc/app.js", "-\t-\tassets/logo.png", "5\t1\t", "old/name.js", "new/name.js", ""].join("\0");
  assert.deepEqual(parseCommitFiles(nameStatus, numstat), [
    { path: "src/app.js", oldPath: null, status: "M", add: 10, del: 2, binary: false },
    { path: "assets/logo.png", oldPath: null, status: "A", add: 0, del: 0, binary: true },
    { path: "new/name.js", oldPath: "old/name.js", status: "R", add: 5, del: 1, binary: false },
  ]);

  // 5. Staged vs unstaged diff args
  assert.deepEqual(
    buildWorkingDiffArgs({ path: "a.js", staged: true, unstaged: true }, { section: "staged", hasHead: true }),
    ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--cached", "--", "a.js"]
  );
  assert.deepEqual(
    buildWorkingDiffArgs({ path: "a.js", staged: true, unstaged: true }, { section: "unstaged", hasHead: true }),
    ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", "a.js"]
  );

  // 6. Branches, Stashes, Worktrees, Agent handoff formatters
  const branchOut = [
    " \x1frefs/heads/feat/ui\x1ffeat/ui\x1f1111111\x1forigin/feat/ui\x1f[ahead 3]\x1f1 hour ago\x1fPolish UI",
    "*\x1frefs/heads/main\x1fmain\x1f375454a\x1forigin/main\x1f[behind 2]\x1f2 hours ago\x1fLatest main",
    " \x1frefs/remotes/origin/HEAD\x1forigin/HEAD\x1f375454a\x1f\x1f\x1f2 hours ago\x1fLatest main",
    " \x1frefs/remotes/origin/release\x1forigin/release\x1f9999999\x1f\x1f\x1f5 days ago\x1fRelease cut",
  ].join("\n");
  const parsedBranches = parseBranches(branchOut);
  assert.equal(parsedBranches.local[0].name, "main");
  assert.equal(parsedBranches.remote.length, 1);

  const stashOut = "stash@{0}\x1fa1b2c3d\x1f15 minutes ago\x1fOn main: save wip";
  assert.deepEqual(parseStashes(stashOut), [
    { ref: "stash@{0}", sha: "a1b2c3d", relTime: "15 minutes ago", branch: "main", message: "save wip" },
  ]);

  const wtOut = "worktree D:\\Code\\repo\nHEAD 375454a123456\nbranch refs/heads/main\n\nworktree D:\\Code\\repo-wt\nHEAD 1358f24abcdef\ndetached\n";
  assert.deepEqual(parseWorktrees(wtOut), [
    { path: "D:/Code/repo", head: "375454a123456", shortHead: "375454a", branch: "main", bare: false, detached: false },
    { path: "D:/Code/repo-wt", head: "1358f24abcdef", shortHead: "1358f24", branch: "", bare: false, detached: true },
  ]);

  assert.equal(formatAgentMention("file", "src\\app.js"), "@src/app.js ");
  assert.equal(formatAgentMention("commit", { shortSha: "375454a", subject: "fix preview" }), 'commit 375454a ("fix preview") ');
  assert.equal(formatAgentMention("conflicts", ["a.js", "b.js"]), "Resolve git merge conflicts in @a.js @b.js ");

  // 7. Compact folder chains, natural sort, tree order & ancestor expansion
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
    ]
  );
  assert.deepEqual(orderedTreeFiles(files).map((f) => f.path), [
    "a/b/c/deep.txt", "mods/t3-changes/icons/a.svg", "mods/t3-changes/file2.js", "mods/t3-changes/file10.js", "README.md",
  ]);
  const collapsed = new Set(["all:mods/t3-changes"]);
  expandAncestors(collapsed, "mods/t3-changes/icons/a.svg");
  assert.equal(collapsed.has("all:mods/t3-changes"), false);

  // 8. Syntax highlighting & intra-line word diff coloring
  const hl = await import(pathToFileURL(path.join(__dirname, "highlight.js")).href);
  assert.equal(hl.languageFromPath("src/app.tsx"), "js");
  assert.equal(hl.languageFromPath("Cargo.toml"), "sh");
  assert.equal(hl.languageFromPath("config/settings.json"), "json");
  assert.equal(hl.languageFromPath("README.md"), "md");

  const darkPal = hl.syntaxPalette({ background: "#0c0b0c", foreground: "#d4d4d4", ansi4: "#366388", ansi12: "#9bb4c0", ansi5: "#a292a3", ansi2: "#8a9a7b" });
  const lightPal = hl.syntaxPalette({ background: "#f5f4f0", foreground: "#232322", ansi4: "#2c5f8a", ansi12: "#5080a8" });
  assert.equal(darkPal.function, "#9bb4c0");
  assert.equal(lightPal.function, "#2c5f8a");

  const colorized = hl.colorizeDiffRows(
    diffRows(["@@ -1,2 +1,2 @@", '-const mode = "list";', '+const mode = "tree";']),
    "mods/t3-changes/main.js"
  );
  assert.ok(colorized[1].spans.some(([t, k, emph]) => t.includes("list") && k === "string" && emph === true));
  assert.ok(colorized[2].spans.some(([t, k, emph]) => t.includes("tree") && k === "string" && emph === true));

  const multi = hl.colorizeDiffRows(
    diffRows(["diff --git a/a.json b/a.json", "@@ -1,1 +1,1 @@", '+"key": true', "diff --git a/b.py b/b.py", "@@ -1,1 +1,1 @@", "+def run(): # py"]),
    ""
  );
  assert.ok(multi[2].spans.some(([t, k]) => t === '"key"' && k === "type"));
  assert.ok(multi[5].spans.some(([t, k]) => t === "def" && k === "keyword"));

  console.log("check-changes passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
