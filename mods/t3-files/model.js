// What the Files page knows, apart from drawing it: git's answers parsed, the search filter, sort order and file kinds.
// check-files.cjs loads this alone.
import { sortEntries } from "./file-tree.js";

export const RANKED = 1000; // a search ranks at most this many matches; past it, the first ones as found

/** Where a space is now: its active tab's pane cwd, else its folder. */
export function placeOf(s, ps) {
  const tabs = new Set((s?.tabs ?? []).map((c) => c.id));
  return ps?.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s?.folder || "";
}

const normPath = (p) => {
  if (!p) return "";
  const s = String(p).replace(/\\/g, "/");
  if (/^[a-zA-Z]:\/+$/.test(s)) return s.slice(0, 2) + "/";
  if (/^[a-zA-Z]:$/.test(s)) return s + "/";
  if (/^\/+$/.test(s)) return "/";
  return s.replace(/\/+$/, "");
};

const isWinPath = (p) => /^[a-zA-Z]:\//.test(p) || p.startsWith("//");

const isSamePath = (a, b) => {
  if (!a || !b) return false;
  return isWinPath(a) || isWinPath(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
};

const isWithin = (child, parent) => {
  if (!child || !parent) return false;
  if (isSamePath(child, parent)) return true;
  const prefix = parent.endsWith("/") ? parent : `${parent}/`;
  return isWinPath(parent) || isWinPath(child)
    ? child.toLowerCase().startsWith(prefix.toLowerCase())
    : child.startsWith(prefix);
};

/**
 * Pick the Files panel's root for space `sp`:
 * - Keep `sp.folder` when it is a specific project folder (not the user's home dir) and the pane is still inside it,
 *   so transient `cd` into subdirectories does not wipe the open file or tree.
 * - Otherwise (empty `sp.folder`, `sp.folder` is home, or the pane moved outside `sp.folder`, e.g. another drive/repo),
 *   follow the focused/active pane's live `cwd`.
 */
export function resolveRoot(sp, ps, focus = null, homeDir = "") {
  const tabs = new Set((sp?.tabs ?? []).map((c) => c.id));
  const focusPane = focus?.pane && tabs.has(focus.tab) ? ps?.find((p) => p.pane === focus.pane && p.cwd) : null;
  const activeTab = (sp?.tabs ?? []).find((t) => t.active)?.id;
  const activeTabPane = activeTab ? ps?.find((p) => p.tab === activeTab && p.cwd) : null;
  const paneCwd = normPath(
    focusPane?.cwd ||
    (focus?.space === sp?.id && focus?.cwd) ||
    activeTabPane?.cwd ||
    ps?.find((p) => tabs.has(p.tab) && p.cwd)?.cwd ||
    ""
  );
  const spaceFolder = normPath(sp?.folder || "");
  const userHome = normPath(homeDir || "");

  if (!spaceFolder) return paneCwd;
  if (!paneCwd) return spaceFolder;
  if (userHome && !sp?.machine && isSamePath(spaceFolder, userHome)) return paneCwd;
  if (isWithin(paneCwd, spaceFolder)) return spaceFolder;
  return paneCwd;
}

/** `a/b`: either may be "" (the space's folder, or a path from it). */
export const join = (a, b) => !a ? b : !b ? a : `${a.replace(/[/\\]+$/, "")}/${b.replace(/^[/\\]+/, "")}`;
export const parentOf = (p) => {
  const at = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return at >= 0 ? p.slice(0, at) : "";
};
export const nameOf = (p) => {
  const at = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return at >= 0 ? p.slice(at + 1) : p;
};
/** The folders above a path, from the top: `a/b/c` → `a`, `a/b`. */
export const ancestors = (p) => { const out = []; for (let at = p.indexOf("/"); at > 0; at = p.indexOf("/", at + 1)) out.push(p.slice(0, at)); return out; };

// A folder's entries, NUL-separated kind and name, `.git` left out (as Herdr's files mod lists them).
export const LIST = 'for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; n=${p##*/}; [ "$n" = .git ] && continue; if [ -d "$p" ]; then k=d; else k=f; fi; printf "%s\\0%s\\0" "$k" "$n"; done; test -d "$1"';
// The same entries as paths from the space's folder ($2 is the folder's, "" or "src/"), a folder's with a slash, put to Git.
export const IGNORED = 'for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; n=${p##*/}; [ "$n" = .git ] && continue; if [ -d "$p" ]; then printf "%s%s/\\0" "$2" "$n"; else printf "%s%s\\0" "$2" "$n"; fi; done | git check-ignore --stdin -z; :';
// Before reading a file on another machine: its size, and NULs in its first 8 KB. readTextFile there turns a binary into
// text with U+FFFD and takes up to half a minute to refuse one past 1 MiB.
export const PROBE = 's=$(wc -c < "$1") || exit 1; h=$(head -c 8192 "$1" | wc -c); z=$(head -c 8192 "$1" | tr -d "\\000" | wc -c); echo $s $((h - z))';
// Search on another machine runs there: the whole list would take seconds to come over. Every term in the path, case
// aside, 1000 at most. The query goes as an argument, never into the script.
export const REMOTE_SEARCH = `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -co --exclude-standard -z | tr '\\0' '\\n'; else find . -name .git -prune -o -type f -print | sed 's|^\\./||'; fi | awk 'BEGIN { n = split(tolower(ARGV[1]), t, " "); ARGV[1] = "" } { p = tolower($0); for (i = 1; i <= n; i++) if (!index(p, t[i])) next; print; if (++c >= ${RANKED}) exit }' "$1"`;

// The listing script's output: a kind (d or f) and a name, each ended by NUL; in file-tree.js's order.
export function parseListing(stdout) {
  const fields = stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return sortEntries(out);
}

// `git status --porcelain=v2 -z`, run at the repo's top, for a space whose folder is `prefix` inside it ("" or "sub/dir/").
// Paths come back relative to the space's folder; changes outside it are left out. A letter per file (A, M, D or R:
// untracked counts as added, a conflict as modified) and every folder holding one.
export function parseStatus(stdout, prefix = "") {
  const marks = new Map(), dirs = new Set(), records = stdout.split("\0");
  // The path follows a fixed number of space-separated fields; it may hold spaces itself.
  const after = (rec, n) => { let at = -1; for (let i = 0; i < n; i++) at = rec.indexOf(" ", at + 1); return at < 0 ? null : rec.slice(at + 1); };
  for (let i = 0; i < records.length; i++) {
    const rec = records[i], xy = rec.slice(2, 4);
    let path = null, letter = "M";
    if (rec[0] === "1") {
      path = after(rec, 8);
      letter = xy.includes("D") ? "D" : xy[0] === "A" ? "A" : "M";
    } else if (rec[0] === "2") { path = after(rec, 9); letter = "R"; i++; } // the next record is where it came from
    else if (rec[0] === "u") path = after(rec, 10);
    else if (rec[0] === "?") { path = rec.slice(2); letter = "A"; }
    if (!path || !path.startsWith(prefix)) continue;
    path = path.slice(prefix.length);
    marks.set(path, letter);
    for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) dirs.add(path.slice(0, at));
  }
  return { marks, dirs };
}

