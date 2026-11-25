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
    VIEW_MODE_KEY, TAB_KEY, LOG_SCOPE_KEY, DIFF_WRAP_KEY, CHANGES_SPLIT_KEY,
    readViewMode, writeViewMode, readActiveTab, writeActiveTab,
    readLogScope, writeLogScope, readDiffWrap, writeDiffWrap,
    readSplitHeight, writeSplitHeight,
    parseBranchHeader, parseRefDecorations, parseUnpushedShas, parseGitLog,
    assignGraphLanes, detectDefaultBase, parseLogQuery, buildLogArgs, filterCommits,
    parseCommitFiles, parseBranches, parseStashes, parseWorktrees, parseWorktreeStatus,
    parseHunkRange, buildWorkingDiffArgs, diffRows, formatAgentMention,
    buildChangeTree, orderedTreeFiles, expandAncestors,
  } = mod;

  // 1. Persisted preferences
  assert.equal(readViewMode(), "list");
  assert.equal(writeViewMode("tree"), "tree");
  assert.equal(store.get(VIEW_MODE_KEY), "tree");
  assert.equal(readActiveTab(), "changes");
  assert.equal(writeActiveTab("log"), "log");
  assert.equal(store.get(TAB_KEY), "log");
  assert.equal(writeActiveTab("invalid"), "changes");
  assert.equal(readLogScope(), "current");
  assert.equal(writeLogScope("all"), "all");
  assert.equal(store.get(LOG_SCOPE_KEY), "all");
  assert.equal(readDiffWrap(), false);
  assert.equal(writeDiffWrap(true), true);
  assert.equal(store.get(DIFF_WRAP_KEY), "true");
  assert.equal(writeSplitHeight(CHANGES_SPLIT_KEY, 600, 90, 440), 440);
  assert.equal(readSplitHeight(CHANGES_SPLIT_KEY, 200, 90, 440), 440);

  // 2. Branch header & Worktree status parsing
  assert.deepEqual(
    parseBranchHeader("## main...origin/main [ahead 2, behind 1]", "375454a"),
    { branch: "main", upstream: "origin/main", ahead: 2, behind: 1, gone: false, detached: false, unborn: false, headSha: "375454a" }
  );
  assert.deepEqual(
    parseBranchHeader("## No commits yet on main", ""),
    { branch: "main", upstream: "", ahead: 0, behind: 0, gone: false, detached: false, unborn: true, headSha: "" }
  );
  assert.deepEqual(
    parseWorktreeStatus("## feat/a...origin/feat/a [ahead 3]\n M src/a.js\n?? new.txt\n"),
    { dirtyCount: 2, ahead: 3, behind: 0 }
  );

  // 3. Default base detection for Branch Diff
  const sampleBranches = {
    local: [{ name: "feat/radar" }, { name: "main" }],
    remote: [{ name: "origin/main" }],
  };
  assert.deepEqual(
    detectDefaultBase(sampleBranches, { branch: "feat/radar", upstream: "" }),
    { base: "main", range: "main...HEAD", label: "vs main" }
  );
  assert.deepEqual(
    detectDefaultBase({ local: [{ name: "main" }], remote: [{ name: "origin/main" }] }, { branch: "main", upstream: "origin/main", gone: false }),
    { base: "origin/main", range: "origin/main...HEAD", label: "vs origin/main" }
  );

  // 4. Multi-lane Commit Graph layout
  const graphCommits = [
    { sha: "m1", parents: ["a1", "b1"] },
    { sha: "b1", parents: ["base"] },
    { sha: "a1", parents: ["base"] },
    { sha: "base", parents: [] },
  ];
  const lanes = assignGraphLanes(graphCommits, 5);
  assert.equal(lanes[0].col, 0);
  assert.deepEqual(lanes[0].mergeCols, [1], "merge commit connects to branch lane 1");
  assert.equal(lanes[1].col, 1, "side branch commit lands on lane 1");
  assert.equal(lanes[2].col, 0, "mainline commit stays on lane 0");
  assert.equal(lanes[3].col, 0, "common ancestor rejoins lane 0");
  assert.equal(lanes[0].maxCols, 2);

  // 5. Log parsing, unpushed badges, backend query builder
  const remotes = new Set(["origin"]);
  const unpushed = parseUnpushedShas("375454aaaa\n");
  const sampleLog = "\x1e375454aaaa\x1f375454a\x1f1358f24bbb\x1fHEAD -> main, origin/main\x1fAlice\x1falice@example.com\x1f2 hours ago\x1f2026-11-24T12:00:00+08:00\x1ffeat: log\x1fBody";
  const commits = parseGitLog(sampleLog, remotes, unpushed);
  assert.equal(commits[0].unpushed, true);
  assert.deepEqual(parseLogQuery("author:Alice path:src/a.js fix"), { path: "src/a.js", author: "Alice", grep: "fix", sha: "", active: true });
  const args = buildLogArgs({ limit: 50, scope: "current", branch: "origin/main", query: "author:Alice path:src/a.js fix" });
  assert.ok(args.includes("origin/main") && args.includes("--author=Alice") && args.includes("--grep=fix"));
  assert.deepEqual(args.slice(-2), ["--", "src/a.js"]);
  assert.equal(filterCommits(commits, "alice").length, 1);

  // 6. Hunk range & line/range/file/commit Agent handoff formatting
  assert.deepEqual(parseHunkRange("@@ -10,4 +12,6 @@ function test()"), {
    oldStart: 10, oldCount: 4, newStart: 12, newCount: 6, newEnd: 17,
  });
  assert.equal(formatAgentMention("file", "src\\app.js"), "@src/app.js ");
  assert.equal(formatAgentMention("line", { path: "src\\app.js", line: 42 }), "@src/app.js:L42 ");
  assert.equal(formatAgentMention("range", { path: "src\\app.js", start: 12, end: 17 }), "@src/app.js:L12-L17 ");
  assert.equal(formatAgentMention("commit", { shortSha: "375454a", subject: "fix" }), 'commit 375454a ("fix") ');

  // 7. Commit files, branches, stashes, worktrees, staged vs unstaged diff args
  const nameStatus = ["M", "src/app.js", "R100", "old/a.js", "new/a.js", ""].join("\0");
  const numstat = ["10\t2\tsrc/app.js", "5\t1\t", "old/a.js", "new/a.js", ""].join("\0");
  assert.deepEqual(parseCommitFiles(nameStatus, numstat), [
    { path: "src/app.js", oldPath: null, status: "M", add: 10, del: 2, binary: false },
    { path: "new/a.js", oldPath: "old/a.js", status: "R", add: 5, del: 1, binary: false },
  ]);
  assert.deepEqual(
    buildWorkingDiffArgs({ path: "a.js", staged: true, unstaged: true }, { section: "staged", hasHead: true }),
    ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--cached", "--", "a.js"]
  );
  assert.deepEqual(
    buildWorkingDiffArgs({ path: "a.js", staged: true, unstaged: true }, { section: "unstaged", hasHead: true }),
    ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", "a.js"]
  );

  const brOut = "*\x1frefs/heads/main\x1fmain\x1f375454a\x1forigin/main\x1f[ahead 1]\x1f1h ago\x1fmsg\n";
  assert.equal(parseBranches(brOut).local[0].ahead, 1);
  assert.equal(parseStashes("stash@{0}\x1fa1b2\x1f5m ago\x1fOn main: wip\n")[0].branch, "main");
  assert.equal(parseWorktrees("worktree D:\\repo\nHEAD 1234567\nbranch refs/heads/main\n")[0].path, "D:/repo");

  // 8. Tree builder & ancestor expansion
  const files = [
    { path: "README.md", status: "M", add: 3, del: 1 },
    { path: "a/b/file10.js", status: "A", add: 10, del: 0 },
    { path: "a/b/file2.js", status: "M", add: 2, del: 4 },
  ];
  const tree = buildChangeTree(files, new Set(), "commit");
  assert.equal(tree[0].name, "a / b");
  assert.deepEqual(orderedTreeFiles(files).map((f) => f.path), ["a/b/file2.js", "a/b/file10.js", "README.md"]);
  const collapsed = new Set(["commit:a/b"]);
  expandAncestors(collapsed, "a/b/file2.js");
  assert.equal(collapsed.has("commit:a/b"), false);

  // 9. Multi-line stateful syntax highlighting & intra-line word diff
  const hl = await import(pathToFileURL(path.join(__dirname, "highlight.js")).href);
  const blockRows = hl.colorizeDiffRows(
    diffRows([
      "@@ -1,4 +1,4 @@",
      " /* start comment",
      "+  middle comment line",
      "   end comment */",
      "+const x = `multi",
      "+  template string`;",
    ]),
    "src/demo.js"
  );
  assert.ok(blockRows[2].spans.every(([, k]) => k === "comment"), "continues /* */ block comment across diff lines");
  assert.ok(blockRows[5].spans.some(([t, k]) => t.includes("template string") && k === "string"), "continues JS template literal across lines");

  // Unclosed comment on deleted `-` line must NOT bleed into added `+` line
  const isolated = hl.colorizeDiffRows(
    diffRows([
      "@@ -1,2 +1,2 @@",
      "-/* old unclosed",
      "+const ok = 123;",
    ]),
    "src/demo.js"
  );
  assert.ok(isolated[2].spans.some(([t, k]) => t === "const" && k === "keyword"), "old-side state isolated from new-side line");

  // Word-diff highlight on paired lines
  const paired = hl.colorizeDiffRows(
    diffRows(["@@ -1,1 +1,1 @@", '-const mode = "list";', '+const mode = "tree";']),
    "src/app.js"
  );
  assert.ok(paired[1].spans.some(([t, k, emph]) => t.includes("list") && k === "string" && emph === true));
  assert.ok(paired[2].spans.some(([t, k, emph]) => t.includes("tree") && k === "string" && emph === true));

  // 10. CJK-aware span wrapping & memoization for virtualized wrapped diffs
  const longComment = hl.colorizeDiffRows(
    diffRows(["@@ -1,1 +1,1 @@", '+// Ack.ack 是"自上次 ACK 以来 sink 已处理的帧数"，需要累加。']),
    "ALVideoSource.java"
  )[1];
  const wrapped = hl.wrapRowLines(longComment, 24, 2);
  assert.ok(wrapped.length >= 3, "long CJK comment wraps across multiple visual lines");
  assert.equal(wrapped.flat().map(([t]) => t).join(""), '// Ack.ack 是"自上次 ACK 以来 sink 已处理的帧数"，需要累加。');
  assert.equal(hl.wrapRowLines(longComment, 24, 2), wrapped, "memoizes wrapped lines for same column width");
  const wider = hl.wrapRowLines(longComment, 80, 2);
  assert.equal(wider.length, 1, "re-wraps when viewport width increases");

  // Preserves word-diff emphasis across line wrap boundary
  const empWrapped = hl.wrapSpans([["const ", "keyword", false], ["superLongIdentifierName", "plain", true]], 12, 2);
  assert.ok(empWrapped.length >= 2);
  assert.ok(empWrapped[1].every(([, , emph]) => emph === true), "preserves emph flag on continuation lines");

  // 11. Regression guard: diffRow must never attach per-row event handlers inside v_virtual_list
  const fs = require("node:fs");
  const mainSrc = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
  const diffRowBlock = mainSrc.slice(mainSrc.indexOf("diffRow("), mainSrc.indexOf("diffViewport("));
  assert.ok(diffRowBlock.length > 100, "located diffRow implementation");
  assert.ok(!/\.on_click\s*\(/.test(diffRowBlock), "diffRow must not call .on_click() inside v_virtual_list");
  assert.ok(!/\.tooltip\s*\(/.test(diffRowBlock), "diffRow must not call .tooltip() inside v_virtual_list");

  console.log("check-changes passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
