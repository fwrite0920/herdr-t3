import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, agents, panes, focused, run, exec, readTextFile, theme, settings, window, layout, shared, setShared } from "herdr";
import { KEY } from "./store.js";
import {
  BRANCH_FORMAT, STASH_FORMAT,
  CHANGES_SPLIT_KEY, LOG_SPLIT_KEY,
  readViewMode, writeViewMode,
  readActiveTab, writeActiveTab,
  readLogScope, writeLogScope,
  readDiffWrap, writeDiffWrap,
  readSplitHeight, writeSplitHeight,
  parseBranchHeader, parseUnpushedShas, parseGitLog, assignGraphLanes,
  detectDefaultBase, parseLogQuery, buildLogArgs, filterCommits,
  parseCommitFiles, parseBranches, parseStashes, parseWorktrees, parseWorktreeStatus,
  buildWorkingDiffArgs, diffRows, formatAgentMention,
  buildChangeTree, orderedTreeFiles, expandAncestors,
} from "./model.js";
import { colorizeDiffRows, syntaxPalette } from "./highlight.js";

const MOD = "mods/t3-changes";
const LOG_PAGE = 80;
const SPLIT_MIN = 90, SPLIT_MAX = 440;
const WRAP_ROW_CAP = 600;

const findNode = (node, id) => (node?.id === id ? node : (node?.children ?? []).reduce((hit, c) => hit ?? findNode(c, id), null));

function isChangesActive() {
  if (typeof window === "function" && window()?.active === false) return false;
  const root = typeof layout === "function" ? layout() : null;
  if (!root) return true;
  const panel = findNode(root, "panel");
  if (panel && panel.hidden) return false;
  const body = findNode(root, "panel-body");
  if (body && body.active && body.active !== "changes") return false;
  return true;
}

const norm = (p) => (p ? p.replace(/\\/g, "/").replace(/\/+$/, "") : "");
const isWin = () => (typeof window === "function" ? window()?.platform === "windows" : false);
const normKey = (p) => (isWin() ? norm(p).toLowerCase() : norm(p));

function location() {
  const sp = spaces().find((s) => s.active);
  const ps = typeof panes === "function" ? panes() : [];
  const f = typeof focused === "function" ? focused() : null;
  const tabs = new Set((sp?.tabs ?? []).map((c) => c.id));
  const focusPane = f?.pane && tabs.has(f.tab) ? ps.find((p) => p.pane === f.pane && p.cwd) : null;
  const cwd = focusPane?.cwd || ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || sp?.folder || "";
  return { cwd: norm(cwd), on: sp?.machine ?? null, spaceId: sp?.id ?? null };
}

const key = () => {
  const { cwd, on } = location();
  return JSON.stringify({ cwd, on });
};

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);

function shortIso(iso) {
  if (!iso) return "";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso.slice(0, 16);
}

function statusColorFor(status, t) {
  if (status === "A") return t.ansi2;
  if (status === "D" || status === "U") return t.ansi1;
  if (status === "R" || status === "C") return t.accent;
  return t.blocked;
}

function activeAgentTarget(spaceId) {
  const sp = spaces().find((s) => s.id === spaceId) ?? spaces().find((s) => s.active);
  if (!sp) return null;
  const activeTab = sp.tabs?.find((c) => c.active)?.id;
  const mine = typeof agents === "function" ? agents().filter((a) => a.space === sp.id) : [];
  const hitAgent = mine.find((a) => a.focused) ?? mine.find((a) => a.tab === activeTab) ?? mine[0];
  if (hitAgent?.address) return { address: hitAgent.address, isAgent: true };
  const ps = typeof panes === "function" ? panes() : [];
  const tabIds = new Set((sp.tabs ?? []).map((c) => c.id));
  const pane = ps.find((p) => p.focused && p.terminal && tabIds.has(p.tab))
    ?? ps.find((p) => p.tab === activeTab && p.terminal)
    ?? ps.find((p) => p.terminal && tabIds.has(p.tab));
  return pane?.terminal ? { address: pane.terminal, isAgent: false } : null;
}