// `git check-ignore --stdin -z`'s answer: the paths it was given that Git ignores. A folder was asked with a trailing slash.
export function parseIgnored(stdout) {
  return new Set(stdout.split("\0").filter(Boolean).map((p) => p.replace(/\/$/, "")));
}

// A folder's entries, listed again: those Git ignores now (`found`) marked, the others not. Under an ignored folder, nothing
// is asked: everything there is.
export function markIgnored(ignored, rel, entries, found) {
  for (const e of entries) { const p = join(rel, e.name); if (found.has(p)) ignored.add(p); else ignored.delete(p); }
}

/**
 * A folder's entries as file-tree.js's treeRows takes them: a deleted file where it was (after the files there), and
 * everything under an ignored folder ignored too.
 */
export const folderEntries = ({ entries, ignored, marks }) => (rel) => {
  const list = entries.get(rel) ?? [], names = new Set(list.map((e) => e.name));
  const gone = [...marks].filter(([p, l]) => l === "D" && parentOf(p) === rel && !names.has(nameOf(p))).map(([p]) => ({ name: nameOf(p), dir: false, gone: true }));
  const dim = Boolean(rel) && [...ancestors(rel), rel].some((p) => ignored.has(p));
  return [...list, ...gone].map((e) => ({ name: e.name, dir: e.dir, gone: Boolean(e.gone), ignored: dim || ignored.has(join(rel, e.name)) }));
};

