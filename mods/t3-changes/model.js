// Pure data helpers for t3-changes (Read-First Git Radar & Agent Handoff):
// persisted prefs, compacted tree, branch/log/commit/stash/worktree parsers,
// default-base branch comparison, commit graph lane layout, hunk/line agent handoff.

export const VIEW_MODE_KEY = "list.mode";
export const TAB_KEY = "git.tab";
export const LOG_SCOPE_KEY = "log.scope";
export const DIFF_WRAP_KEY = "diff.wrap";
export const CHANGES_SPLIT_KEY = "changes.split";
export const LOG_SPLIT_KEY = "log.split";

export const LOG_FORMAT = "%x1e%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%ar%x1f%aI%x1f%s%x1f%b";
export const BRANCH_FORMAT = "%(HEAD)%1f%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:relative)%1f%(subject)";
export const STASH_FORMAT = "%gd%x1f%h%x1f%cr%x1f%gs";

const VALID_TABS = new Set(["changes", "log", "branches"]);

const sortKey = (name) => name.toLowerCase().replace(/\d+/g, (d) => d.padStart(16, "0"));
const compareNames = (a, b) => {
  const ka = sortKey(a), kb = sortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
};

/** Read persisted file list layout ("list" by default, or "tree"). */
export function readViewMode() {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "tree" ? "tree" : "list";
  } catch {
    return "list";
  }
}

/** Persist file list layout ("list" or "tree"). */
export function writeViewMode(mode) {
  const value = mode === "tree" ? "tree" : "list";
  try { localStorage.setItem(VIEW_MODE_KEY, value); } catch {}
  return value;
}

/** Read persisted active Git sub-tab ("changes", "log", or "branches"). */
export function readActiveTab() {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return VALID_TABS.has(v) ? v : "changes";
  } catch {
    return "changes";
  }
}

/** Persist active Git sub-tab. */
export function writeActiveTab(tab) {
  const value = VALID_TABS.has(tab) ? tab : "changes";
  try { localStorage.setItem(TAB_KEY, value); } catch {}
  return value;
}

/** Read persisted Git log scope ("current" or "all"). */
export function readLogScope() {
  try {
    return localStorage.getItem(LOG_SCOPE_KEY) === "all" ? "all" : "current";
  } catch {
    return "current";
  }
}

/** Persist Git log scope ("current" or "all"). */
export function writeLogScope(scope) {
  const value = scope === "all" ? "all" : "current";
  try { localStorage.setItem(LOG_SCOPE_KEY, value); } catch {}
  return value;
}