export default class Changes extends View {
  init(_props, cx) {
    this.activeTab = readActiveTab();
    this.viewMode = readViewMode();
    this.logScope = readLogScope();
    this.diffWrap = readDiffWrap();
    this.changesSplit = readSplitHeight(CHANGES_SPLIT_KEY, 200, SPLIT_MIN, SPLIT_MAX);
    this.logSplit = readSplitHeight(LOG_SPLIT_KEY, 210, SPLIT_MIN, SPLIT_MAX);
    this.dragSplit = null; // { which: "changes"|"log", y, from, height }

    // Working tree & Branch diff state
    this.repo = parseBranchHeader("", "");
    this.files = [];
    this.open = null;
    this.openSection = "all"; // "all" | "staged" | "unstaged"
    this.rows = [];
    this.diffWidth = 300;
    this.listOpen = true;
    // Collapsed folder keys (`${group}:${dirPath}`) for tree views; memory-only for this run.
    this.collapsed = new Set();

    // Branch Diff (`base...HEAD`) state
    this.changesMode = "working"; // "working" | "branch"
    this.baseTarget = null; // { base, range, label }
    this.branchFiles = [];
    this.branchFileOpen = null;
    this.branchDiffRows = [];
    this.branchDiffWidth = 300;
    this.branchLoading = false;
    this.branchGen = 0;

    // Git Log state
    this.commits = [];
    this.unpushed = new Set();
    this.logLimit = LOG_PAGE;
    this.logHasMore = false;
    this.logLoading = false;
    this.logQuery = "";
    this.appliedQuery = "";
    this.logBranch = "";
    this.logListOpen = true;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitFilesOpen = true;
    this.commitTree = this.viewMode === "tree";
    this.commitFileOpen = null;
    this.commitDiffRows = [];
    this.commitDiffWidth = 300;
    this.commitLoading = false;
    this.commitGen = 0;

    // Branches / Stashes / Worktrees state
    this.branches = { local: [], remote: [], remoteNames: new Set(["origin"]) };
    this.stashes = [];
    this.worktrees = [];
    this.metaLoading = false;
    this.remotesOpen = false;
    this.remotesTouched = false;
    this.openStashRef = null;
    this.stashDiffRows = [];
    this.stashDiffWidth = 300;
    this.stashDiffLoading = false;

    // Shared feedback & polling state
    this.note = null;
    this.noteKind = "error";
    this.noteTimer = null;
    this.fetching = false;
    this.loading = false;
    this.typing = false;
    this.lastHeadSig = "";

    this.handle = cx.focus_handle();

    this.logSearchInput = InputState.new({ placeholder: "Filter or Enter to search repo (path:file, author:name)…" });
    this.logSearchInput.on("change", (_e, cx) => {
      this.logQuery = this.logSearchInput.value();
      if (!this.logQuery.trim() && this.appliedQuery) {
        this.appliedQuery = "";
        this.loadLog(cx, LOG_PAGE);
      } else {
        cx.notify();
      }
    });
    this.logSearchInput.on("submit", (_e, cx) => this.submitLogSearch(cx));
    this.logSearchInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.logSearchInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });

    this.refresh(cx, { full: true });
    this.pollTimer = cx.timer.every(5000, (cx) => { if (isChangesActive()) this.refresh(cx); });
  }

  async close() {
    this.pollTimer?.cancel();
    this.noteTimer?.cancel();
  }

  flash(text, kind, cx) {
    this.noteTimer?.cancel();
    this.note = text;
    this.noteKind = kind;
    if (kind === "ok" && cx?.timer) {
      this.noteTimer = cx.timer.after(3500, (c) => {
        if (this.note === text && this.noteKind === "ok") {
          this.note = null;
          c.notify();
        }
      });
    }
    cx?.notify?.();
  }

  publishSpaceStatus(spaceId, summary) {
    if (!spaceId) return;
    const prevAll = shared(KEY.gitStatus) ?? {};
    const prev = prevAll[spaceId];
    if (prev && prev.files === summary.files && prev.conflicts === summary.conflicts && prev.ahead === summary.ahead) return;
    const liveIds = new Set(spaces().map((s) => s.id));
    const next = {};
    for (const [id, val] of Object.entries(prevAll)) {
      if (liveIds.has(id)) next[id] = val;
    }
    next[spaceId] = summary;
    setShared(KEY.gitStatus, next);
  }

  resetContext(nextContext) {
    this.context = nextContext;
    this.root = null;
    this.on = null;
    this.hasHead = false;
    this.repo = parseBranchHeader("", "");
    this.files = [];
    this.open = null;
    this.openSection = "all";
    this.setLines([]);
    this.error = null;
    this.note = null;
    this.closed = false;
    this.limited = false;
    this.collapsed = new Set();
    this.lastHeadSig = "";

    // Reset Branch diff state
    this.changesMode = "working";
    this.baseTarget = null;
    this.branchFiles = [];
    this.branchFileOpen = null;
    this.setBranchLines([]);
    this.branchGen++;

    // Reset log state
    this.commits = [];
    this.unpushed = new Set();
    this.logLimit = LOG_PAGE;
    this.logHasMore = false;
    this.logQuery = "";
    this.appliedQuery = "";
    this.logBranch = "";
    this.logSearchInput.set_value("");
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitFileOpen = null;
    this.setCommitLines([]);
    this.commitGen++;

    // Reset branch / stash state
    this.branches = { local: [], remote: [], remoteNames: new Set(["origin"]) };
    this.stashes = [];
    this.worktrees = [];
    this.remotesTouched = false;
    this.openStashRef = null;
    this.setStashLines([]);
  }

  switchTab(tab, cx) {
    const next = writeActiveTab(tab);
    if (next === this.activeTab) return;
    this.activeTab = next;
    if (this.root) {
      if (next === "log" && !this.commits.length && !this.logLoading) this.loadLog(cx);
      if (next === "branches" && !this.branches.local.length && !this.metaLoading) this.loadMeta(cx);
    }
    cx.notify();
  }

  setChangesMode(mode, cx) {
    if (mode === this.changesMode) return;
    if (mode === "branch" && !this.baseTarget) return;
    this.changesMode = mode;
    if (mode === "branch") this.loadBranchDiff(cx);
    cx.notify();
  }

  // ── Agent Handoff & Space Navigation ─────────────────────────────────────

  sendToAgent(text, label, cx) {
    if (!text) return;
    const { spaceId } = location();
    const target = activeAgentTarget(spaceId);
    if (!target) {
      cx.write_to_clipboard(text);
      this.flash(`No active agent; copied ${label}`, "ok", cx);
      return;
    }
    const previous = cx.read_from_clipboard();
    const work = typeof layout === "function" ? findNode(layout(), "work") : null;
    if (work?.hidden) run("layout.show", { id: "work" });
    const targetPane = typeof panes === "function" ? panes().find((p) => p.terminal === target.address) : null;
    if (target.isAgent) run("agent.focus", { terminal: target.address });
    if (targetPane?.pane) run("pane.focus", { pane: targetPane.pane });
    else if (!target.isAgent) run("pane.focus", { terminal: target.address });
    cx.write_to_clipboard(text);
    this.flash(`Sent to agent: ${label}`, "ok", cx);
    cx.spawn(async (cx) => {
      for (let i = 0; i < 16; i++) {
        await cx.sleep(25);
        if (focused()?.terminal === target.address) break;
      }
      await cx.sleep(60);
      cx.write_to_clipboard(text);
      run("terminal.paste");
      if (typeof previous === "string") {
        await cx.sleep(500);
        cx.write_to_clipboard(previous);
      }
    });
  }

  mentionFile(relPath, cx) {
    this.sendToAgent(formatAgentMention("file", relPath), relPath, cx);
  }

  mentionLine(relPath, line, cx) {
    if (!relPath || line == null) return;
    this.sendToAgent(formatAgentMention("line", { path: relPath, line }), `${relPath}:L${line}`, cx);
  }

  mentionHunk(relPath, hunk, cx) {
    if (!relPath || !hunk) return;
    const start = hunk.newCount > 0 ? hunk.newStart : hunk.oldStart;
    const end = hunk.newCount > 0 ? hunk.newEnd : hunk.oldStart + Math.max(0, hunk.oldCount - 1);
    const label = end > start ? `${relPath}:L${start}-L${end}` : `${relPath}:L${start}`;
    this.sendToAgent(formatAgentMention("range", { path: relPath, start, end }), label, cx);
  }

  mentionCommit(commit, cx) {
    this.sendToAgent(formatAgentMention("commit", commit), commit.shortSha, cx);
  }

  mentionConflicts(cx) {
    const conflicts = this.files.filter((f) => f.status === "U").map((f) => f.path);
    if (!conflicts.length) return;
    this.sendToAgent(formatAgentMention("conflicts", conflicts), `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`, cx);
  }

  mentionStash(stash, cx) {
    this.sendToAgent(formatAgentMention("stash", stash), stash.ref, cx);
  }

  openWorktreeSpace(wt, cx) {
    if (!wt?.path || wt.bare) return;
    const on = this.on ?? null;
    const hit = spaces().find((s) => normKey(s.folder) === normKey(wt.path) && (s.machine ?? null) === on);
    if (hit) {
      run("space.select", { id: hit.id });
      this.flash(`Switched to ${hit.name || wt.branch || wt.path}`, "ok", cx);
    } else {
      run("space.new", { folder: wt.path, machine: on ?? "" });
      this.flash(`Opened worktree ${wt.branch || wt.path}`, "ok", cx);
    }
  }

  inspectBranchLog(branchName, cx) {
    this.logBranch = branchName;
    this.logLimit = LOG_PAGE;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitFileOpen = null;
    this.setCommitLines([]);
    this.activeTab = writeActiveTab("log");
    this.loadLog(cx, LOG_PAGE);
    cx.notify();
  }

  inspectFileHistory(relPath, cx) {
    const q = `path:${relPath}`;
    this.logQuery = q;
    this.appliedQuery = q;
    this.logSearchInput.set_value(q);
    this.logBranch = "";
    this.logLimit = LOG_PAGE;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.commitFileOpen = null;
    this.setCommitLines([]);
    this.activeTab = writeActiveTab("log");
    this.loadLog(cx, LOG_PAGE);
    cx.notify();
  }

  // ── Read-Only Git Loading ────────────────────────────────────────────────

  refresh(cx, opts = {}) {
    if (this.loading) return;
    const { cwd, on, spaceId } = location(), context = key();
    const contextChanged = context !== this.context;
    if (contextChanged) this.resetContext(context);
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        let root = this.root;
        if (!root) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
          if (key() !== context) return;
          if (!top || top.code !== 0) {
            this.root = null;
            this.files = [];
            this.setLines([]);
            this.open = null;
            this.error = "Not a git repository";
            this.publishSpaceStatus(spaceId, { files: 0, conflicts: 0, ahead: 0 });
            return;
          }
          root = top.stdout.trim().replace(/\\/g, "/");
        }
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [status, head] = await Promise.all([
          git(["status", "--porcelain=v1", "-b", "-z", "--no-renames", "--untracked-files=all"]),
          git(["rev-parse", "--short", "HEAD"]),
        ]);
        if (status.code !== 0) throw new Error(status.stderr);

        const hasHead = head.code === 0;
        const headSha = hasHead ? head.stdout.trim() : "";

        const stats = {};
        const results = hasHead
          ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
          : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }

        const rawEntries = status.stdout.split("\0").filter(Boolean);
        let headerLine = "";
        const fileEntries = [];
        for (const entry of rawEntries) {
          if (!headerLine && entry.startsWith("## ")) {
            headerLine = entry;
            continue;
          }
          fileEntries.push(entry);
        }

        const files = [];
        for (const entry of fileEntries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), x = xy[0], y = xy[1], path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const staged = !fresh && x !== " " && x !== "?";
          const unstaged = fresh || y !== " ";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, staged, unstaged, ...stat });
        }

        if (key() !== context) return;
        const repoInfo = parseBranchHeader(headerLine, headSha);
        const headSig = `${repoInfo.branch}|${repoInfo.upstream}|${repoInfo.ahead}|${repoInfo.behind}|${headSha}`;
        const headChanged = headSig !== this.lastHeadSig;

        this.root = root;
        this.on = on;
        this.hasHead = hasHead;
        this.repo = repoInfo;
        this.files = files;
        this.limited = fileEntries.length > 1000;
        this.error = null;
        this.lastHeadSig = headSig;
        this.baseTarget = detectDefaultBase(this.branches, repoInfo);
        if (!this.baseTarget && this.changesMode === "branch") this.changesMode = "working";

        this.publishSpaceStatus(spaceId, {
          files: files.length,
          conflicts: files.filter((f) => f.status === "U").length,
          ahead: repoInfo.ahead || 0,
        });

        if (this.open && !files.some((f) => f.path === this.open)) {
          this.open = null;
          this.openSection = "all";
          this.setLines([]);
        }
        if (!this.open && !this.closed && files.length) {
          const stagedList = files.filter((f) => f.staged);
          const unstagedList = files.filter((f) => f.unstaged);
          if (stagedList.length && unstagedList.length) {
            this.open = stagedList[0].path;
            this.openSection = "staged";
          } else {
            this.open = files[0].path;
            this.openSection = "all";
          }
        }
        if (this.open && this.activeTab === "changes" && this.changesMode === "working") {
          try {
            await this.load(this.open, this.openSection, context);
          } catch {
            if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]);
          }
        }

        const wantFull = Boolean(opts.full || contextChanged || headChanged);
        if (wantFull) {
          this.loadMeta(cx);
          if (this.activeTab === "log" || opts.full) this.loadLog(cx);
          if (this.changesMode === "branch" && this.baseTarget) this.loadBranchDiff(cx);
        }
      } catch (e) {
        if (key() === context) this.error = String(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  runFetch(cx) {
    if (!this.root || this.fetching || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context;
    this.fetching = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["fetch", "--prune"], { cwd: root, on, timeout: 60000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "git fetch failed");
        if (key() === context) this.flash("Fetched remote refs", "ok", cx);
      } catch (e) {
        if (key() === context) this.flash(`Fetch failed: ${e.message ?? e}`, "error", cx);
      } finally {
        this.fetching = false;
        this.refresh(cx, { full: true });
        cx.notify();
      }
    });
    cx.notify();
  }

  loadMeta(cx) {
    if (!this.root || this.metaLoading) return;
    const root = this.root, on = this.on, context = this.context;
    this.metaLoading = true;
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on }).catch(() => null);
        const [brRes, stRes, wtRes] = await Promise.all([
          git(["for-each-ref", "--sort=-committerdate", `--format=${BRANCH_FORMAT}`, "refs/heads", "refs/remotes"]),
          git(["stash", "list", `--format=${STASH_FORMAT}`]),
          git(["worktree", "list", "--porcelain"]),
        ]);
        if (key() !== context) return;
        if (brRes?.code === 0) {
          this.branches = parseBranches(brRes.stdout);
          this.baseTarget = detectDefaultBase(this.branches, this.repo);
          if (this.branches.remote.length <= 12 && !this.remotesTouched) this.remotesOpen = true;
        }
        if (stRes?.code === 0) {
          this.stashes = parseStashes(stRes.stdout);
          if (this.openStashRef && !this.stashes.some((s) => s.ref === this.openStashRef)) {
            this.openStashRef = null;
            this.setStashLines([]);
          }
        }
        if (wtRes?.code === 0) {
          const wts = parseWorktrees(wtRes.stdout);
          // For multi-worktree repos, inspect dirty/ahead status on up to 8 non-bare worktrees in parallel
          if (wts.length > 1) {
            const inspect = wts.slice(0, 8);
            await Promise.all(inspect.map(async (wt) => {
              if (wt.bare || !wt.path) return;
              if (normKey(wt.path) === normKey(root)) {
                wt.dirtyCount = this.files.length;
                wt.ahead = this.repo.ahead || 0;
                wt.behind = this.repo.behind || 0;
                return;
              }
              const sr = await exec("git", [...READ, "status", "--porcelain=v1", "-b"], { cwd: wt.path, on }).catch(() => null);
              if (sr?.code === 0) Object.assign(wt, parseWorktreeStatus(sr.stdout));
            }));
          }
          if (key() !== context) return;
          this.worktrees = wts;
        }
      } finally {
        this.metaLoading = false;
        cx.notify();
      }
    });
  }

  // ── Branch Diff (`base...HEAD`) Loader ───────────────────────────────────

  loadBranchDiff(cx) {
    if (!this.root || !this.baseTarget || !this.hasHead) return;
    const root = this.root, on = this.on, context = this.context;
    const range = this.baseTarget.range;
    const gen = ++this.branchGen;
    this.branchLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [ns, num] = await Promise.all([
          git(["diff", "--name-status", "-z", "-M", range]),
          git(["diff", "--numstat", "-z", "-M", range]),
        ]);
        if (key() !== context || this.branchGen !== gen) return;
        const files = ns.code === 0 ? parseCommitFiles(ns.stdout, num.code === 0 ? num.stdout : "") : [];
        this.branchFiles = files;
        if (this.branchFileOpen && !files.some((f) => f.path === this.branchFileOpen)) {
          this.branchFileOpen = null;
          this.setBranchLines([]);
        }
        if (!this.branchFileOpen && files.length) this.branchFileOpen = files[0].path;
        const openItem = files.find((f) => f.path === this.branchFileOpen);
        if (openItem) await this.loadBranchFileDiff(range, openItem, context, gen);
      } catch (e) {
        if (key() === context && this.branchGen === gen) this.setBranchLines([`Cannot load branch diff: ${e}`]);
      } finally {
        if (this.branchGen === gen) this.branchLoading = false;
        cx.notify();
      }
    });
  }

  async loadBranchFileDiff(range, file, context, gen) {
    const root = this.root, on = this.on;
    if (!root || !file) return;
    if (file.binary) {
      if (key() === context && this.branchGen === gen && this.branchFileOpen === file.path) {
        this.setBranchLines(["Binary file changed · no text diff"]);
      }
      return;
    }
    const pathArgs = file.oldPath ? [file.oldPath, file.path] : [file.path];
    const r = await exec("git", [...READ, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", range, "--", ...pathArgs], { cwd: root, on });
    if (key() !== context || this.branchGen !== gen || this.branchFileOpen !== file.path) return;
    if (r.code !== 0) {
      this.setBranchLines([`Diff error: ${r.stderr.trim() || "unknown"}`]);
      return;
    }
    const all = r.stdout.replace(/\n$/, "").split("\n");
    const first = all.findIndex((l) => l.startsWith("@@"));
    const lines = first < 0 ? ["No text diff available"] : all.slice(first);
    this.setBranchLines(lines.slice(0, 1500).map((l) => (l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l)), file.path);
  }

  pickBranchFile(file, cx) {
    if (!file || !this.baseTarget) return;
    this.branchFileOpen = this.branchFileOpen === file.path ? null : file.path;
    this.setBranchLines([]);
    const context = this.context, gen = this.branchGen, range = this.baseTarget.range;
    if (this.branchFileOpen) {
      cx.spawn(async (cx) => {
        await this.loadBranchFileDiff(range, file, context, gen);
        cx.notify();
      });
    }
    cx.notify();
  }

  stepBranchFile(dir, cx) {
    if (!this.branchFiles.length) return;
    const ordered = this.viewMode === "tree" ? orderedTreeFiles(this.branchFiles) : this.branchFiles;
    const idx = ordered.findIndex((f) => f.path === this.branchFileOpen);
    const nextIdx = idx < 0 ? (dir > 0 ? 0 : ordered.length - 1) : (idx + dir + ordered.length) % ordered.length;
    const target = ordered[nextIdx];
    if (this.viewMode === "tree") expandAncestors(this.collapsed, target.path, ["branch"]);
    this.pickBranchFile(target, cx);
  }

  // ── Git Log Loader ───────────────────────────────────────────────────────

  loadLog(cx, limit = this.logLimit) {
    if (!this.root || this.logLoading) return;
    if (!this.hasHead) {
      this.commits = [];
      this.unpushed = new Set();
      this.logHasMore = false;
      cx.notify();
      return;
    }
    const root = this.root, on = this.on, context = this.context;
    const args = buildLogArgs({ limit, scope: this.logScope, branch: this.logBranch, query: this.appliedQuery });
    this.logLoading = true;
    cx.spawn(async (cx) => {
      try {
        const git = (a) => exec("git", [...READ, ...a], { cwd: root, on }).catch(() => null);
        const [logRes, unpRes] = await Promise.all([
          git(args),
          this.repo.upstream && !this.repo.gone ? git(["rev-list", "@{u}..HEAD"]) : Promise.resolve(null),
        ]);
        if (key() !== context) return;
        const unpushed = unpRes?.code === 0 ? parseUnpushedShas(unpRes.stdout) : new Set();
        this.unpushed = unpushed;
        if (!logRes || logRes.code !== 0) {
          this.commits = [];
          this.logHasMore = false;
          return;
        }
        const parsed = parseGitLog(logRes.stdout, this.branches.remoteNames, unpushed);
        this.logHasMore = parsed.length > limit;
        this.commits = this.logHasMore ? parsed.slice(0, limit) : parsed;
        this.logLimit = limit;
        if (this.selectedCommit) {
          const fresh = this.commits.find((c) => c.sha === this.selectedCommit.sha);
          if (fresh) this.selectedCommit = fresh;
        }
      } finally {
        this.logLoading = false;
        cx.notify();
      }
    });
  }

  submitLogSearch(cx) {
    this.appliedQuery = this.logQuery.trim();
    this.logLimit = LOG_PAGE;
    this.loadLog(cx, LOG_PAGE);
    cx.notify();
  }

  clearLogSearch(cx) {
    this.logQuery = "";
    this.appliedQuery = "";
    this.logSearchInput.set_value("");
    this.logLimit = LOG_PAGE;
    this.loadLog(cx, LOG_PAGE);
    cx.notify();
  }

  selectCommit(commit, cx) {
    if (this.selectedCommit?.sha === commit.sha) {
      this.selectedCommit = null;
      this.commitFiles = [];
      this.commitFileOpen = null;
      this.setCommitLines([]);
      cx.notify();
      return;
    }
    const root = this.root, on = this.on, context = this.context;
    const gen = ++this.commitGen;
    this.selectedCommit = commit;
    this.commitFiles = [];
    this.commitFilesOpen = true;
    this.commitFileOpen = null;
    this.setCommitLines([]);
    this.commitLoading = true;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [ns, num] = await Promise.all([
          git(["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", "-M", commit.sha]),
          git(["diff-tree", "--root", "--no-commit-id", "--numstat", "-r", "-z", "-M", commit.sha]),
        ]);
        if (key() !== context || this.commitGen !== gen) return;
        const files = ns.code === 0 ? parseCommitFiles(ns.stdout, num.code === 0 ? num.stdout : "") : [];
        this.commitFiles = files;
        this.commitLoading = false;
        if (files.length) {
          const ordered = this.commitTree ? orderedTreeFiles(files) : files;
          this.commitFileOpen = ordered[0].path;
          await this.loadCommitFileDiff(commit.sha, ordered[0], context, gen);
        }
      } catch (e) {
        if (key() === context && this.commitGen === gen) {
          this.commitLoading = false;
          this.setCommitLines([`Cannot inspect commit: ${e}`]);
        }
      } finally {
        if (this.commitGen === gen) this.commitLoading = false;
        cx.notify();
      }
    });
  }

  async loadCommitFileDiff(sha, file, context, gen) {
    const root = this.root, on = this.on;
    if (!root || !file) return;
    if (file.binary) {
      if (key() === context && this.commitGen === gen && this.commitFileOpen === file.path) {
        this.setCommitLines(["Binary file changed · no text diff"]);
      }
      return;
    }
    const pathArgs = file.oldPath ? [file.oldPath, file.path] : [file.path];
    const r = await exec(
      "git",
      [...READ, "show", "--no-ext-diff", "--no-textconv", "--no-color", "--format=", "-M", sha, "--", ...pathArgs],
      { cwd: root, on }
    );
    if (key() !== context || this.commitGen !== gen || this.commitFileOpen !== file.path) return;
    if (r.code !== 0) {
      this.setCommitLines([`Diff error: ${r.stderr.trim() || "unknown"}`]);
      return;
    }
    const all = r.stdout.replace(/\n$/, "").split("\n");
    const first = all.findIndex((l) => l.startsWith("@@"));
    const lines = first < 0 ? ["No text diff available"] : all.slice(first);
    this.setCommitLines(lines.slice(0, 1500).map((line) => (line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line)), file.path);
  }

  pickCommitFile(file, cx) {
    if (!this.selectedCommit || !file) return;
    this.commitFileOpen = file.path;
    this.setCommitLines([]);
    const context = this.context, gen = this.commitGen, sha = this.selectedCommit.sha;
    cx.spawn(async (cx) => {
      await this.loadCommitFileDiff(sha, file, context, gen);
      cx.notify();
    });
    cx.notify();
  }

  stepCommitFile(dir, cx) {
    if (!this.commitFiles.length) return;
    const ordered = this.commitTree ? orderedTreeFiles(this.commitFiles) : this.commitFiles;
    const idx = ordered.findIndex((f) => f.path === this.commitFileOpen);
    const nextIdx = idx < 0 ? 0 : (idx + dir + ordered.length) % ordered.length;
    const target = ordered[nextIdx];
    if (this.commitTree) expandAncestors(this.collapsed, target.path, ["commit"]);
    this.pickCommitFile(target, cx);
  }

  stepCommit(dir, cx) {
    const visible = this.appliedQuery === this.logQuery.trim()
      ? this.commits
      : filterCommits(this.commits, this.logQuery);
    if (!visible.length) return;
    const idx = visible.findIndex((c) => c.sha === this.selectedCommit?.sha);
    const nextIdx = idx < 0 ? (dir > 0 ? 0 : visible.length - 1) : (idx + dir + visible.length) % visible.length;
    this.selectCommit(visible[nextIdx], cx);
  }

  toggleLogScope(cx) {
    this.logScope = writeLogScope(this.logScope === "all" ? "current" : "all");
    this.logBranch = "";
    this.logLimit = LOG_PAGE;
    this.loadLog(cx, LOG_PAGE);
    cx.notify();
  }

  toggleDiffWrap(cx) {
    this.diffWrap = writeDiffWrap(!this.diffWrap);
    cx.notify();
  }

  copyText(text, label, cx) {
    if (!text) return;
    cx.write_to_clipboard(text);
    this.flash(`Copied ${label}`, "ok", cx);
  }

  toggleStashDiff(stash, cx) {
    if (this.openStashRef === stash.ref) {
      this.openStashRef = null;
      this.setStashLines([]);
      cx.notify();
      return;
    }
    const root = this.root, on = this.on, context = this.context;
    this.openStashRef = stash.ref;
    this.setStashLines([]);
    this.stashDiffLoading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", [...READ, "stash", "show", "-p", "--include-untracked", "--no-color", stash.ref], { cwd: root, on });
        if (key() !== context || this.openStashRef !== stash.ref) return;
        const lines = r.code === 0 && r.stdout.trim()
          ? r.stdout.replace(/\n$/, "").split("\n").slice(0, 1500)
          : ["No text diff for this stash"];
        this.setStashLines(lines.map((l) => (l.length > 4000 ? l.slice(0, 4000) + "…" : l)));
      } catch (e) {
        if (key() === context && this.openStashRef === stash.ref) this.setStashLines([`Cannot load stash diff: ${e}`]);
      } finally {
        this.stashDiffLoading = false;
        cx.notify();
      }
    });
  }

  async load(path, section, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A" && section !== "staged")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map((l) => `+${l}`)];
      }
    } else {
      const args = buildWorkingDiffArgs(file, { section, hasHead: this.hasHead });
      const r = await exec("git", [...READ, ...args], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path && this.openSection === section) {
      this.setLines(lines.slice(0, 1500).map((line) => (line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line)), path);
    }
  }

  setLines(lines, filePath = "") {
    this.rows = colorizeDiffRows(diffRows(lines), filePath);
    this.diffWidth = Math.max(300, ...lines.map((line) => line.length * 7 + 96));
  }

  setBranchLines(lines, filePath = "") {
    this.branchDiffRows = colorizeDiffRows(diffRows(lines), filePath);
    this.branchDiffWidth = Math.max(300, ...lines.map((line) => line.length * 7 + 96));
  }

  setCommitLines(lines, filePath = "") {
    this.commitDiffRows = colorizeDiffRows(diffRows(lines), filePath);
    this.commitDiffWidth = Math.max(300, ...lines.map((line) => line.length * 7 + 96));
  }

  setStashLines(lines) {
    this.stashDiffRows = colorizeDiffRows(diffRows(lines), "");
    this.stashDiffWidth = Math.max(300, ...lines.map((line) => line.length * 7 + 96));
  }

  pick(path, section, cx) {
    const same = this.open === path && this.openSection === section;
    this.open = same ? null : path;
    this.openSection = same ? "all" : section;
    this.setLines([]);
    this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) {
      cx.spawn(async (cx) => {
        try {
          await this.load(path, section, context);
        } catch (e) {
          if (key() === context && this.open === path && this.openSection === section) this.flash(`Cannot preview diff: ${e}`, "error", cx);
        }
        cx.notify();
      });
    }
    cx.notify();
  }

  toggleViewMode(cx) {
    this.viewMode = writeViewMode(this.viewMode === "tree" ? "list" : "tree");
    cx.notify();
  }

  toggleDir(collapsedKey, cx) {
    if (this.collapsed.has(collapsedKey)) this.collapsed.delete(collapsedKey);
    else this.collapsed.add(collapsedKey);
    cx.notify();
  }

  stepFile(dir, cx) {
    if (this.changesMode === "branch") return this.stepBranchFile(dir, cx);
    if (!this.files.length) return;
    const stagedFiles = this.files.filter((f) => f.staged);
    const unstagedFiles = this.files.filter((f) => f.unstaged);
    const splitSections = stagedFiles.length > 0 && unstagedFiles.length > 0;
    const ordered = splitSections
      ? [
          ...(this.viewMode === "tree" ? orderedTreeFiles(stagedFiles) : stagedFiles).map((f) => ({ path: f.path, section: "staged" })),
          ...(this.viewMode === "tree" ? orderedTreeFiles(unstagedFiles) : unstagedFiles).map((f) => ({ path: f.path, section: "unstaged" })),
        ]
      : (this.viewMode === "tree" ? orderedTreeFiles(this.files) : this.files).map((f) => ({ path: f.path, section: "all" }));
    if (!ordered.length) return;
    const idx = ordered.findIndex((it) => it.path === this.open && it.section === this.openSection);
    const nextIdx = idx < 0 ? (dir > 0 ? 0 : ordered.length - 1) : (idx + dir + ordered.length) % ordered.length;
    const target = ordered[nextIdx];
    if (this.viewMode === "tree") expandAncestors(this.collapsed, target.path);
    this.pick(target.path, target.section, cx);
  }

  // ── Draggable Vertical Split Helper ──────────────────────────────────────

  endSplitDrag(cx) {
    if (!this.dragSplit) return;
    const { which, height } = this.dragSplit;
    this.dragSplit = null;
    if (which === "changes") this.changesSplit = writeSplitHeight(CHANGES_SPLIT_KEY, height, SPLIT_MIN, SPLIT_MAX);
    else if (which === "log") this.logSplit = writeSplitHeight(LOG_SPLIT_KEY, height, SPLIT_MIN, SPLIT_MAX);
    cx.notify();
  }

  // ── Shared Diff Viewer (Syntax + Word-Diff + Line/Hunk @ Handoff + Wrap) ─

  diffRow(row, t, pal, wrapped = false, filePath = "") {
    const { kind, oldNum, newNum, text, spans, hunk } = row;
    const cardHover = t.foreground + "12";
    if (kind === "file") {
      return h_flex().w_full().px(10).h(20).items_center().flex_none().bg(t.raised).border_t(1).border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(text));
    }
    if (kind === "@") {
      const m = /^(@@[^@]+@@)\s*(.*)$/.exec(text);
      return h_flex().w_full().px(10).h(20).gap(8).items_center().flex_none().bg(t.raised).border_t(1).border_b(1).border_color(t.border)
        .child(div().flex_none().font_bold().text_color(t.accent).child(m ? m[1] : text))
        .when(Boolean(m?.[2]), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(m[2])))
        .when(!m?.[2], (el) => el.child(div().flex_1()))
        .when(Boolean(filePath && hunk), (el) => el.child(
          h_flex().h(16).px(5).flex_none().gap(3).items_center().rounded(4).cursor_pointer()
            .bg(t.background).text_size(9.5).text_color(t.muted)
            .hover((s) => s.bg(cardHover).text_color(t.accent))
            .tooltip(`Send hunk range to agent (@${filePath}:L${hunk.newStart}-L${hunk.newEnd})`)
            .on_click((_e, cx) => { cx.stop_propagation(); this.mentionHunk(filePath, hunk, cx); })
            .child(svg(`${MOD}/icons/at-sign.svg`).size(9).text_color(t.accent))
            .child(`L${hunk.newStart}`)));
    }
    const isAdd = kind === "+", isDel = kind === "-";
    const sign = isAdd ? "+" : isDel ? "−" : " ";
    const signColor = isAdd ? t.ansi2 : isDel ? t.ansi1 : t.dim;
    const emphBg = isAdd ? t.ansi2 + "3d" : isDel ? t.ansi1 + "3d" : null;
    const lineBg = isAdd ? t.ansi2 + "18" : isDel ? t.ansi1 + "18" : null;
    const barColor = isAdd ? t.ansi2 : isDel ? t.ansi1 : null;
    const targetLine = newNum ?? oldNum;
    const canMentionLine = Boolean(filePath && targetLine != null);
    const codeChildren = spans && spans.length
      ? spans.map(([seg, tokenKind, emph]) => div().flex_none()
          .text_color(pal[tokenKind] || pal.plain)
          .when(Boolean(emph && emphBg), (el) => el.bg(emphBg).rounded(2))
          .child(seg))
      : [div().flex_none().text_color(kind === "" ? t.dim : pal.plain).child(text)];

    const gutter = h_flex().flex_none().items_center()
      .when(canMentionLine, (el) => el.cursor_pointer().rounded(3)
        .hover((s) => s.bg(cardHover))
        .tooltip(`Mention @${filePath}:L${targetLine} in agent`)
        .on_click((_e, cx) => { cx.stop_propagation(); this.mentionLine(filePath, targetLine, cx); }))
      .child(div().w(30).flex_none().pr(4).text_right().text_color(isDel ? t.ansi1 + "cc" : t.dim).child(oldNum === undefined ? "" : String(oldNum)))
      .child(div().w(30).flex_none().pr(6).text_right().text_color(isAdd ? t.ansi2 + "cc" : t.dim).child(newNum === undefined ? "" : String(newNum)));

    if (wrapped) {
      return h_flex().w_full().min_h(20).py(1).flex_none().items_start()
        .when(Boolean(lineBg), (e) => e.bg(lineBg))
        .child(div().w(2).h(20).flex_none().when(Boolean(barColor), (e) => e.bg(barColor)))
        .child(gutter)
        .child(div().w(14).flex_none().text_center().font_bold().text_color(signColor).child(sign))
        .child(h_flex().flex_1().min_w(0).flex_wrap().pr(8).children(codeChildren));
    }

    return h_flex().w_full().h(20).flex_none().items_center()
      .when(Boolean(lineBg), (e) => e.bg(lineBg))
      .child(div().w(2).h_full().flex_none().when(Boolean(barColor), (e) => e.bg(barColor)))
      .child(gutter)
      .child(div().w(14).flex_none().text_center().font_bold().text_color(signColor).child(sign))
      .child(h_flex().flex_1().min_w(0).h_full().items_center().whitespace_nowrap().children(codeChildren));
  }

  diffViewport(id, rows, width, emptyText, t, filePath = "") {
    const pal = syntaxPalette(t);
    const mono = settings().font_family ?? "JetBrains Mono";
    if (this.diffWrap && rows.length > 0) {
      const capped = rows.slice(0, WRAP_ROW_CAP);
      return v_flex().id(`${id}-wrap`).flex_1().min_h(0).overflow_y_scrollbar().font_family(mono).text_size(11.5)
        .children(capped.map((row) => this.diffRow(row, t, pal, true, filePath)))
        .when(rows.length > WRAP_ROW_CAP, (el) => el.child(
          div().px(12).py(6).text_size(11).text_color(t.dim).child(`Showing first ${WRAP_ROW_CAP} wrapped lines — toggle Wrap off for full virtualized scroll.`)));
    }
    return div().flex_1().min_h(0).relative().font_family(mono).text_size(11.5)
      .child(div().id(`${id}-x`).size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(width).h_full().child(v_virtual_list(id, rows.length, 20, (i) => String(i),
          (range) => rows.slice(range.start, range.end).map((row) => this.diffRow(row, t, pal, false, filePath))).size_full())))
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0())
      .when(!rows.length && Boolean(emptyText), (e) => e.child(div().absolute().top(8).px(12).text_size(11.5).text_color(t.dim).child(emptyText)));
  }

  // ── Shared Directory & File Rows ─────────────────────────────────────────

  dirRow(row, t) {
    const cardHover = t.foreground + "12";
    return h_flex().id(`change-dir-${row.group}-${row.path}`).h(25).flex_none().pl(6 + row.depth * 14).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(cardHover))
      .on_click((_e, cx) => this.toggleDir(row.collapsedKey, cx))
      .child(div().w(14).flex_none().flex().items_center().justify_center()
        .child(svg(row.open ? `${MOD}/icons/chevron-down.svg` : `${MOD}/icons/chevron-right.svg`).size(12).text_color(t.dim)))
      .child(svg(row.open ? `${MOD}/icons/folder-open.svg` : `${MOD}/icons/folder.svg`).size(13).flex_none().text_color(t.muted))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).child(row.name))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(String(row.count))))
      .when(row.add > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi2).child(`+${row.add}`)))
      .when(row.del > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi1).child(`−${row.del}`)));
  }

  fileRow(f, t, group = "all", treeDepth = null, onSelect = null, isSelected = null) {
    const parts = f.path.split("/"), name = parts.pop();
    const inTree = treeDepth !== null;
    const isSel = isSelected !== null ? isSelected : (this.open === f.path && this.openSection === group);
    const statusColor = statusColorFor(f.status, t);
    const cardHover = t.foreground + "12", cardOn = t.foreground + "1f";
    return h_flex().id(`change-${group}-${f.path}`).h(25).flex_none()
      .when(inTree, (e) => e.pl(6 + treeDepth * 14).pr(6))
      .when(!inTree, (e) => e.px(6))
      .gap(6).items_center().rounded(6).cursor_pointer()
      .when(isSel, (e) => e.bg(cardOn))
      .when(!isSel, (e) => e.hover((s) => s.bg(cardHover)))
      .on_click((_e, cx) => (onSelect ? onSelect(f, cx) : this.pick(f.path, group, cx)))
      .child(div().w(14).flex_none().text_size(11).font_bold().text_color(statusColor).child(f.status))
      .when(inTree, (e) => e.child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().child(name)))
      .when(!inTree, (e) => e.child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().flex_none().max_w(170).truncate().text_size(11.5).font_medium().child(name))
        .when(Boolean(f.oldPath || parts.length > 0), (el) => el.child(div().flex_1().min_w(0).text_size(10.5).text_color(t.dim).truncate().child(f.oldPath ? `${f.oldPath} → ${f.path}` : parts.join("/"))))))
      .when(Boolean(f.staged) && group === "all", (el) => el.child(div().px(4).py(0.5).rounded(4).bg(t.ansi2 + "22").text_size(9.5).font_bold().text_color(t.ansi2).child("S")))
      .when(Boolean(f.binary), (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child("bin")))
      .when(!f.binary && f.add > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`)))
      .when(!f.binary && f.del > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)))
      .child(div().id(`hist-${group}-${f.path}`).size(19).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(cardHover))
        .tooltip("View file history in Log")
        .on_click((_e, cx) => { cx.stop_propagation(); this.inspectFileHistory(f.path, cx); })
        .child(svg(`${MOD}/icons/clock.svg`).size(10.5).text_color(t.dim)))
      .child(div().id(`mention-${group}-${f.path}`).size(19).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(cardHover))
        .tooltip("Mention in agent")
        .on_click((_e, cx) => { cx.stop_propagation(); this.mentionFile(f.path, cx); })
        .child(svg(`${MOD}/icons/at-sign.svg`).size(10.5).text_color(t.muted)));
  }

  // ── Top 40px Repo Radar Header & Sub-tab Bar ─────────────────────────────

  repoToolbar(t, { add, del, conflictCount }) {
    const cardHover = t.foreground + "12";
    const repo = this.repo;
    const hasRepo = Boolean(this.root);
    const branchLabel = !hasRepo
      ? (this.loading ? "Checking git…" : "No repository")
      : repo.branch || (repo.headSha ? `HEAD@${repo.headSha}` : "HEAD");

    return h_flex().id("t3-changes-toolbar").h(40).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("git-branch-pill").h(26).px(7).min_w(0).max_w(190).gap(5).items_center().rounded(6).bg(t.raised)
        .when(hasRepo, (el) => el.cursor_pointer().hover((s) => s.bg(cardHover))
          .tooltip(repo.upstream ? `${repo.branch} → ${repo.upstream}` : `${branchLabel} (click for Branches)`)
          .on_click((_e, cx) => this.switchTab("branches", cx)))
        .child(svg(`${MOD}/icons/git-branch.svg`).size(13).flex_none().text_color(repo.detached ? t.blocked : t.accent))
        .child(div().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(branchLabel)))
      .when(hasRepo && repo.ahead > 0, (el) => el.child(
        div().px(5).py(1).flex_none().rounded(4).bg(t.ansi2 + "20").text_size(10.5).font_medium().text_color(t.ansi2)
          .tooltip(`${repo.ahead} unpushed commit${repo.ahead === 1 ? "" : "s"}`)
          .child(`↑${repo.ahead}`)))
      .when(hasRepo && repo.behind > 0, (el) => el.child(
        div().px(5).py(1).flex_none().rounded(4).bg(t.blocked + "22").text_size(10.5).font_medium().text_color(t.blocked)
          .tooltip(`${repo.behind} commit${repo.behind === 1 ? "" : "s"} behind ${repo.upstream}`)
          .child(`↓${repo.behind}`)))
      .when(hasRepo && repo.gone, (el) => el.child(
        div().px(5).py(1).flex_none().rounded(4).bg(t.ansi1 + "20").text_size(10.5).text_color(t.ansi1).child("gone")))
      .when(hasRepo && Boolean(repo.upstream) && !repo.gone && repo.ahead === 0 && repo.behind === 0, (el) => el.child(
        h_flex().px(5).py(1).flex_none().gap(3).items_center().rounded(4).bg(t.raised).text_size(10.5).text_color(t.dim)
          .tooltip(`In sync with ${repo.upstream}`)
          .child(svg(`${MOD}/icons/check.svg`).size(10).text_color(t.ansi2))
          .child("synced")))
      .when(hasRepo && !repo.upstream && !repo.unborn && !repo.detached, (el) => el.child(
        div().px(5).py(1).flex_none().rounded(4).bg(t.raised).text_size(10.5).text_color(t.dim).child("local")))
      .when(conflictCount > 0, (el) => el.child(
        h_flex().id("git-conflict-handoff").h(22).px(6).flex_none().gap(4).items_center().rounded(5).cursor_pointer()
          .bg(t.ansi1 + "24").text_size(10.5).font_semibold().text_color(t.ansi1)
          .hover((s) => s.bg(t.ansi1 + "38"))
          .tooltip("Send merge conflicts to agent")
          .on_click((_e, cx) => this.mentionConflicts(cx))
          .child(`! ${conflictCount} conflict${conflictCount === 1 ? "" : "s"}`)
          .child(svg(`${MOD}/icons/at-sign.svg`).size(10).text_color(t.ansi1))))
      .child(div().flex_1())
      .when(hasRepo && this.files.length > 0 && conflictCount === 0, (el) => el.child(
        h_flex().flex_none().gap(4).items_center().text_size(10.5)
          .when(add > 0, (a) => a.child(div().text_color(t.ansi2).child(`+${add}`)))
          .when(del > 0, (d) => d.child(div().text_color(t.ansi1).child(`−${del}`)))))
      .when(hasRepo, (el) => el.child(
        h_flex().id("git-fetch").h(24).px(7).flex_none().items_center().rounded(6)
          .bg(t.raised).border_1().border_color(t.border).text_size(11).font_medium()
          .text_color(this.fetching ? t.accent : t.muted)
          .when(!this.fetching, (b) => b.cursor_pointer().hover((s) => s.bg(cardHover).text_color(t.foreground))
            .on_click((_e, cx) => this.runFetch(cx)))
          .when(this.fetching, (b) => b.opacity(0.64))
          .tooltip("Read-only: git fetch --prune (updates remote status only)")
          .child(this.fetching ? "Fetching…" : "Fetch")))
      .child(div().id("changes-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(cardHover))
        .tooltip("Refresh git radar")
        .on_click((_e, cx) => this.refresh(cx, { full: true }))
        .child(svg(`${MOD}/icons/refresh-cw.svg`).size(13).text_color(t.muted)));
  }

  subTabBar(t, { stagedCount }) {
    const cardHover = t.foreground + "12", cardOn = t.foreground + "1f";
    const isTree = this.viewMode === "tree";
    const tabBtn = (id, label, icon, badge) => {
      const on = this.activeTab === id;
      return h_flex().id(`git-subtab-${id}`).h(24).px(8).flex_none().gap(5).items_center().rounded(6).cursor_pointer()
        .bg(on ? cardOn : t.background)
        .text_size(11.5).text_color(on ? t.foreground : t.muted)
        .when(on, (el) => el.font_medium())
        .when(!on, (el) => el.hover((s) => s.bg(cardHover).text_color(t.foreground)))
        .on_click((_e, cx) => this.switchTab(id, cx))
        .child(svg(`${MOD}/icons/${icon}.svg`).size(12).flex_none().text_color(on ? t.foreground : t.dim))
        .child(label)
        .when(badge != null && badge !== "", (el) => el.child(
          div().px(4).py(0.5).rounded(4).bg(t.raised).text_size(10).text_color(on ? t.foreground : t.dim).child(String(badge))));
    };

    const logCount = this.commits.length ? (this.logHasMore ? `${this.commits.length}+` : String(this.commits.length)) : null;
    const brBadge = this.branches.local.length ? String(this.branches.local.length) : null;
    const activeFilesCount = this.changesMode === "branch" ? this.branchFiles.length : this.files.length;

    return h_flex().id("git-subtabs").h(34).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
      .child(tabBtn("changes", "Changes", "git-commit", this.files.length > 0 ? this.files.length : null))
      .child(tabBtn("log", "Log", "clock", logCount))
      .child(tabBtn("branches", "Branches", "git-branch", brBadge))
      .child(div().flex_1())
      .when(this.activeTab === "changes", (el) => el
        .when(Boolean(this.baseTarget), (mEl) => mEl.child(
          h_flex().id("changes-mode-group").h(22).p(1).flex_none().gap(1).items_center().rounded(6).bg(t.raised).border_1().border_color(t.border)
            .child(div().id("mode-working").h(18).px(6).flex().items_center().rounded(4).cursor_pointer().text_size(10.5)
              .bg(this.changesMode === "working" ? t.background : t.raised)
              .text_color(this.changesMode === "working" ? t.foreground : t.dim)
              .when(this.changesMode === "working", (a) => a.font_medium())
              .on_click((_e, cx) => this.setChangesMode("working", cx))
              .child("Working"))
            .child(div().id("mode-branch").h(18).px(6).flex().items_center().rounded(4).cursor_pointer().text_size(10.5)
              .bg(this.changesMode === "branch" ? t.background : t.raised)
              .text_color(this.changesMode === "branch" ? t.accent : t.dim)
              .when(this.changesMode === "branch", (a) => a.font_medium())
              .tooltip(`Compare ${this.baseTarget.range}`)
              .on_click((_e, cx) => this.setChangesMode("branch", cx))
              .child(this.baseTarget.label))))
        .when(this.changesMode === "working" && stagedCount > 0, (sEl) => sEl.child(
          div().px(5).py(1).flex_none().rounded(4).bg(t.ansi2 + "20").text_size(10.5).font_medium().text_color(t.ansi2).child(`${stagedCount} staged`)))
        .child(div().id("changes-view-mode").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .when(isTree, (tEl) => tEl.bg(cardOn))
          .hover((s) => s.bg(isTree ? t.foreground + "26" : cardHover))
          .tooltip(isTree ? "Switch to list view" : "Switch to tree view")
          .on_click((_e, cx) => this.toggleViewMode(cx))
          .child(svg(`${MOD}/icons/folder-tree.svg`).size(13).text_color(isTree ? t.foreground : t.muted)))
        .when(activeFilesCount > 0, (cEl) => cEl.child(
          div().id("changes-list-toggle").h(22).px(5).flex_none().flex().items_center().rounded(6).cursor_pointer().text_size(11).text_color(t.dim)
            .hover((s) => s.bg(cardHover).text_color(t.foreground))
            .tooltip(this.listOpen ? "Collapse file list" : "Expand file list")
            .on_click((_e, cx) => { this.listOpen = !this.listOpen; cx.notify(); })
            .child(this.listOpen ? "▾" : "▸"))))
      .when(this.activeTab === "log", (el) => el
        .when(Boolean(this.logBranch), (bEl) => bEl.child(
          h_flex().id("log-branch-chip").h(22).px(6).flex_none().gap(4).items_center().rounded(6).cursor_pointer()
            .bg(t.accent + "24").text_size(10.5).font_medium().text_color(t.accent)
            .tooltip("Viewing branch history (click to clear)")
            .on_click((_e, cx) => { this.logBranch = ""; this.loadLog(cx, LOG_PAGE); cx.notify(); })
            .child(svg(`${MOD}/icons/git-branch.svg`).size(10).text_color(t.accent))
            .child(this.logBranch)
            .child(svg(`${MOD}/icons/x.svg`).size(10).text_color(t.accent))))
        .when(!this.logBranch, (sEl) => sEl.child(
          h_flex().id("log-scope-toggle").h(22).px(7).flex_none().gap(4).items_center().rounded(6).cursor_pointer()
            .bg(this.logScope === "all" ? cardOn : t.raised).text_size(11)
            .text_color(this.logScope === "all" ? t.foreground : t.muted)
            .hover((s) => s.bg(cardHover).text_color(t.foreground))
            .tooltip(this.logScope === "all" ? "Showing all branches (click for current branch)" : "Showing current branch (click for all branches)")
            .on_click((_e, cx) => this.toggleLogScope(cx))
            .child(this.logScope === "all" ? "All branches" : "Current branch")))
        .when(Boolean(this.selectedCommit), (cEl) => cEl.child(
          div().id("log-list-toggle").h(22).px(5).flex_none().flex().items_center().rounded(6).cursor_pointer().text_size(11).text_color(t.dim)
            .hover((s) => s.bg(cardHover).text_color(t.foreground))
            .tooltip(this.logListOpen ? "Collapse commit list" : "Expand commit list")
            .on_click((_e, cx) => { this.logListOpen = !this.logListOpen; cx.notify(); })
            .child(this.logListOpen ? "▾" : "▸"))))
      .when(this.activeTab === "branches" && Boolean(this.root), (el) => el.child(
        div().text_size(10.5).text_color(t.dim).child(
          `${this.branches.local.length} local · ${this.branches.remote.length} remote${this.stashes.length ? ` · ${this.stashes.length} stash` : ""}`)));
  }

  // ── View 1: Changes (Working Tree OR Branch Diff `base...HEAD`) ──────────

  renderBranchDiffBody(t) {
    const cardHover = t.foreground + "12", cardOn = t.foreground + "1f";
    const isTree = this.viewMode === "tree";
    const openFile = this.branchFiles.find((f) => f.path === this.branchFileOpen);
    const hasOpen = Boolean(openFile);
    const hunkCount = this.branchDiffRows.filter((r) => r.kind === "@").length;
    const totalAdd = this.branchFiles.reduce((n, f) => n + f.add, 0);
    const totalDel = this.branchFiles.reduce((n, f) => n + f.del, 0);
    const dragging = this.dragSplit?.which === "changes";
    const listH = dragging ? Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, this.dragSplit.height)) : this.changesSplit;

    const items = isTree
      ? buildChangeTree(this.branchFiles, this.collapsed, "branch").map((row) =>
          row.kind === "dir"
            ? this.dirRow(row, t)
            : this.fileRow(row.file, t, "branch", row.depth, (f, cx) => this.pickBranchFile(f, cx), this.branchFileOpen === row.file.path))
      : this.branchFiles.map((f) =>
          this.fileRow(f, t, "branch", null, (item, cx) => this.pickBranchFile(item, cx), this.branchFileOpen === f.path));

    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(26).flex_none().px(10).gap(6).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(10.5)
        .child(div().text_color(t.dim).child("Range:"))
        .child(div().font_medium().text_color(t.accent).child(this.baseTarget?.range || ""))
        .child(div().text_color(t.dim).child(`· ${this.branchFiles.length} file${this.branchFiles.length === 1 ? "" : "s"}`))
        .when(totalAdd > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${totalAdd}`)))
        .when(totalDel > 0, (e) => e.child(div().text_color(t.ansi1).child(`−${totalDel}`))))
      .when(this.listOpen, (el) => el.child(
        v_flex().id("branch-diff-list-box").relative()
          .when(hasOpen, (e) => e.flex_none().h(listH).border_b(1).border_color(t.border))
          .when(!hasOpen, (e) => e.flex_1().min_h(0))
          .child(v_flex().id("branch-diff-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
            .when(items.length > 0, (g) => g.children(items))
            .when(!items.length, (g) => g.child(
              v_flex().flex_1().items_center().justify_center().p(24).gap(6)
                .child(svg(`${MOD}/icons/check.svg`).size(20).text_color(t.ansi2))
                .child(div().text_size(12).text_color(t.dim).child(this.branchLoading ? "Comparing branch…" : `No committed diff in ${this.baseTarget?.range || "range"}`)))))
          .when(hasOpen, (d) => d.child(
            div().id("branch-split-edge").absolute().left(0).right(0).bottom(-3).h(6).cursor_row_resize()
              .on_mouse_down("left", (e, cx) => {
                cx.stop_propagation();
                this.dragSplit = { which: "changes", y: e.position.y, from: listH, height: listH };
                cx.notify();
              })))))
      .when(hasOpen, (el) => el.child(
        h_flex().h(30).flex_none().px(10).gap(6).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(11)
          .child(div().flex_none().px(5).py(0.5).rounded(4).bg(t.accent + "22").text_size(9.5).font_bold().text_color(t.accent).child("BRANCH"))
          .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(openFile.path))
          .when(hunkCount > 0, (hEl) => hEl.child(div().flex_none().text_size(10).text_color(t.dim).child(`${hunkCount} hunks`)))
          .child(div().id("bdiff-wrap-btn").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
            .when(this.diffWrap, (w) => w.bg(cardOn))
            .hover((s) => s.bg(cardHover))
            .tooltip(this.diffWrap ? "Disable line wrap" : "Wrap long diff lines")
            .on_click((_e, cx) => this.toggleDiffWrap(cx))
            .child(svg(`${MOD}/icons/text-wrap.svg`).size(12).text_color(this.diffWrap ? t.foreground : t.muted)))
          .child(div().id("bdiff-hist-btn").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
            .hover((s) => s.bg(cardHover))
            .tooltip("View file history in Log")
            .on_click((_e, cx) => this.inspectFileHistory(openFile.path, cx))
            .child(svg(`${MOD}/icons/clock.svg`).size(12).text_color(t.muted)))
          .child(div().id("bdiff-at-btn").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
            .hover((s) => s.bg(cardHover))
            .tooltip("Mention file in agent")
            .on_click((_e, cx) => this.mentionFile(openFile.path, cx))
            .child(svg(`${MOD}/icons/at-sign.svg`).size(12).text_color(t.accent)))
          .child(div().px(5).py(1).rounded(4).bg(t.background).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.stepBranchFile(-1, cx)).child("‹"))
          .child(div().px(5).py(1).rounded(4).bg(t.background).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.stepBranchFile(1, cx)).child("›"))))
      .when(hasOpen, (el) => el.child(this.diffViewport("branch-diff", this.branchDiffRows, this.branchDiffWidth, "", t, openFile.path)));
  }

  renderChangesBody(t) {
    if (this.changesMode === "branch" && this.baseTarget) return this.renderBranchDiffBody(t);
    const cardHover = t.foreground + "12", cardOn = t.foreground + "1f";
    const stagedFiles = this.files.filter((f) => f.staged);
    const unstagedFiles = this.files.filter((f) => f.unstaged);
    const splitSections = stagedFiles.length > 0 && unstagedFiles.length > 0;
    const openFile = this.files.find((f) => f.path === this.open);
    const hunkCount = this.rows.filter((r) => r.kind === "@").length;
    const isTree = this.viewMode === "tree";

    const stagedItems = splitSections
      ? (isTree ? buildChangeTree(stagedFiles, this.collapsed, "staged").map((row) => row.kind === "dir" ? this.dirRow(row, t) : this.fileRow(row.file, t, "staged", row.depth))
        : stagedFiles.map((f) => this.fileRow(f, t, "staged")))
      : [];
    const unstagedItems = splitSections
      ? (isTree ? buildChangeTree(unstagedFiles, this.collapsed, "unstaged").map((row) => row.kind === "dir" ? this.dirRow(row, t) : this.fileRow(row.file, t, "unstaged", row.depth))
        : unstagedFiles.map((f) => this.fileRow(f, t, "unstaged")))
      : [];
    const allItems = !splitSections
      ? (isTree ? buildChangeTree(this.files, this.collapsed, "all").map((row) => row.kind === "dir" ? this.dirRow(row, t) : this.fileRow(row.file, t, "all", row.depth))
        : this.files.map((f) => this.fileRow(f, t, "all")))
      : [];

    const hasOpen = Boolean(openFile);
    const dragging = this.dragSplit?.which === "changes";
    const listH = dragging ? Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, this.dragSplit.height)) : this.changesSplit;

    const scopeLabel = openFile
      ? (openFile.status === "U" ? "CONFLICT" : openFile.fresh ? "UNTRACKED" : this.openSection === "staged" || (openFile.staged && !openFile.unstaged) ? "STAGED" : "UNSTAGED")
      : "";
    const scopeColor = scopeLabel === "CONFLICT" ? t.ansi1 : scopeLabel === "STAGED" ? t.ansi2 : scopeLabel === "UNTRACKED" ? t.accent : t.blocked;

    return v_flex().flex_1().min_h(0)
      .when(this.listOpen, (el) => el.child(
        v_flex().id("changes-list-box").relative()
          .when(hasOpen, (e) => e.flex_none().h(listH).border_b(1).border_color(t.border))
          .when(!hasOpen, (e) => e.flex_1().min_h(0))
          .child(v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
            .when(splitSections, (g) => g.child(
              div().px(6).py(2).text_size(10).font_bold().text_color(t.ansi2).child(`STAGED (${stagedFiles.length})`)))
            .when(splitSections, (g) => g.children(stagedItems))
            .when(splitSections, (g) => g.child(
              div().px(6).pt(6).pb(2).text_size(10).font_bold().text_color(t.muted).child(`CHANGES (${unstagedFiles.length})`)))
            .when(splitSections, (g) => g.children(unstagedItems))
            .when(!splitSections, (g) => g.children(allItems))
            .when(!this.files.length, (e) => e.child(
              v_flex().flex_1().items_center().justify_center().p(24).gap(8)
                .child(svg(`${MOD}/icons/check.svg`).size(22).text_color(this.error ? t.ansi1 : t.ansi2))
                .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(this.error || (this.loading ? "Scanning working tree…" : this.root ? "Working tree clean" : "No folder")))
                .when(Boolean(this.root && !this.error && !this.loading), (hint) => hint.child(
                  div().text_size(11.5).text_color(t.dim).child(this.baseTarget ? `Try ${this.baseTarget.label}, Log, or Branches above.` : "Switch to Log to explore commit history or Branches for repo overview."))))))
          .when(hasOpen, (d) => d.child(
            div().id("changes-split-edge").absolute().left(0).right(0).bottom(-3).h(6).cursor_row_resize()
              .on_mouse_down("left", (e, cx) => {
                cx.stop_propagation();
                this.dragSplit = { which: "changes", y: e.position.y, from: listH, height: listH };
                cx.notify();
              })))))
      .when(this.limited, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(hasOpen, (el) => el.child(
        h_flex().h(30).flex_none().px(10).gap(6).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(11)
          .child(div().flex_none().px(5).py(0.5).rounded(4).bg(scopeColor + "20").text_size(9.5).font_bold().text_color(scopeColor).child(scopeLabel))
          .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(openFile.path))
          .when(hunkCount > 0, (hEl) => hEl.child(div().flex_none().text_size(10).text_color(t.dim).child(`${hunkCount} hunks`)))
          .child(div().id("diff-wrap-btn").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
            .when(this.diffWrap, (w) => w.bg(cardOn))
            .hover((s) => s.bg(cardHover))
            .tooltip(this.diffWrap ? "Disable line wrap" : "Wrap long diff lines")
            .on_click((_e, cx) => this.toggleDiffWrap(cx))
            .child(svg(`${MOD}/icons/text-wrap.svg`).size(12).text_color(this.diffWrap ? t.foreground : t.muted)))
          .child(div().id("diff-history-btn").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
            .hover((s) => s.bg(cardHover))
            .tooltip("View file history in Log")
            .on_click((_e, cx) => this.inspectFileHistory(openFile.path, cx))
            .child(svg(`${MOD}/icons/clock.svg`).size(12).text_color(t.muted)))
          .child(div().id("diff-mention-btn").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
            .hover((s) => s.bg(cardHover))
            .tooltip("Mention file in agent")
            .on_click((_e, cx) => this.mentionFile(openFile.path, cx))
            .child(svg(`${MOD}/icons/at-sign.svg`).size(12).text_color(t.accent)))
          .child(div().id("diff-copy-path").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
            .hover((s) => s.bg(cardHover))
            .tooltip("Copy relative path")
            .on_click((_e, cx) => this.copyText(openFile.path, openFile.path, cx))
            .child(svg(`${MOD}/icons/copy.svg`).size(11).text_color(t.muted)))
          .child(div().px(5).py(1).rounded(4).bg(t.background).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .tooltip("Previous file (k / ↑)")
            .on_click((_e, cx) => this.stepFile(-1, cx)).child("‹"))
          .child(div().px(5).py(1).rounded(4).bg(t.background).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .tooltip("Next file (j / ↓)")
            .on_click((_e, cx) => this.stepFile(1, cx)).child("›"))))
      .when(hasOpen, (el) => el.child(this.diffViewport("changes-diff", this.rows, this.diffWidth, "", t, openFile.path)));
  }

  // ── View 2: Git Log (Multi-Lane Graph + Read-Only Commit Inspector) ──────

  refPill(ref, t) {
    const bg = ref.kind === "head" ? t.accent + "24"
      : ref.kind === "local" ? t.ansi2 + "20"
      : ref.kind === "tag" ? t.blocked + "22"
      : t.raised;
    const fg = ref.kind === "head" ? t.accent
      : ref.kind === "local" ? t.ansi2
      : ref.kind === "tag" ? t.blocked
      : t.muted;
    return h_flex().flex_none().px(5).py(0.5).gap(3).items_center().rounded(4).bg(bg).text_size(10).font_medium().text_color(fg)
      .when(ref.kind === "tag", (el) => el.child(svg(`${MOD}/icons/tag.svg`).size(9).flex_none().text_color(fg)))
      .when(ref.kind === "head", (el) => el.child(svg(`${MOD}/icons/git-branch.svg`).size(9).flex_none().text_color(fg)))
      .child(ref.label);
  }

  graphCell(c, lane, i, total, t) {
    const laneColors = [t.accent, t.ansi2, t.ansi12 || t.ansi4, t.ansi5, t.ansi3];
    const colW = 10;
    const width = Math.max(12, lane.maxCols * colW + 4);
    const isHead = c.refs.some((r) => r.kind === "head");
    const nodeColor = isHead ? t.accent : laneColors[lane.col % laneColors.length];
    const cxPos = lane.col * colW + 5;

    const topSet = new Set(lane.lanesTop);
    const botSet = new Set(lane.lanesBottom);
    const allCols = new Set([...lane.lanesTop, ...lane.lanesBottom, lane.col]);

    const els = [];
    for (const col of allCols) {
      const x = col * colW + 5;
      const color = col === 0 ? t.border : (laneColors[col % laneColors.length] + "88");
      if (i > 0 && topSet.has(col)) {
        els.push(div().absolute().left(x).top(0).w(1.5).h(22).bg(color));
      }
      if (i < total - 1 && botSet.has(col)) {
        els.push(div().absolute().left(x).top(22).w(1.5).h(22).bg(color));
      }
    }
    // Horizontal connector for merge commits joining another lane
    for (const mc of lane.mergeCols) {
      if (mc === lane.col) continue;
      const x0 = Math.min(lane.col, mc) * colW + 5;
      const w = Math.abs(mc - lane.col) * colW;
      els.push(div().absolute().left(x0).top(22).w(w).h(1.5).bg(laneColors[mc % laneColors.length] + "99"));
    }
    // Commit node dot
    const dotSize = c.isMerge ? 8 : 7;
    els.push(div().absolute().left(cxPos - Math.floor(dotSize / 2)).top(22 - Math.floor(dotSize / 2)).size(dotSize).rounded_full()
      .when(c.isMerge, (el) => el.border_1().border_color(nodeColor).bg(t.background))
      .when(!c.isMerge, (el) => el.bg(nodeColor)));

    return div().relative().w(width).h_full().flex_none().children(els);
  }

  commitRow(c, lane, i, total, t) {
    const selected = this.selectedCommit?.sha === c.sha;
    const cardHover = t.foreground + "12", cardOn = t.foreground + "1f";
    const mono = settings().font_family ?? "JetBrains Mono";
    return h_flex().id(`commit-row-${c.shortSha}-${i}`).h(44).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(selected, (el) => el.bg(cardOn))
      .when(!selected, (el) => el.hover((s) => s.bg(cardHover)))
      .on_click((_e, cx) => this.selectCommit(c, cx))
      .child(this.graphCell(c, lane, i, total, t))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().w_full().min_w(0).gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground).child(c.subject || "(no message)"))
          .when(Boolean(c.unpushed), (el) => el.child(
            div().flex_none().px(4).py(0.5).rounded(4).bg(t.ansi2 + "1e").text_size(9.5).font_medium().text_color(t.ansi2).child("↑ local")))
          .children(c.refs.slice(0, 3).map((r) => this.refPill(r, t)))
          .when(c.refs.length > 3, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`+${c.refs.length - 3}`))))
        .child(h_flex().w_full().min_w(0).gap(6).items_center().text_size(10.5)
          .child(div().flex_none().font_family(mono).text_color(selected ? t.accent : t.muted).child(c.shortSha))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(c.author))
          .when(c.isMerge, (el) => el.child(div().flex_none().px(4).rounded(4).bg(t.raised).text_size(9.5).text_color(t.dim).child("merge")))
          .child(div().flex_none().text_color(t.dim).child(c.relTime))))
      .child(div().id(`copy-sha-${c.shortSha}-${i}`).size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(cardHover))
        .tooltip(`Copy ${c.shortSha}`)
        .on_click((_e, cx) => { cx.stop_propagation(); this.copyText(c.sha, c.shortSha, cx); })
        .child(svg(`${MOD}/icons/copy.svg`).size(11).text_color(t.dim)))
      .child(div().id(`mention-sha-${c.shortSha}-${i}`).size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(cardHover))
        .tooltip("Send commit reference to agent")
        .on_click((_e, cx) => { cx.stop_propagation(); this.mentionCommit(c, cx); })
        .child(svg(`${MOD}/icons/at-sign.svg`).size(11).text_color(t.muted)));
  }

  commitDetailView(t) {
    const c = this.selectedCommit;
    if (!c) return null;
    const cardHover = t.foreground + "12", cardOn = t.foreground + "1f";
    const mono = settings().font_family ?? "JetBrains Mono";
    const totalAdd = this.commitFiles.reduce((n, f) => n + f.add, 0);
    const totalDel = this.commitFiles.reduce((n, f) => n + f.del, 0);
    const openFile = this.commitFiles.find((f) => f.path === this.commitFileOpen);

    const fileItems = this.commitTree
      ? buildChangeTree(this.commitFiles, this.collapsed, "commit").map((row) =>
          row.kind === "dir"
            ? this.dirRow(row, t)
            : this.fileRow(row.file, t, "commit", row.depth, (f, cx) => this.pickCommitFile(f, cx), this.commitFileOpen === row.file.path))
      : this.commitFiles.map((f) =>
          this.fileRow(f, t, "commit", null, (item, cx) => this.pickCommitFile(item, cx), this.commitFileOpen === f.path));

    return v_flex().id("commit-inspector").flex_1().min_h(0)
      .child(v_flex().flex_none().px(10).py(8).gap(5).bg(t.raised).border_b(1).border_color(t.border)
        .child(h_flex().w_full().min_w(0).gap(6).items_start()
          .child(div().flex_1().min_w(0).text_size(12.5).font_semibold().text_color(t.foreground).child(c.subject || "(no message)"))
          .when(Boolean(c.unpushed), (el) => el.child(
            div().flex_none().px(5).py(0.5).rounded(4).bg(t.ansi2 + "22").text_size(10).font_medium().text_color(t.ansi2).child("↑ unpushed")))
          .child(div().id("commit-detail-close").size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
            .hover((s) => s.bg(cardHover))
            .tooltip("Close commit details (Esc)")
            .on_click((_e, cx) => { this.selectedCommit = null; this.commitFiles = []; this.commitFileOpen = null; this.setCommitLines([]); cx.notify(); })
            .child(svg(`${MOD}/icons/x.svg`).size(12).text_color(t.muted))))
        .when(Boolean(c.body), (el) => el.child(
          div().max_h(56).overflow_y_scrollbar().text_size(11).text_color(t.muted).child(c.body)))
        .child(h_flex().w_full().min_w(0).gap(8).items_center().text_size(11).text_color(t.dim)
          .child(div().flex_none().font_family(mono).text_color(t.accent).child(c.shortSha))
          .child(div().flex_1().min_w(0).truncate().child(c.email ? `${c.author} <${c.email}>` : c.author))
          .child(div().flex_none().child(shortIso(c.isoTime) || c.relTime)))
        .child(h_flex().w_full().gap(6).items_center()
          .child(h_flex().id("commit-act-copy").h(22).px(8).flex_none().gap(4).items_center().rounded(5).cursor_pointer()
            .bg(t.background).border_1().border_color(t.border).text_size(11).text_color(t.muted)
            .hover((s) => s.bg(cardHover).text_color(t.foreground))
            .on_click((_e, cx) => this.copyText(c.sha, c.shortSha, cx))
            .child(svg(`${MOD}/icons/copy.svg`).size(11).text_color(t.muted))
            .child("Copy SHA"))
          .child(h_flex().id("commit-act-agent").h(22).px(8).flex_none().gap(4).items_center().rounded(5).cursor_pointer()
            .bg(t.background).border_1().border_color(t.input).text_size(11).font_medium().text_color(t.foreground)
            .hover((s) => s.bg(cardHover))
            .on_click((_e, cx) => this.mentionCommit(c, cx))
            .child(svg(`${MOD}/icons/at-sign.svg`).size(11).text_color(t.accent))
            .child("Send to agent"))))
      .child(h_flex().h(28).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).text_size(11)
        .child(h_flex().id("commit-files-toggle").gap(4).items_center().cursor_pointer().text_color(t.muted)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.commitFilesOpen = !this.commitFilesOpen; cx.notify(); })
          .child(this.commitFilesOpen ? "▾" : "▸")
          .child(this.commitLoading ? "Loading files…" : `${this.commitFiles.length} file${this.commitFiles.length === 1 ? "" : "s"}`))
        .when(totalAdd > 0, (el) => el.child(div().text_size(10.5).text_color(t.ansi2).child(`+${totalAdd}`)))
        .when(totalDel > 0, (el) => el.child(div().text_size(10.5).text_color(t.ansi1).child(`−${totalDel}`)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(openFile ? openFile.path : ""))
        .child(div().id("commit-files-tree").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .when(this.commitTree, (w) => w.bg(cardOn))
          .hover((s) => s.bg(cardHover))
          .tooltip(this.commitTree ? "Switch commit files to list view" : "Switch commit files to tree view")
          .on_click((_e, cx) => { this.commitTree = !this.commitTree; cx.notify(); })
          .child(svg(`${MOD}/icons/folder-tree.svg`).size(12).text_color(this.commitTree ? t.foreground : t.muted)))
        .child(div().id("commit-diff-wrap").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .when(this.diffWrap, (w) => w.bg(cardOn))
          .hover((s) => s.bg(cardHover))
          .tooltip(this.diffWrap ? "Disable line wrap" : "Wrap long diff lines")
          .on_click((_e, cx) => this.toggleDiffWrap(cx))
          .child(svg(`${MOD}/icons/text-wrap.svg`).size(12).text_color(this.diffWrap ? t.foreground : t.muted)))
        .when(this.commitFiles.length > 1, (el) => el
          .child(div().px(5).py(1).rounded(4).bg(t.raised).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.stepCommitFile(-1, cx)).child("‹"))
          .child(div().px(5).py(1).rounded(4).bg(t.raised).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.stepCommitFile(1, cx)).child("›"))))
      .when(this.commitFilesOpen && fileItems.length > 0, (el) => el.child(
        v_flex().id("commit-files-list").flex_none().h(Math.min(130, Math.max(32, fileItems.length * 26 + 8))).overflow_y_scrollbar().p(4).gap(1).border_b(1).border_color(t.border)
          .children(fileItems)))
      .child(this.diffViewport("commit-diff", this.commitDiffRows, this.commitDiffWidth, this.commitLoading ? "Loading commit diff…" : "Select a changed file to view diff", t, openFile?.path || ""));
  }

  renderLogBody(t) {
    const cardHover = t.foreground + "12";
    const visible = this.appliedQuery === this.logQuery.trim()
      ? this.commits
      : filterCommits(this.commits, this.logQuery);
    const lanes = assignGraphLanes(visible);
    const hasDetail = Boolean(this.selectedCommit);
    const dragging = this.dragSplit?.which === "log";
    const listH = dragging ? Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, this.dragSplit.height)) : this.logSplit;
    const parsedApplied = parseLogQuery(this.appliedQuery);

    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(32).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(svg(`${MOD}/icons/search.svg`).size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).h_full().flex().items_center()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.logSearchInput).h_full().text_size(12).text_color(t.foreground)))
        .when(Boolean(this.logQuery.trim()) && this.logQuery.trim() !== this.appliedQuery, (el) => el.child(
          div().id("log-search-run").h(20).px(6).flex_none().flex().items_center().rounded(4).cursor_pointer()
            .bg(t.raised).text_size(10.5).font_medium().text_color(t.accent)
            .hover((s) => s.bg(cardHover))
            .tooltip("Search full repository history (Enter)")
            .on_click((_e, cx) => this.submitLogSearch(cx))
            .child("Search repo")))
        .when(Boolean(this.logQuery || this.appliedQuery), (el) => el
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${visible.length}${this.logHasMore ? "+" : ""}`))
          .child(div().id("log-search-clear").size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
            .hover((s) => s.bg(cardHover))
            .on_click((_e, cx) => this.clearLogSearch(cx))
            .child(svg(`${MOD}/icons/x.svg`).size(11).text_color(t.muted)))))
      .when(parsedApplied.active, (el) => el.child(
        h_flex().flex_none().px(10).py(4).gap(5).items_center().border_b(1).border_color(t.border).bg(t.raised).text_size(10.5)
          .child(div().text_color(t.dim).child("Repo query:"))
          .when(Boolean(parsedApplied.path), (p) => p.child(div().px(5).py(0.5).rounded(4).bg(t.background).text_color(t.accent).child(`path:${parsedApplied.path}`)))
          .when(Boolean(parsedApplied.author), (a) => a.child(div().px(5).py(0.5).rounded(4).bg(t.background).text_color(t.foreground).child(`author:${parsedApplied.author}`)))
          .when(Boolean(parsedApplied.grep), (g) => g.child(div().px(5).py(0.5).rounded(4).bg(t.background).text_color(t.foreground).child(`"${parsedApplied.grep}"`)))
          .when(Boolean(parsedApplied.sha), (s) => s.child(div().px(5).py(0.5).rounded(4).bg(t.background).text_color(t.accent).child(parsedApplied.sha)))
          .child(div().flex_1())
          .child(div().id("log-query-reset").cursor_pointer().text_color(t.muted).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => this.clearLogSearch(cx)).child("Clear"))))
      .when(!hasDetail || this.logListOpen, (el) => el.child(
        v_flex().id("git-log-box").relative()
          .when(hasDetail, (e) => e.flex_none().h(listH).border_b(1).border_color(t.border))
          .when(!hasDetail, (e) => e.flex_1().min_h(0))
          .child(v_flex().id("git-log-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
            .when(visible.length > 0, (g) => g.children(visible.map((c, i) => this.commitRow(c, lanes[i], i, visible.length, t))))
            .when(this.logHasMore && visible.length > 0, (g) => g.child(
              h_flex().id("log-load-more").h(28).mt(4).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
                .bg(t.raised).text_size(11.5).text_color(t.muted)
                .hover((s) => s.bg(cardHover).text_color(t.foreground))
                .on_click((_e, cx) => this.loadLog(cx, this.logLimit + LOG_PAGE))
                .child(this.logLoading ? "Loading…" : `Load more (+${LOG_PAGE})`)))
            .when(!visible.length, (g) => g.child(
              v_flex().flex_1().items_center().justify_center().p(20).gap(6)
                .child(svg(`${MOD}/icons/clock.svg`).size(20).text_color(t.dim))
                .child(div().text_size(12).text_color(t.dim).child(
                  this.error || (this.logLoading ? "Loading commit history…" : !this.hasHead ? "No commits yet" : this.logQuery ? "No matching commits (press Enter to search full repo)" : "No commits found"))))))
          .when(hasDetail, (d) => d.child(
            div().id("log-split-edge").absolute().left(0).right(0).bottom(-3).h(6).cursor_row_resize()
              .on_mouse_down("left", (e, cx) => {
                cx.stop_propagation();
                this.dragSplit = { which: "log", y: e.position.y, from: listH, height: listH };
                cx.notify();
              })))))
      .when(hasDetail, (el) => el.child(this.commitDetailView(t)));
  }

  // ── View 3: Branches, Worktrees (with Dirty/Ahead Radar) & Stashes ───────

  renderBranchesBody(t) {
    const cardHover = t.foreground + "12", cardOn = t.foreground + "1f";
    const mono = settings().font_family ?? "JetBrains Mono";
    const { local, remote } = this.branches;
    const hasStashDiff = Boolean(this.openStashRef);

    const branchRow = (b, idx, isRemote = false) => h_flex().id(`br-${isRemote ? "r" : "l"}-${idx}`).h(40).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .bg(b.isHead ? t.foreground + "14" : t.background)
      .when(!b.isHead, (el) => el.hover((s) => s.bg(cardHover)))
      .tooltip(`View ${b.name} commit history in Log`)
      .on_click((_e, cx) => this.inspectBranchLog(b.name, cx))
      .child(svg(`${MOD}/icons/git-branch.svg`).size(13).flex_none().text_color(b.isHead ? t.accent : isRemote ? t.dim : t.muted))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().w_full().min_w(0).gap(6).items_center()
          .child(div().min_w(0).truncate().text_size(12).font_medium().text_color(b.isHead ? t.foreground : isRemote ? t.muted : t.foreground).child(b.name))
          .when(Boolean(b.isHead), (el) => el.child(div().flex_none().px(5).py(0.5).rounded(4).bg(t.accent + "24").text_size(9.5).font_bold().text_color(t.accent).child("HEAD")))
          .when(b.ahead > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.ansi2).child(`↑${b.ahead}`)))
          .when(b.behind > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.blocked).child(`↓${b.behind}`)))
          .when(Boolean(b.gone), (el) => el.child(div().flex_none().text_size(10).text_color(t.ansi1).child("gone"))))
        .child(h_flex().w_full().min_w(0).gap(6).items_center().text_size(10.5).text_color(t.dim)
          .child(div().flex_none().font_family(mono).child(b.sha))
          .child(div().flex_1().min_w(0).truncate().child(b.subject))
          .child(div().flex_none().child(b.relTime))))
      .child(div().id(`br-copy-${isRemote ? "r" : "l"}-${idx}`).size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
        .hover((s) => s.bg(cardHover))
        .tooltip(`Copy ${b.name}`)
        .on_click((_e, cx) => { cx.stop_propagation(); this.copyText(b.name, b.name, cx); })
        .child(svg(`${MOD}/icons/copy.svg`).size(11).text_color(t.dim)));

    const stashRow = (st, idx) => {
      const isDiffOpen = this.openStashRef === st.ref;
      return h_flex().id(`stash-${idx}`).h(40).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(isDiffOpen, (el) => el.bg(cardOn))
        .when(!isDiffOpen, (el) => el.hover((s) => s.bg(cardHover)))
        .on_click((_e, cx) => this.toggleStashDiff(st, cx))
        .child(svg(`${MOD}/icons/layers.svg`).size(13).flex_none().text_color(isDiffOpen ? t.accent : t.muted))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().w_full().min_w(0).gap(6).items_center()
            .child(div().flex_none().font_family(mono).text_size(10.5).text_color(t.accent).child(st.ref))
            .when(Boolean(st.branch), (el) => el.child(div().flex_none().px(4).rounded(4).bg(t.raised).text_size(9.5).text_color(t.muted).child(st.branch)))
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(t.foreground).child(st.message)))
          .child(div().text_size(10.5).text_color(t.dim).child(st.relTime)))
        .child(div().id(`stash-at-${idx}`).size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
          .hover((s) => s.bg(cardHover))
          .tooltip("Send stash reference to agent")
          .on_click((_e, cx) => { cx.stop_propagation(); this.mentionStash(st, cx); })
          .child(svg(`${MOD}/icons/at-sign.svg`).size(11).text_color(t.muted)));
    };

    return v_flex().flex_1().min_h(0)
      .child(v_flex().id("git-branches-list")
        .when(hasStashDiff, (e) => e.flex_none().h(240).border_b(1).border_color(t.border))
        .when(!hasStashDiff, (e) => e.flex_1().min_h(0))
        .overflow_y_scrollbar().p(8).gap(2)
        .when(this.worktrees.length > 1, (g) => g
          .child(div().px(6).py(3).text_size(10).font_bold().text_color(t.dim).child(`WORKTREES (${this.worktrees.length})`))
          .children(this.worktrees.map((wt, idx) => {
            const isCurrent = Boolean(this.root && normKey(wt.path) === normKey(this.root));
            return h_flex().id(`wt-${idx}`).h(40).flex_none().px(8).gap(8).items_center().rounded(6)
              .bg(isCurrent ? t.foreground + "14" : t.background)
              .when(!isCurrent && !wt.bare, (el) => el.cursor_pointer().hover((s) => s.bg(cardHover))
                .tooltip("Open or switch to this worktree space")
                .on_click((_e, cx) => this.openWorktreeSpace(wt, cx)))
              .child(svg(`${MOD}/icons/folder.svg`).size(13).flex_none().text_color(isCurrent ? t.accent : t.muted))
              .child(v_flex().flex_1().min_w(0).gap(1)
                .child(h_flex().gap(5).items_center()
                  .child(div().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground).child(wt.bare ? "(bare)" : wt.branch || `HEAD@${wt.shortHead}`))
                  .when(isCurrent, (c) => c.child(div().flex_none().px(5).py(0.5).rounded(4).bg(t.accent + "24").text_size(9.5).font_bold().text_color(t.accent).child("current")))
                  .when(wt.dirtyCount > 0, (d) => d.child(div().flex_none().px(4).py(0.5).rounded(4).bg(t.blocked + "22").text_size(9.5).font_medium().text_color(t.blocked).child(`${wt.dirtyCount} dirty`)))
                  .when(wt.ahead > 0, (a) => a.child(div().flex_none().text_size(10).text_color(t.ansi2).child(`↑${wt.ahead}`)))
                  .when(wt.behind > 0, (b) => b.child(div().flex_none().text_size(10).text_color(t.blocked).child(`↓${wt.behind}`))))
                .child(div().w_full().truncate().text_size(10.5).text_color(t.dim).child(wt.path)))
              .when(!isCurrent && !wt.bare, (el) => el.child(svg(`${MOD}/icons/external-link.svg`).size(11).flex_none().text_color(t.dim)));
          })))
        .child(div().px(6).pt(this.worktrees.length > 1 ? 10 : 3).pb(3).text_size(10).font_bold().text_color(t.dim).child(`LOCAL BRANCHES (${local.length})`))
        .when(local.length > 0, (g) => g.children(local.map((b, i) => branchRow(b, i, false))))
        .when(!local.length, (g) => g.child(div().px(8).py(6).text_size(12).text_color(t.dim).child(this.error || (this.metaLoading ? "Loading branches…" : "No local branches"))))
        .child(div().px(6).pt(10).pb(3).text_size(10).font_bold().text_color(t.dim).child(`STASHES (${this.stashes.length})`))
        .when(this.stashes.length > 0, (g) => g.children(this.stashes.map((st, i) => stashRow(st, i))))
        .when(!this.stashes.length, (g) => g.child(div().px(8).py(4).text_size(11.5).text_color(t.dim).child("No stashed changes")))
        .when(remote.length > 0, (g) => g
          .child(h_flex().id("remotes-section-toggle").px(6).pt(10).pb(3).gap(4).items_center().cursor_pointer()
            .text_size(10).font_bold().text_color(t.dim)
            .hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.remotesOpen = !this.remotesOpen; this.remotesTouched = true; cx.notify(); })
            .child(this.remotesOpen ? "▾" : "▸")
            .child(`REMOTE BRANCHES (${remote.length})`))
          .when(this.remotesOpen, (rEl) => rEl.children(remote.slice(0, 100).map((b, i) => branchRow(b, i, true))))))
      .when(hasStashDiff, (el) => el.child(
        v_flex().flex_1().min_h(0)
          .child(h_flex().h(28).flex_none().px(10).gap(6).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(11)
            .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(`Stash diff · ${this.openStashRef}`))
            .child(div().id("stash-diff-wrap").size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
              .when(this.diffWrap, (w) => w.bg(cardOn))
              .hover((s) => s.bg(cardHover))
              .tooltip(this.diffWrap ? "Disable line wrap" : "Wrap long diff lines")
              .on_click((_e, cx) => this.toggleDiffWrap(cx))
              .child(svg(`${MOD}/icons/text-wrap.svg`).size(12).text_color(this.diffWrap ? t.foreground : t.muted)))
            .child(div().id("stash-diff-close").size(20).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
              .hover((s) => s.bg(cardHover))
              .on_click((_e, cx) => { this.openStashRef = null; this.setStashLines([]); cx.notify(); })
              .child(svg(`${MOD}/icons/x.svg`).size(12).text_color(t.muted))))
          .child(this.diffViewport("stash-diff", this.stashDiffRows, this.stashDiffWidth, this.stashDiffLoading ? "Loading stash diff…" : "", t))));
  }

  render(cx) {
    if (key() !== this.context && !this.refreshQueued) {
      this.refreshQueued = true;
      cx.timer.after(0, (c) => { this.refreshQueued = false; this.refresh(c, { full: true }); });
    }
    const t = theme();
    const z = Number(settings()?.zoom) || 1;
    const add = this.files.reduce((n, f) => n + f.add, 0);
    const del = this.files.reduce((n, f) => n + f.del, 0);
    const stagedCount = this.files.filter((f) => f.staged).length;
    const conflictCount = this.files.filter((f) => f.status === "U").length;

    return v_flex().id("t3-changes").size_full().min_h(0).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .when(Boolean(this.dragSplit), (el) => el.cursor_row_resize())
      .on_mouse_move((e, cx) => {
        if (!this.dragSplit) return;
        const nextH = this.dragSplit.from + (e.position.y - this.dragSplit.y) / z;
        if (Math.abs(nextH - this.dragSplit.height) > 0.5) {
          this.dragSplit.height = nextH;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => this.endSplitDrag(cx))
      .on_hover((on, cx) => { if (!on && this.dragSplit) this.endSplitDrag(cx); })
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.typing) {
            this.typing = false;
            this.handle.focus();
            cx.stop_propagation();
            cx.notify();
          } else if (this.activeTab === "log" && this.selectedCommit) {
            this.selectedCommit = null;
            this.commitFiles = [];
            this.commitFileOpen = null;
            this.setCommitLines([]);
            cx.stop_propagation();
            cx.notify();
          } else if (this.activeTab === "branches" && this.openStashRef) {
            this.openStashRef = null;
            this.setStashLines([]);
            cx.stop_propagation();
            cx.notify();
          }
          return;
        }
        if (this.typing) return;
        if (e.key === "j" || e.key === "down") {
          if (this.activeTab === "changes") { this.stepFile(1, cx); cx.stop_propagation(); }
          else if (this.activeTab === "log" && this.commits.length) { this.stepCommit(1, cx); cx.stop_propagation(); }
        } else if (e.key === "k" || e.key === "up") {
          if (this.activeTab === "changes") { this.stepFile(-1, cx); cx.stop_propagation(); }
          else if (this.activeTab === "log" && this.commits.length) { this.stepCommit(-1, cx); cx.stop_propagation(); }
        }
      })
      .child(this.repoToolbar(t, { add, del, conflictCount }))
      .child(this.subTabBar(t, { stagedCount }))
      .when(Boolean(this.note), (el) => el.child(
        h_flex().flex_none().px(10).py(5).gap(6).items_center().border_b(1).border_color(t.border)
          .bg(this.noteKind === "ok" ? t.ansi2 + "18" : t.ansi1 + "18")
          .child(div().flex_1().min_w(0).text_size(11).text_color(this.noteKind === "ok" ? t.ansi2 : t.ansi1).child(this.note))
          .child(div().id("git-note-close").size(18).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
            .on_click((_e, cx) => { this.note = null; cx.notify(); })
            .child(svg(`${MOD}/icons/x.svg`).size(10).text_color(t.muted)))))
      .when(this.activeTab === "changes", (el) => el.child(this.renderChangesBody(t)))
      .when(this.activeTab === "log", (el) => el.child(this.renderLogBody(t)))
      .when(this.activeTab === "branches", (el) => el.child(this.renderBranchesBody(t)));
  }
}