// A search's terms: every one must be in the path, case aside.
export const terms = (query) => query.toLowerCase().split(/\s+/).filter(Boolean);
// The candidates a query can start from: the last query's matches while this one only adds to it, else everything.
export const narrows = (query, last) => Boolean(last) && query.startsWith(last);

/**
 * The indexes into `lower` (lowercased paths) whose path holds every term, from `from` (indexes, or null for all).
 * Every CHUNK candidates it awaits `pause()`: past about 100k paths in one go, Herdr interrupts the script.
 * `alive()` false stops it early (a newer query); it then returns null.
 */
export const CHUNK = 5000;
export async function filterPaths(lower, words, from, pause, alive = () => true) {
  const out = [], n = from ? from.length : lower.length;
  for (let start = 0; start < n; start += CHUNK) {
    for (let k = start; k < Math.min(n, start + CHUNK); k++) {
      const i = from ? from[k] : k, p = lower[i];
      if (words.every((w) => p.includes(w))) out.push(i);
    }
    if (start + CHUNK < n) { await pause(); if (!alive()) return null; }
  }
  return out;
}

/**
 * At most `limit` of `paths` (all matching `query`), best first, each with the [start, end) ranges uFuzzy matched, for
 * highlighting. uFuzzy wants its terms in order: paths it doesn't match keep their place after the ones it ranks.
 * Only for a few hundred paths: ranking ten thousand takes a frame and more.
 */
export function rank(uf, paths, query, limit) {
  const idxs = uf.filter(paths, query) ?? [], seen = new Set();
  const out = [];
  if (idxs.length) {
    const info = uf.info(idxs, paths, query), order = uf.sort(info, paths, query);
    for (const o of order) {
      if (out.length >= limit) break;
      const r = info.ranges[o], ranges = [];
      for (let k = 0; k < r.length; k += 2) ranges.push([r[k], r[k + 1]]);
      seen.add(info.idx[o]);
      out.push({ path: paths[info.idx[o]], ranges });
    }
  }
  for (let i = 0; i < paths.length && out.length < limit; i++) if (!seen.has(i)) out.push({ path: paths[i], ranges: [] });
  return out;
}

// What a file is shown as.
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
export const extOf = (name) => name.includes(".") ? name.split(".").pop().toLowerCase() : "";
export const kindOf = (name) => IMAGES.has(extOf(name)) ? "image" : /^(md|markdown|mdx)$/.test(extOf(name)) ? "markdown" : "text";
export const isSvg = (name) => extOf(name) === "svg";
export const isJson = (name) => extOf(name) === "json";
export const isHtml = (name) => /^(html|htm)$/.test(extOf(name));