/** Read persisted diff line-wrap preference (false by default). */
export function readDiffWrap() {
  try {
    return localStorage.getItem(DIFF_WRAP_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist diff line-wrap preference. */
export function writeDiffWrap(on) {
  const value = Boolean(on);
  try { localStorage.setItem(DIFF_WRAP_KEY, String(value)); } catch {}
  return value;
}

/** Read persisted split height in logical px, clamped to `[min, max]`. */
export function readSplitHeight(storageKey, fallback, min = 90, max = 460) {
  try {
    const n = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(n) && n >= min && n <= max) return Math.round(n);
  } catch {}
  return fallback;
}

/** Persist clamped split height in logical px. */
export function writeSplitHeight(storageKey, value, min = 90, max = 460) {
  const clamped = Math.round(Math.max(min, Math.min(max, Number(value) || min)));
  try { localStorage.setItem(storageKey, String(clamped)); } catch {}
  return clamped;
}

/** Parse `%(upstream:track)` or status bracket text like `[ahead 2, behind 1]` / `[gone]`. */
export function parseAheadBehind(trackText) {
  const text = String(trackText || "");
  const aheadMatch = /ahead\s+(\d+)/i.exec(text);
  const behindMatch = /behind\s+(\d+)/i.exec(text);
  const gone = /\bgone\b/i.test(text);
  return {
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
    gone,
  };
}

/**
 * Parse the leading `## ...` header from `git status --porcelain=v1 -b -z`.
 * Handles unborn branches, detached HEAD, upstream tracking, ahead/behind, and gone upstreams.
 */
export function parseBranchHeader(line, headSha = "") {
  const raw = String(line || "").replace(/^##\s*/, "").trim();
  if (!raw) {
    return { branch: "", upstream: "", ahead: 0, behind: 0, gone: false, detached: false, unborn: false, headSha };
  }
  const unborn = /^(?:No commits yet on|Initial commit on)\s+(.+)$/i.exec(raw);
  if (unborn) {
    return { branch: unborn[1].trim(), upstream: "", ahead: 0, behind: 0, gone: false, detached: false, unborn: true, headSha: "" };
  }
  if (/^HEAD\s*\(no branch\)/i.test(raw) || raw === "HEAD") {
    return { branch: headSha ? `HEAD@${headSha}` : "HEAD", upstream: "", ahead: 0, behind: 0, gone: false, detached: true, unborn: false, headSha };
  }
  const trackMatch = /^(.*?)\s+\[([^\]]+)\]\s*$/.exec(raw);
  const mainPart = trackMatch ? trackMatch[1].trim() : raw;
  const track = parseAheadBehind(trackMatch ? trackMatch[2] : "");
  const dots = mainPart.indexOf("...");
  const branch = dots >= 0 ? mainPart.slice(0, dots) : mainPart;
  const upstream = dots >= 0 ? mainPart.slice(dots + 3) : "";
  return { branch, upstream, ...track, detached: false, unborn: false, headSha };
}

/** Parse `%D` decoration string into structured badges (`head`, `local`, `remote`, `tag`). */
export function parseRefDecorations(raw, remoteNames = new Set(["origin"])) {
  if (!raw || !raw.trim()) return [];
  const out = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part.startsWith("HEAD -> ")) {
      out.push({ kind: "head", label: part.slice("HEAD -> ".length).trim(), isHead: true });
    } else if (part === "HEAD") {
      out.push({ kind: "head", label: "HEAD", isHead: true });
    } else if (part.startsWith("tag: ")) {
      out.push({ kind: "tag", label: part.slice("tag: ".length).trim(), isHead: false });
    } else {
      const slash = part.indexOf("/");
      const prefix = slash > 0 ? part.slice(0, slash) : "";
      const isRemote = Boolean(prefix && remoteNames.has(prefix));
      if (isRemote && part.endsWith("/HEAD")) continue;
      out.push({ kind: isRemote ? "remote" : "local", label: part, isHead: false });
    }
  }
  return out;
}

/** Parse `git rev-list @{u}..HEAD` output into a Set of full commit SHAs not yet pushed upstream. */
export function parseUnpushedShas(stdout) {
  const out = new Set();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const sha = line.trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) out.add(sha);
  }
  return out;
}

/** Parse `git log --format=LOG_FORMAT` output into structured commit records. */
export function parseGitLog(stdout, remoteNames = new Set(["origin"]), unpushedSet = null) {
  if (!stdout) return [];
  const commits = [];
  for (const raw of stdout.split("\x1e")) {
    const cleaned = raw.replace(/^\r?\n/, "");
    if (!cleaned) continue;
    const fields = cleaned.split("\x1f");
    if (fields.length < 9) continue;
    const [sha, shortSha, parentStr, decos, author, email, relTime, isoTime, subject, ...bodyParts] = fields;
    if (!sha || !shortSha) continue;
    const fullSha = sha.trim();
    const parents = parentStr ? parentStr.trim().split(/\s+/).filter(Boolean) : [];
    const body = bodyParts.join("\x1f").replace(/\r\n/g, "\n").trim();
    commits.push({
      sha: fullSha,
      shortSha: shortSha.trim(),
      parents,
      isMerge: parents.length > 1,
      unpushed: Boolean(unpushedSet && unpushedSet.has(fullSha)),
      refs: parseRefDecorations(decos, remoteNames),
      author: author.trim(),
      email: email.trim(),
      relTime: relTime.trim(),
      isoTime: isoTime.trim(),
      subject: subject.trim(),
      body,
    });
  }
  return commits;
}

/**
 * Assign compact multi-lane graph metadata to a list of commits (capped at `maxLanes`).
 * Returns an array parallel to `commits` with `{ col, lanesTop, lanesBottom, maxCols, mergeCols }`.
 */
