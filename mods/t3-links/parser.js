// Pure path & line/column parsing for terminal file link clicks (local and SSH, Windows and POSIX).
// check-links.cjs loads this alone.

export const BINARY = /\.(pdf|psd|sketch|fig|zip|gz|tgz|bz2|xz|zst|7z|rar|dmg|pkg|iso|exe|dll|so|dylib|a|o|class|jar|wasm|pyc|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|mkv|webm|wav|flac|ogg|doc|docx|xls|xlsx|ppt|pptx|sqlite3?|db)$/i;

const ANCHOR = /#L(\d+)(?:-L?\d+)?$/;
const RANGE = /:(\d+)-L?\d+$/;
const PLACE = /(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\)):?$/;
const CHECK_POSITIVE = (n) => (Number(n) > 0 ? Number(n) : null);

export function normPath(p) {
  if (!p) return "";
  const s = String(p).replace(/\\/g, "/");
  if (/^[a-zA-Z]:\/+$/.test(s)) return s.slice(0, 2) + "/";
  if (/^[a-zA-Z]:$/.test(s)) return s + "/";
  if (/^\/+$/.test(s)) return "/";
  return s.replace(/\/+$/, "");
}

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

// Parse trailing line/column/range/anchor suffixes from clicked terminal text.
// Supports: src/app.ts:42, src/app.ts:42:7, src/app.ts(42,7), src/app.ts:5-12, src/app.ts#L42, src/app.ts#L5-L12.
export function parseLinkPlace(raw) {
  let text = String(raw ?? "");
  if (text.endsWith(".")) text = text.slice(0, -1);
  const lines = ANCHOR.exec(text) ?? RANGE.exec(text);
  if (lines) return { line: CHECK_POSITIVE(lines[1]), col: null, rest: text.slice(0, lines.index) };
  const m = PLACE.exec(text);
  if (!m) return { line: null, col: null, rest: text };
  return { line: CHECK_POSITIVE(m[1] ?? m[3]), col: CHECK_POSITIVE(m[2] ?? m[4]), rest: text.slice(0, m.index) };
}

// Resolve a file path from Herdr's link payload and terminal source.
export function resolveLinkPath(link, source, rest) {
  if (link?.path) return normPath(link.path);
  let p = String(rest ?? "").trim();
  if (!p) return null;
  if (/^file:\/\//i.test(p)) {
    try {
      let decoded = decodeURIComponent(p.replace(/^file:\/\/(?:localhost)?/i, "").split(/[?#]/)[0]);
      if (/^\/[a-zA-Z]:\//.test(decoded)) decoded = decoded.slice(1);
      p = decoded;
    } catch { return null; }
  }
  p = p.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) return normPath(p);
  if (p.startsWith("~")) return null;
  if (!source?.cwd) return null;
  const base = normPath(source.cwd);
  const rel = p.replace(/^\.\//, "");
  return normPath(base.endsWith("/") ? `${base}${rel}` : `${base}/${rel}`);
}

// Mirror t3-files's resolveRoot so clicked files map cleanly into the active space's Files root.
export function resolveSpaceRoot(sp, ps, source = null, homeDir = "") {
  const tabs = new Set((sp?.tabs ?? []).map((c) => c.id));
  const sourcePane = source?.pane ? ps?.find((p) => p.pane === source.pane && p.cwd) : null;
  const activeTab = (sp?.tabs ?? []).find((t) => t.active)?.id;
  const activeTabPane = activeTab ? ps?.find((p) => p.tab === activeTab && p.cwd) : null;
  const paneCwd = normPath(
    source?.cwd ||
    sourcePane?.cwd ||
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

// Return a POSIX-style relative path if `filePath` is strictly inside `rootPath`, else null.
export function relativeToRoot(filePath, rootPath) {
  const file = normPath(filePath);
  const root = normPath(rootPath);
  if (!file || !root || isSamePath(file, root) || !isWithin(file, root)) return null;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const rel = file.slice(prefix.length).replace(/^\/+/, "");
  return rel || null;
}