export function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Parse natural pixel dimensions from common raster image headers (PNG, GIF, BMP, ICO, WebP, JPEG).
export function imageDimensions(bytes) {
  if (!bytes || bytes.length < 10) return null;
  const u16BE = (i) => (bytes[i] << 8) | bytes[i + 1];
  const u16LE = (i) => bytes[i] | (bytes[i + 1] << 8);
  const u32BE = (i) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  const u32LE = (i) => (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
  const i32LE = (i) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
  const tag = (i, s) => s.length + i <= bytes.length && [...s].every((ch, k) => bytes[i + k] === ch.charCodeAt(0));

  // PNG: signature + IHDR width/height at offsets 16..24
  if (bytes.length >= 24 && bytes[0] === 0x89 && tag(1, "PNG\r\n\x1a\n")) {
    const width = u32BE(16), height = u32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // GIF87a / GIF89a
  if (bytes.length >= 10 && (tag(0, "GIF87a") || tag(0, "GIF89a"))) {
    const width = u16LE(6), height = u16LE(8);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // BMP
  if (bytes.length >= 26 && tag(0, "BM")) {
    const width = i32LE(18), height = Math.abs(i32LE(22));
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // ICO: pick the largest embedded icon entry (0 encodes 256)
  if (bytes.length >= 22 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    const count = u16LE(4);
    let best = null;
    for (let k = 0; k < count && 6 + (k + 1) * 16 <= bytes.length; k++) {
      const off = 6 + k * 16;
      const width = bytes[off] || 256, height = bytes[off + 1] || 256;
      if (!best || width * height > best.width * best.height) best = { width, height };
    }
    return best;
  }
  // WebP: RIFF....WEBP (VP8, VP8L, VP8X)
  if (bytes.length >= 30 && tag(0, "RIFF") && tag(8, "WEBP")) {
    if (tag(12, "VP8 ") && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      const width = u16LE(26) & 0x3fff, height = u16LE(28) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (tag(12, "VP8L") && bytes[20] === 0x2f) {
      const bits = u32LE(21);
      const width = (bits & 0x3fff) + 1, height = ((bits >> 14) & 0x3fff) + 1;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (tag(12, "VP8X")) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return width > 0 && height > 0 ? { width, height } : null;
    }
  }
  // JPEG: walk markers until a SOF frame header
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 3 < bytes.length) {
      while (i < bytes.length && bytes[i] !== 0xff) i++;
      while (i < bytes.length && bytes[i] === 0xff) i++;
      if (i >= bytes.length) break;
      const marker = bytes[i++];
      if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (i + 1 >= bytes.length) break;
      const len = u16BE(i);
      if (len < 2) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        if (i + 7 <= bytes.length) {
          const height = u16BE(i + 3), width = u16BE(i + 5);
          if (width > 0 && height > 0) return { width, height };
        }
        break;
      }
      if (i + len > bytes.length) break;
      i += len;
    }
  }
  return null;
}

// Parse intrinsic dimensions from an SVG root tag's width/height or viewBox.
export function svgDimensions(text) {
  if (!text) return null;
  const m = /<svg\b([^>]*)>/i.exec(text);
  if (!m) return null;
  const attrs = m[1];
  const num = (re) => {
    const hit = re.exec(attrs);
    if (!hit || hit[1].includes("%")) return NaN;
    const v = parseFloat(hit[1]);
    return Number.isFinite(v) && v > 0 ? v : NaN;
  };
  let w = num(/\bwidth\s*=\s*["']([^"']+)["']/i), h = num(/\bheight\s*=\s*["']([^"']+)["']/i);
  if (!(w > 0 && h > 0)) {
    const vb = /\bviewBox\s*=\s*["']\s*[-+]?[\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(attrs);
    if (vb) { w = parseFloat(vb[1]); h = parseFloat(vb[2]); }
  }
  return w > 0 && h > 0 ? { width: Math.round(w), height: Math.round(h) } : null;
}

export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

// Tall screenshots (e.g. mobile/full-page captures) default to Fit Width so they stay legible and scrollable.
export function defaultImageMode(dims, box) {
  if (!dims || !box?.width || !box?.height) return "fit";
  if (dims.height / dims.width >= 2.2 && dims.height > box.height) return "width";
  return "fit";
}

export function computeImageLayout(dims, box, mode = "fit", customScale = 1) {
  if (!dims?.width || !dims?.height) return null;
  const availW = Math.max(80, (box?.width ?? 480) - 32);
  const availH = Math.max(80, (box?.height ?? 360) - 32);
  let scale = 1;
  if (mode === "fit") scale = Math.min(1, availW / dims.width, availH / dims.height);
  else if (mode === "width") scale = Math.min(1, availW / dims.width);
  else if (mode === "actual") scale = 1;
  else scale = Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], customScale || 1));
  return { width: Math.max(1, Math.round(dims.width * scale)), height: Math.max(1, Math.round(dims.height * scale)), scale };
}