export function assignGraphLanes(commits, maxLanes = 5) {
  let active = []; // array of expected next commit SHAs per lane
  let peak = 1;
  const raw = commits.map((c) => {
    let col = active.indexOf(c.sha);
    if (col < 0) {
      // Find first empty slot or append
      const empty = active.indexOf(null);
      if (empty >= 0) {
        col = empty;
        active[col] = c.sha;
      } else if (active.length < maxLanes) {
        col = active.length;
        active.push(c.sha);
      } else {
        col = maxLanes - 1;
        active[col] = c.sha;
      }
    }
    const lanesTop = active.map((sha, idx) => (sha ? idx : -1)).filter((idx) => idx >= 0);

    // Replace all lanes waiting for this commit; first parent continues in `col`, extra parents fork/merge
    const next = [...active];
    for (let i = 0; i < next.length; i++) {
      if (next[i] === c.sha && i !== col) next[i] = null;
    }
    const [firstParent, ...extraParents] = c.parents || [];
    next[col] = firstParent || null;

    const mergeCols = [];
    for (const p of extraParents) {
      const existing = next.indexOf(p);
      if (existing >= 0) {
        mergeCols.push(existing);
      } else {
        const slot = next.indexOf(null);
        if (slot >= 0) {
          next[slot] = p;
          mergeCols.push(slot);
        } else if (next.length < maxLanes) {
          mergeCols.push(next.length);
          next.push(p);
        }
      }
    }

    // Trim trailing null slots
    while (next.length > 0 && next[next.length - 1] === null) next.pop();
    const lanesBottom = next.map((sha, idx) => (sha ? idx : -1)).filter((idx) => idx >= 0);
    const rowCols = Math.max(col + 1, active.length, next.length);
    if (rowCols > peak) peak = rowCols;
    active = next;
    return { col, lanesTop, lanesBottom, mergeCols };
  });

  const maxCols = Math.min(maxLanes, Math.max(1, peak));
  return raw.map((r) => ({ ...r, maxCols }));
}

/**
 * Pick the best comparison base for `Branch Diff` (`<base>...HEAD`).
 * On a feature branch: prefers local `main`/`master` or `origin/main`/`origin/master`.
 * On the default branch itself: compares against `upstream` (e.g. `origin/main`) when ahead/diverged.
 */
export function detectDefaultBase(branches, repo) {
  const current = repo?.branch || "";
  const localNames = new Set((branches?.local || []).map((b) => b.name));
  const remoteNames = new Set((branches?.remote || []).map((b) => b.name));

  // If currently on a non-default branch, compare against default base branch
  const candidates = ["main", "master", "origin/main", "origin/master", "develop", "origin/develop"];
  for (const name of candidates) {
    if (name === current) continue;
    if (localNames.has(name) || remoteNames.has(name)) {
      return { base: name, range: `${name}...HEAD`, label: `vs ${name}` };
    }
  }
  // If on main/master itself and has an upstream, allow comparing against upstream (`origin/main..HEAD`)
  if (repo?.upstream && !repo.gone) {
    return { base: repo.upstream, range: `${repo.upstream}...HEAD`, label: `vs ${repo.upstream}` };
  }
  return null;
}

/**
 * Parse a log search query into structured backend git log filters.
 * Supports `path:<file>`, `author:<name>`, and free-text grep terms (or standalone 7-40 char hex SHA).
 */
export function parseLogQuery(raw) {
  const text = String(raw || "").trim();
  if (!text) return { path: "", author: "", grep: "", sha: "", active: false };
  let path = "", author = "";
  const rest = [];
  for (const tok of text.split(/\s+/)) {
    if (tok.toLowerCase().startsWith("path:") && tok.length > 5) path = tok.slice(5);
    else if (tok.toLowerCase().startsWith("author:") && tok.length > 7) author = tok.slice(7);
    else rest.push(tok);
  }
  const grep = rest.join(" ").trim();
  const sha = !path && !author && /^[0-9a-f]{7,40}$/i.test(grep) ? grep : "";
  return { path, author, grep: sha ? "" : grep, sha, active: Boolean(path || author || grep || sha) };
}

