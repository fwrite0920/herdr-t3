// Pure data helpers for t3-changes: view mode persistence, compacted directory tree, and batched git commands.

export const VIEW_MODE_KEY = "list.mode";

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
  try {
    localStorage.setItem(VIEW_MODE_KEY, value);
  } catch {}
  return value;
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
      const allStaged = dir.allFiles.length > 0 && dir.allFiles.every((f) => f.staged && !f.unstaged);
      const anyStaged = dir.allFiles.some((f) => f.staged);
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
        allStaged,
        anyStaged,
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
export function expandAncestors(collapsed, filePath, groups = ["all", "staged", "unstaged"]) {
  if (!collapsed || !filePath) return;
  const parts = filePath.split("/");
  for (let i = 1; i < parts.length; i++) {
    const ancestor = parts.slice(0, i).join("/");
    for (const group of groups) collapsed.delete(`${group}:${ancestor}`);
  }
}

function chunked(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Build batched git stage/unstage arg arrays for one or more files. */
export function buildStageCommands(files, { unstage, hasHead, chunkSize = 50 }) {
  const paths = [...new Set(files.map((f) => f.path).filter(Boolean))];
  if (!paths.length) return [];
  const prefix = unstage
    ? (hasHead ? ["reset", "HEAD", "--"] : ["rm", "--cached", "--"])
    : ["add", "--"];
  return chunked(paths, chunkSize).map((batch) => [...prefix, ...batch]);
}

/** Build batched git discard arg arrays for one or more files (matching single-file discard semantics). */
export function buildDiscardCommands(files, { hasHead, chunkSize = 50 }) {
  const fresh = [], added = [], tracked = [];
  const seen = new Set();
  for (const f of files) {
    if (!f?.path || seen.has(f.path)) continue;
    seen.add(f.path);
    if (f.fresh) fresh.push(f.path);
    else if (f.status === "A" || !hasHead) added.push(f.path);
    else tracked.push(f.path);
  }
  const cmds = [];
  if (added.length) {
    const unstagePrefix = hasHead ? ["reset", "HEAD", "--"] : ["rm", "--cached", "--"];
    for (const batch of chunked(added, chunkSize)) cmds.push([...unstagePrefix, ...batch]);
    for (const batch of chunked(added, chunkSize)) cmds.push(["clean", "-fd", "--", ...batch]);
  }
  if (fresh.length) {
    for (const batch of chunked(fresh, chunkSize)) cmds.push(["clean", "-fd", "--", ...batch]);
  }
  if (tracked.length) {
    for (const batch of chunked(tracked, chunkSize)) cmds.push(["checkout", "HEAD", "--", ...batch]);
  }
  return cmds;
}