export function stepImageZoom(currentScale, dir) {
  const s = currentScale || 1;
  if (dir > 0) return ZOOM_STEPS.find((z) => z > s + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < s - 0.01) return ZOOM_STEPS[i];
  return ZOOM_STEPS[0];
}

// Pretty-print valid JSON when formatting differs from the raw text; mark compact single-line JSON as minified.
export function formatJsonPreview(text) {
  if (!text || text.length > 512 * 1024) return null;
  try {
    const parsed = JSON.parse(text);
    const pretty = JSON.stringify(parsed, null, 2) + (text.endsWith("\n") ? "\n" : "");
    if (pretty === text) return null;
    const lines = text.split("\n").length - Number(text.endsWith("\n"));
    return { pretty, minified: lines <= 3 && text.trim().length > 180 };
  } catch { return null; }
}

// Resolve a relative Markdown/HTML link against the current file's path; returns null for external URLs or paths above root.
export function resolveRelPath(fromFile, href) {
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return null;
  const clean = href.split(/[?#]/)[0];
  if (!clean) return null;
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch {}
  const base = decoded.startsWith("/") ? [] : parentOf(fromFile || "").split("/").filter(Boolean);
  for (const part of decoded.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!base.length) return null;
      base.pop();
    } else base.push(part);
  }
  return base.length ? base.join("/") : null;
}

const BINARY_LABELS = {
  pdf: "PDF document",
  zip: "Archive", tar: "Archive", gz: "Archive", tgz: "Archive", bz2: "Archive", xz: "Archive", "7z": "Archive", rar: "Archive",
  mp4: "Video file", mov: "Video file", webm: "Video file", mkv: "Video file", avi: "Video file",
  mp3: "Audio file", wav: "Audio file", ogg: "Audio file", flac: "Audio file", m4a: "Audio file", aac: "Audio file",
  ttf: "Font file", otf: "Font file", woff: "Font file", woff2: "Font file",
  exe: "Executable binary", dll: "Shared library", so: "Shared library", dylib: "Shared library", wasm: "WebAssembly binary",
  doc: "Office document", docx: "Office document", xls: "Spreadsheet", xlsx: "Spreadsheet", ppt: "Presentation", pptx: "Presentation",
  db: "Database file", sqlite: "SQLite database", sqlite3: "SQLite database",
};
export const describeFileKind = (name) => BINARY_LABELS[extOf(name)] ?? "Binary file";

// The Editor's languages that color something (docs/research/files-panel-verify-local.md); the rest stay plain.
const LANGUAGES = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", mts: "js", cts: "js", tsx: "js", json: "json", jsonc: "json", json5: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  rs: "rust", go: "go", py: "python", sh: "sh", bash: "bash", zsh: "zsh", css: "css", scss: "css", less: "css", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp",
  hpp: "cpp", java: "java", kt: "kotlin", kts: "kotlin", rb: "ruby", php: "php", sql: "sql", lua: "lua", graphql: "graphql", gql: "graphql",
};
export const languageOf = (name) => /^(gnu)?makefile$/i.test(name) ? "makefile" : LANGUAGES[extOf(name)];

// readTextFile's errors, in a sentence each. Gone (null) is the caller's.
export function readProblem(error) {
  const e = String(error);
  if (e.includes("exceeds 1 MiB")) return "This file is larger than 1 MB, too large to preview.";
  if (e.includes("UTF-8")) return "This is a binary file, so there's no text to show.";
  return "This file can't be read.";
}

// Can't be read is a failure, the error bar's, to retry; too large, binary, gone or not UTF-8 is what the file is.
export const failedRead = (problem) => /can't be read/.test(problem);

// A request's answer is used only if no newer one of its kind was made for the same space since (a file picked after it,
// another refresh): a started exec runs to its end however things moved meanwhile.
export function ticket(st, kind) {
  st.tickets ??= {};
  const n = st.tickets[kind] = (st.tickets[kind] ?? 0) + 1;
  return () => st.tickets[kind] === n;
}