/** Build read-only `git log` arg array honoring scope, branch override, pagination, and backend query. */
export function buildLogArgs({ limit = 80, scope = "current", branch = "", query = "" }) {
  const q = parseLogQuery(query);
  const args = ["log", "-n", String(limit + 1), `--format=${LOG_FORMAT}`];
  if (q.sha) {
    args.push(q.sha);
  } else {
    if (branch) args.push(branch);
    else if (scope === "all") args.push("--all");
    if (q.author) args.push("--regexp-ignore-case", `--author=${q.author}`);
    if (q.grep) args.push("--regexp-ignore-case", "--fixed-strings", `--grep=${q.grep}`);
    if (q.path) args.push("--", q.path);
  }
  return args;
}

/** Multi-token case-insensitive client-side filter for instant feedback while typing. */
export function filterCommits(commits, query) {
  const q = parseLogQuery(query);
  if (!q.active) return commits;
  if (q.path && !q.grep && !q.author && !q.sha) return commits;
  const tokens = [q.sha, q.author, ...q.grep.split(/\s+/)].filter(Boolean).map((s) => s.toLowerCase());
  if (!tokens.length) return commits;
  return commits.filter((c) => {
    const hay = `${c.sha} ${c.shortSha} ${c.subject} ${c.body} ${c.author} ${(c.refs || []).map((r) => r.label).join(" ")}`.toLowerCase();
    return tokens.every((tok) => hay.includes(tok));
  });
}

/**
 * Parse `git diff-tree --root --no-commit-id --name-status -r -z -M` (or `git diff --name-status -z -M`)
 * and matching `--numstat -z -M` outputs into changed file entries.
 */
export function parseCommitFiles(nameStatusOut, numstatOut = "") {
  const stats = new Map();
  if (numstatOut) {
    const tokens = numstatOut.split("\0");
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (!entry) continue;
      const parts = entry.split("\t");
      if (parts.length < 3) continue;
      const [a, d, ...rest] = parts;
      let path = rest.join("\t");
      if (!path && i + 2 < tokens.length) {
        i += 2;
        path = tokens[i];
      }
      if (!path) continue;
      stats.set(path, { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" });
    }
  }
  const files = [];
  const tokens = String(nameStatusOut || "").split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const rawStatus = tokens[i];
    if (!rawStatus) continue;
    const code = rawStatus[0];
    if (code === "R" || code === "C") {
      const oldPath = tokens[++i] || "";
      const newPath = tokens[++i] || "";
      if (!newPath) continue;
      const stat = stats.get(newPath) ?? { add: 0, del: 0, binary: false };
      files.push({ path: newPath, oldPath, status: code, ...stat });
    } else {
      const path = tokens[++i] || "";
      if (!path) continue;
      const stat = stats.get(path) ?? { add: 0, del: 0, binary: false };
      files.push({ path, oldPath: null, status: code === "A" || code === "D" || code === "M" ? code : "M", ...stat });
    }
  }
  return files;
}

/** Parse `git for-each-ref --format=BRANCH_FORMAT refs/heads refs/remotes` output. */
export function parseBranches(stdout) {
  const local = [];
  const remote = [];
  const remoteNames = new Set();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [headMark, refname, shortName, sha, upstream, track, relTime, ...subjectParts] = line.split("\x1f");
    if (!refname || !shortName) continue;
    const subject = subjectParts.join("\x1f").trim();
    const isRemote = refname.startsWith("refs/remotes/");
    if (isRemote) {
      if (refname.endsWith("/HEAD")) continue;
      const slash = shortName.indexOf("/");
      if (slash > 0) remoteNames.add(shortName.slice(0, slash));
      remote.push({
        name: shortName,
        refname,
        sha: (sha || "").trim(),
        relTime: (relTime || "").trim(),
        subject,
        isRemote: true,
      });
    } else if (refname.startsWith("refs/heads/")) {
      const ab = parseAheadBehind(track);
      local.push({
        name: shortName,
        refname,
        isHead: headMark === "*",
        sha: (sha || "").trim(),
        upstream: (upstream || "").trim(),
        ...ab,
        relTime: (relTime || "").trim(),
        subject,
        isRemote: false,
      });
    }
  }
  local.sort((a, b) => Number(b.isHead) - Number(a.isHead));
  if (!remoteNames.size) remoteNames.add("origin");
  return { local, remote, remoteNames };
}

/** Parse `git stash list --format=STASH_FORMAT` output. */
export function parseStashes(stdout) {
  const out = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, sha, relTime, ...msgParts] = line.split("\x1f");
    if (!ref) continue;
    const rawMsg = msgParts.join("\x1f").trim();
    const bm = /^(?:WIP on|On)\s+([^:]+):\s*(.*)$/i.exec(rawMsg);
    out.push({
      ref: ref.trim(),
      sha: (sha || "").trim(),
      relTime: (relTime || "").trim(),
      branch: bm ? bm[1].trim() : "",
      message: bm ? (bm[2].trim() || rawMsg) : rawMsg,
    });
  }
  return out;
}

/** Parse `git worktree list --porcelain` output. */
export function parseWorktrees(stdout) {
  const blocks = String(stdout || "").replace(/\r\n/g, "\n").trim().split(/\n\n+/);
  const out = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const item = { path: "", head: "", shortHead: "", branch: "", bare: false, detached: false, dirtyCount: 0, ahead: 0, behind: 0 };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) item.path = line.slice("worktree ".length).trim().replace(/\\/g, "/");
      else if (line.startsWith("HEAD ")) {
        item.head = line.slice("HEAD ".length).trim();
        item.shortHead = item.head.slice(0, 7);
      } else if (line.startsWith("branch ")) item.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      else if (line === "bare") item.bare = true;
      else if (line === "detached") item.detached = true;
    }
    if (item.path) out.push(item);
  }
  return out;
}

/** Parse `git status --porcelain=v1 -b` of a secondary worktree into `{ dirtyCount, ahead, behind }`. */
export function parseWorktreeStatus(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  let header = "";
  let dirtyCount = 0;
  for (const line of lines) {
    if (!header && line.startsWith("## ")) { header = line; continue; }
    dirtyCount++;
  }
  const info = parseBranchHeader(header, "");
  return { dirtyCount, ahead: info.ahead, behind: info.behind };
}

/** Parse a unified diff hunk header `@@ -a,b +c,d @@` into line range metadata. */
export function parseHunkRange(text) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(String(text || ""));
  if (!m) return null;
  const oldStart = Number(m[1]);
  const oldCount = m[2] === undefined ? 1 : Number(m[2]);
  const newStart = Number(m[3]);
  const newCount = m[4] === undefined ? 1 : Number(m[4]);
  const newEnd = newCount > 0 ? newStart + newCount - 1 : newStart;
  return { oldStart, oldCount, newStart, newCount, newEnd };
}

/**
 * Build read-only `git diff` arg array for a working tree file, strictly separating
 * staged (`--cached`) vs unstaged (working tree) diffs when the file lives in a split section.
 */
export function buildWorkingDiffArgs(file, { section = "all", hasHead = true }) {
  const base = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
  if (section === "staged") return [...base, "--cached", "--", file.path];
  if (section === "unstaged") return [...base, "--", file.path];
  if (file.staged && !file.unstaged) return [...base, "--cached", "--", file.path];
  return [...base, ...(hasHead ? ["HEAD"] : []), "--", file.path];
}

/** Parse unified diff lines into renderable numbered rows (with both oldNum, newNum, and hunk range). */
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const hunk = parseHunkRange(line);
    if (hunk) {
      old = hunk.oldStart;
      next = hunk.newStart;
      return { kind: "@", text: line, hunk };
    }
    if (line.startsWith("diff --git ")) return { kind: "file", text: line };
    const kind = line[0];
    if (kind === "-") {
      const n = old++;
      return { kind, number: n, oldNum: n, newNum: undefined, text: line.slice(1) || " " };
    }
    if (kind === "+") {
      const n = next++;
      return { kind, number: n, oldNum: undefined, newNum: n, text: line.slice(1) || " " };
    }
    if (kind === " ") {
      const o = old++, n = next++;
      return { kind, number: n, oldNum: o, newNum: n, text: line.slice(1) || " " };
    }
    return { kind: "", text: line };
  });
}

/** Format clean, concise context snippets for 1-click Agent handoff (file, line, range, commit, conflicts, stash). */
export function formatAgentMention(kind, payload) {
  if (kind === "file") {
    return `@${String(payload || "").replace(/\\/g, "/")} `;
  }
  if (kind === "line" && payload?.path) {
    const p = String(payload.path).replace(/\\/g, "/");
    return payload.line != null ? `@${p}:L${payload.line} ` : `@${p} `;
  }
  if (kind === "range" && payload?.path) {
    const p = String(payload.path).replace(/\\/g, "/");
    const s = payload.start, e = payload.end;
    if (s != null && e != null && e > s) return `@${p}:L${s}-L${e} `;
    if (s != null) return `@${p}:L${s} `;
    return `@${p} `;
  }
  if (kind === "commit" && payload) {
    const subj = payload.subject ? ` ("${payload.subject}")` : "";
    return `commit ${payload.shortSha || payload.sha}${subj} `;
  }
  if (kind === "conflicts" && Array.isArray(payload) && payload.length) {
    return `Resolve git merge conflicts in ${payload.map((p) => `@${String(p).replace(/\\/g, "/")}`).join(" ")} `;
  }
  if (kind === "stash" && payload) {
    return `${payload.ref}${payload.message ? ` ("${payload.message}")` : ""} `;
  }
  return "";
}

/** Build a nested raw tree from changed files, compacting single-child folder chains. */
function makeTreeRoot(files) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    if (!parts.length) continue;
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const nextPath = cur.path ? `${cur.path}/${seg}` : seg;
      let child = cur.dirs.get(seg);
      if (!child) {
        child = { name: seg, path: nextPath, dirs: new Map(), files: [] };
        cur.dirs.set(seg, child);
      }
      cur = child;
    }
    cur.files.push({ name: parts[parts.length - 1], path: file.path, file });
  }

  const finalize = (node) => {
    const dirs = [...node.dirs.values()]
      .map((dir) => {
        const top = dir.path;
        let cur = dir, label = dir.name;
        while (cur.dirs.size === 1 && cur.files.length === 0) {
          const [only] = cur.dirs.values();
          label += ` / ${only.name}`;
          cur = only;
        }
        const built = finalize(cur);
        return { ...built, name: label, path: cur.path, top };
      })
      .sort((a, b) => compareNames(a.name, b.name));

    const sortedFiles = [...node.files].sort((a, b) => compareNames(a.name, b.name));
    const allFiles = [
      ...dirs.flatMap((d) => d.allFiles),
      ...sortedFiles.map((f) => f.file),
    ];
    let add = 0, del = 0;
    for (const f of allFiles) {
      add += f.add || 0;
      del += f.del || 0;
    }
    return {
      name: node.name,
      path: node.path,
      top: node.path,
      dirs,
      files: sortedFiles,
      allFiles,
      add,
      del,
    };
  };

  return finalize(root);
}

/**
 * Flatten changed files into visible tree rows (folders before files, single-child folder chains compacted).
 * Folders default to expanded; `collapsed` stores keys of the form `${group}:${folderPath}`.
 */
export function buildChangeTree(files, collapsed = new Set(), group = "all") {
  const root = makeTreeRoot(files);
  const rows = [];

  const walk = (node, depth) => {
    for (const dir of node.dirs) {
      const collapsedKey = `${group}:${dir.path}`;
      const open = !collapsed.has(collapsedKey);
      rows.push({
        kind: "dir",
        path: dir.path,
        top: dir.top,
        name: dir.name,
        depth,
        open,
        group,
        collapsedKey,
        files: dir.allFiles,
        count: dir.allFiles.length,
        add: dir.add,
        del: dir.del,
      });
      if (open) walk(dir, depth + 1);
    }
    for (const item of node.files) {
      rows.push({
        kind: "file",
        path: item.path,
        name: item.name,
        depth,
        group,
        file: item.file,
      });
    }
  };

  walk(root, 0);
  return rows;
}

/** Return files in visual tree order (folders first, natural name order), independent of collapse state. */
export function orderedTreeFiles(files) {
  return makeTreeRoot(files).allFiles;
}

/** Remove any collapsed ancestor keys for `filePath` so navigating to a file reveals it in tree view. */
export function expandAncestors(collapsed, filePath, groups = ["all", "staged", "unstaged", "branch", "commit"]) {
  if (!collapsed || !filePath) return;
  const parts = filePath.split("/");
  for (let i = 1; i < parts.length; i++) {
    const ancestor = parts.slice(0, i).join("/");
    for (const group of groups) collapsed.delete(`${group}:${ancestor}`);
  }
}
