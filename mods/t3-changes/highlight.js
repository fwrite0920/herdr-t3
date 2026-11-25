// Lightweight, zero-dependency stateful syntax highlighter & intra-line word-diff annotator for t3-changes.
// Tracks multi-line block comments (/* */, <!-- -->) and multi-line strings (backticks, Python triple quotes)
// independently per diff side, producing semantic token kinds so theme switches recolor instantly.

const MAX_LINE_LEN = 500;
const MAX_SPANS = 80;

const JS_KW = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from", "function", "get",
  "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "of", "package",
  "private", "protected", "public", "readonly", "return", "set", "static", "super", "switch",
  "this", "throw", "try", "type", "typeof", "var", "void", "while", "with", "yield", "as",
]);

const PY_KW = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
  "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
  "match", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

const CLANG_KW = new Set([
  "abstract", "as", "async", "await", "auto", "bool", "break", "case", "catch", "char", "class",
  "const", "continue", "crate", "default", "defer", "do", "double", "dyn", "else", "enum", "extern",
  "fallthrough", "final", "float", "fn", "for", "func", "go", "goto", "if", "impl", "import", "in",
  "inline", "int", "interface", "let", "long", "loop", "map", "match", "mod", "move", "mut",
  "namespace", "new", "override", "package", "private", "protected", "pub", "public", "range",
  "ref", "return", "select", "self", "Self", "short", "signed", "sizeof", "static", "struct",
  "super", "switch", "template", "this", "throw", "trait", "try", "type", "typedef", "typename",
  "union", "unsafe", "unsigned", "use", "using", "val", "var", "virtual", "void", "volatile",
  "where", "while",
]);

const SH_KW = new Set([
  "case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in",
  "local", "readonly", "return", "select", "set", "shift", "then", "trap", "unset", "until",
  "while", "foreach", "param", "try", "catch", "finally", "switch", "break", "continue",
]);

const SQL_KW = new Set([
  "select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create",
  "table", "alter", "drop", "index", "join", "inner", "left", "right", "outer", "on", "as",
  "and", "or", "not", "null", "is", "in", "like", "order", "by", "group", "having", "limit",
  "offset", "distinct", "union", "all", "case", "when", "then", "else", "end", "exists", "primary",
  "key", "foreign", "references", "default", "constraint", "view", "with", "asc", "desc",
]);

const CONSTANTS = new Set([
  "true", "false", "null", "undefined", "NaN", "Infinity", "None", "True", "False", "nil", "Some", "Ok", "Err",
]);

const PRIMITIVES = new Set([
  "string", "number", "boolean", "symbol", "bigint", "any", "unknown", "never", "object",
  "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
  "f32", "f64", "str", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32",
  "uint64", "float32", "float64", "byte", "rune", "error", "size_t",
]);

/** Detect language family from a repository-relative path or filename. */
export function languageFromPath(filePath) {
  const name = String(filePath || "").split(/[\\/]/).pop().toLowerCase();
  if (!name) return "plain";
  if (name === "dockerfile" || name.startsWith("dockerfile.") || name === "makefile") return "sh";
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].includes(ext)) return "js";
  if (["json", "jsonc"].includes(ext)) return "json";
  if (["py", "pyi", "rb", "pl"].includes(ext)) return "py";
  if (["sh", "bash", "zsh", "fish", "ps1", "psm1", "psd1", "env", "conf", "ini", "toml", "cfg"].includes(ext)) return "sh";
  if (["yml", "yaml"].includes(ext)) return "yaml";
  if (["rs", "go", "c", "h", "cc", "cpp", "cxx", "hpp", "java", "kt", "kts", "swift", "cs", "dart", "zig", "php"].includes(ext)) return "clang";
  if (["html", "htm", "xml", "svg", "vue", "svelte"].includes(ext)) return "html";
  if (["css", "scss", "sass", "less"].includes(ext)) return "css";
  if (["md", "mdx", "markdown"].includes(ext)) return "md";
  if (ext === "sql") return "sql";
  return "plain";
}

function isLightHex(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(hex || ""));
  if (!m) return false;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 140;
}

/** Resolve theme tokens into a crisp, WCAG-friendly syntax palette for both dark and light themes. */
export function syntaxPalette(t) {
  const light = isLightHex(t?.background);
  return {
    plain: t?.foreground || "#d4d4d4",
    keyword: t?.ansi5 || t?.accent || "#a292a3",
    string: t?.ansi2 || "#8a9a7b",
    comment: t?.dim || "#848384",
    // Dark themes like omarchy deepen ansi4 for terminal blue backgrounds; prefer bright blue ansi12 on dark surfaces.
    function: (!light && t?.ansi12) ? t.ansi12 : (t?.ansi4 || t?.accent || "#9bb4c0"),
    type: t?.ansi3 || t?.blocked || "#c4b28a",
    number: t?.ansi1 || "#c4746e",
    constant: t?.ansi6 || t?.ansi14 || "#8ea4a2",
    tag: t?.ansi6 || t?.ansi4 || "#8ea4a2",
  };
}

function pushToken(out, text, kind) {
  if (!text) return;
  if (out.length >= MAX_SPANS) {
    const last = out[out.length - 1];
    if (last && last[1] === "plain") last[0] += text;
    else out.push([text, "plain"]);
    return;
  }
  const last = out[out.length - 1];
  if (last && last[1] === kind) last[0] += text;
  else out.push([text, kind]);
}

function readString(line, start, quote) {
  let i = start + 1;
  while (i < line.length) {
    if (line[i] === "\\" && i + 1 < line.length) { i += 2; continue; }
    if (line[i] === quote) return { end: i + 1, closed: true };
    i++;
  }
  return { end: line.length, closed: false };
}

function tokenizeMarkdown(line, state) {
  if (/^\s*```/.test(line)) {
    return { tokens: [[line, "type"]], state: state === "fence" ? null : "fence" };
  }
  if (state === "fence") return { tokens: [[line, "string"]], state: "fence" };
  if (/^\s*#{1,6}\s/.test(line)) return { tokens: [[line, "keyword"]], state: null };
  if (/^\s*>\s?/.test(line)) return { tokens: [[line, "comment"]], state: null };
  const out = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      if (end > i) {
        pushToken(out, line.slice(i, end + 1), "string");
        i = end + 1;
        continue;
      }
    }
    const bold = /^\*\*[^*]+\*\*/.exec(line.slice(i));
    if (bold) {
      pushToken(out, bold[0], "type");
      i += bold[0].length;
      continue;
    }
    const link = /^\[[^\]]+\]\([^)]+\)/.exec(line.slice(i));
    if (link) {
      pushToken(out, link[0], "function");
      i += link[0].length;
      continue;
    }
    pushToken(out, line[i], "plain");
    i++;
  }
  return { tokens: out, state: null };
}

function tokenizeMarkup(line, state) {
  const out = [];
  let i = 0;
  let nextState = state;
  if (nextState === "html-comment") {
    const end = line.indexOf("-->");
    if (end < 0) return { tokens: [[line, "comment"]], state: "html-comment" };
    pushToken(out, line.slice(0, end + 3), "comment");
    i = end + 3;
    nextState = null;
  }
  while (i < line.length) {
    if (line.startsWith("<!--", i)) {
      const end = line.indexOf("-->", i + 4);
      if (end < 0) {
        pushToken(out, line.slice(i), "comment");
        return { tokens: out, state: "html-comment" };
      }
      pushToken(out, line.slice(i, end + 3), "comment");
      i = end + 3;
      continue;
    }
    if (line[i] === "<") {
      const tagM = /^<\/?[A-Za-z_][\w:-]*/.exec(line.slice(i));
      if (tagM) {
        pushToken(out, tagM[0], "tag");
        i += tagM[0].length;
        continue;
      }
    }
    if (line[i] === '"' || line[i] === "'") {
      const { end } = readString(line, i, line[i]);
      pushToken(out, line.slice(i, end), "string");
      i = end;
      continue;
    }
    const attrM = /^([A-Za-z_:@-][\w:.-]*)(?==)/.exec(line.slice(i));
    if (attrM) {
      pushToken(out, attrM[1], "type");
      i += attrM[1].length;
      continue;
    }
    pushToken(out, line[i], "plain");
    i++;
  }
  return { tokens: out, state: nextState };
}

function tokenizeYaml(line) {
  const out = [];
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) return { tokens: [[line, "comment"]], state: null };
  const keyM = /^(\s*(?:-\s+)?)([A-Za-z0-9_.-]+)(\s*:)(.*)$/.exec(line);
  if (keyM) {
    if (keyM[1]) pushToken(out, keyM[1], "plain");
    pushToken(out, keyM[2], "type");
    pushToken(out, keyM[3], "plain");
    if (keyM[4]) {
      const sub = tokenizeCode(keyM[4], "sh", null);
      for (const tok of sub.tokens) pushToken(out, tok[0], tok[1]);
    }
    return { tokens: out, state: null };
  }
  return tokenizeCode(line, "sh", null);
}

function tokenizeCss(line, state) {
  const out = [];
  let i = 0;
  let nextState = state;
  if (nextState === "block-comment") {
    const end = line.indexOf("*/");
    if (end < 0) return { tokens: [[line, "comment"]], state: "block-comment" };
    pushToken(out, line.slice(0, end + 2), "comment");
    i = end + 2;
    nextState = null;
  }
  while (i < line.length) {
    if (line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        pushToken(out, line.slice(i), "comment");
        return { tokens: out, state: "block-comment" };
      }
      pushToken(out, line.slice(i, end + 2), "comment");
      i = end + 2;
      continue;
    }
    if (line[i] === '"' || line[i] === "'") {
      const { end } = readString(line, i, line[i]);
      pushToken(out, line.slice(i, end), "string");
      i = end;
      continue;
    }
    const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(line.slice(i));
    if (hex) {
      pushToken(out, hex[0], "constant");
      i += hex[0].length;
      continue;
    }
    const num = /^\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg)?\b/.exec(line.slice(i));
    if (num) {
      pushToken(out, num[0], "number");
      i += num[0].length;
      continue;
    }
    const prop = /^([a-z-]+)(?=\s*:)/.exec(line.slice(i));
    if (prop) {
      pushToken(out, prop[1], "type");
      i += prop[1].length;
      continue;
    }
    const atRule = /^@[a-z-]+/.exec(line.slice(i));
    if (atRule) {
      pushToken(out, atRule[0], "keyword");
      i += atRule[0].length;
      continue;
    }
    pushToken(out, line[i], "plain");
    i++;
  }
  return { tokens: out, state: nextState };
}

function tokenizeCode(line, lang, state) {
  const out = [];
  const isHashComment = lang === "py" || lang === "sh" || lang === "yaml";
  const isSlashComment = lang === "js" || lang === "clang" || lang === "json";
  const isSql = lang === "sql";
  const kwSet = lang === "js" ? JS_KW
    : lang === "py" ? PY_KW
    : lang === "clang" ? CLANG_KW
    : lang === "sh" || lang === "yaml" ? SH_KW
    : lang === "sql" ? SQL_KW
    : null;

  let i = 0;
  let nextState = state;

  // Continue open multi-line constructs from previous line
  if (nextState === "block-comment") {
    const end = line.indexOf("*/");
    if (end < 0) return { tokens: [[line, "comment"]], state: "block-comment" };
    pushToken(out, line.slice(0, end + 2), "comment");
    i = end + 2;
    nextState = null;
  } else if (nextState === "template") {
    const { end, closed } = readString(line, -1, "`");
    pushToken(out, line.slice(0, end), "string");
    if (!closed) return { tokens: out, state: "template" };
    i = end;
    nextState = null;
  } else if (nextState === "py-triple-dq" || nextState === "py-triple-sq") {
    const delim = nextState === "py-triple-dq" ? '"""' : "'''";
    const end = line.indexOf(delim);
    if (end < 0) return { tokens: [[line, "string"]], state: nextState };
    pushToken(out, line.slice(0, end + 3), "string");
    i = end + 3;
    nextState = null;
  }

  while (i < line.length) {
    const ch = line[i];

    // Comments
    if (isSlashComment && ch === "/" && line[i + 1] === "/") {
      pushToken(out, line.slice(i), "comment");
      break;
    }
    if ((isSlashComment || isSql) && ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        pushToken(out, line.slice(i), "comment");
        return { tokens: out, state: "block-comment" };
      }
      pushToken(out, line.slice(i, end + 2), "comment");
      i = end + 2;
      continue;
    }
    if (isHashComment && ch === "#") {
      pushToken(out, line.slice(i), "comment");
      break;
    }
    if (isSql && ch === "-" && line[i + 1] === "-") {
      pushToken(out, line.slice(i), "comment");
      break;
    }

    // Python triple-quoted multi-line strings
    if (lang === "py" && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
      const delim = line.slice(i, i + 3);
      const end = line.indexOf(delim, i + 3);
      if (end < 0) {
        pushToken(out, line.slice(i), "string");
        return { tokens: out, state: delim === '"""' ? "py-triple-dq" : "py-triple-sq" };
      }
      pushToken(out, line.slice(i, end + 3), "string");
      i = end + 3;
      continue;
    }

    // Strings (including JS template literals and JSON keys `"foo":`)
    if (ch === '"' || ch === "'" || (ch === "`" && (lang === "js" || lang === "sh"))) {
      const { end, closed } = readString(line, i, ch);
      const slice = line.slice(i, end);
      const isJsonKey = lang === "json" && ch === '"' && /^\s*:/.test(line.slice(end));
      pushToken(out, slice, isJsonKey ? "type" : "string");
      if (!closed && ch === "`" && lang === "js") return { tokens: out, state: "template" };
      i = end;
      continue;
    }

    // Shell / PowerShell variables ($FOO, ${BAR})
    if (lang === "sh" && ch === "$") {
      const vm = /^\$(?:\{[^}]+\}|[A-Za-z_]\w*|\d+|\?)/.exec(line.slice(i));
      if (vm) {
        pushToken(out, vm[0], "constant");
        i += vm[0].length;
        continue;
      }
    }

    // Decorators / annotations (@foo)
    if ((lang === "js" || lang === "py" || lang === "clang") && ch === "@") {
      const dm = /^@[A-Za-z_]\w*/.exec(line.slice(i));
      if (dm) {
        pushToken(out, dm[0], "type");
        i += dm[0].length;
        continue;
      }
    }

    // Numbers
    if (ch >= "0" && ch <= "9" && (i === 0 || !/[A-Za-z0-9_$]/.test(line[i - 1]))) {
      const nm = /^(?:0x[0-9a-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(line.slice(i));
      if (nm) {
        pushToken(out, nm[0], "number");
        i += nm[0].length;
        continue;
      }
    }

    // Identifiers, keywords, functions, types, constants
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      let kind = "plain";
      if (kwSet && (isSql ? kwSet.has(word.toLowerCase()) : kwSet.has(word))) kind = "keyword";
      else if (CONSTANTS.has(word)) kind = "constant";
      else if (PRIMITIVES.has(word)) kind = "type";
      else if (line[j] === "(") kind = "function";
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(word) && word.length > 1) kind = /^[A-Z0-9_]+$/.test(word) ? "constant" : "type";
      pushToken(out, word, kind);
      i = j;
      continue;
    }

    pushToken(out, ch, "plain");
    i++;
  }
  return { tokens: out, state: nextState };
}

/** Stateful tokenizer returning `{ tokens, state }` for multi-line constructs. */
export function tokenizeLineStateful(text, lang = "plain", state = null) {
  if (!text) return { tokens: [[" ", "plain"]], state };
  const expanded = text.replaceAll("\t", "    ");
  if (lang === "plain" || expanded.length > MAX_LINE_LEN) return { tokens: [[expanded, "plain"]], state: null };
  if (lang === "md") return tokenizeMarkdown(expanded, state);
  if (lang === "html") return tokenizeMarkup(expanded, state);
  if (lang === "yaml") return tokenizeYaml(expanded);
  if (lang === "css") return tokenizeCss(expanded, state);
  return tokenizeCode(expanded, lang, state);
}

/** Stateless convenience wrapper returning `[[text, kind], ...]` pairs. */
export function tokenizeLine(text, lang = "plain") {
  return tokenizeLineStateful(text, lang, null).tokens;
}

/**
 * Compute changed character range `[start, end)` between an old line and a new line
 * using longest common prefix/suffix. Returns `null` if lines are identical or wholly different.
 */
export function lineChangeRange(a, b) {
  if (!a || !b || a === b) return null;
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const common = start + (a.length - endA);
  if (common < 2) return null;
  return {
    oldRange: endA > start ? [start, endA] : null,
    newRange: endB > start ? [start, endB] : null,
  };
}

/**
 * Split `[text, kind]` tokens across an intra-line highlight range `[hiStart, hiEnd)`
 * and carry trailing spaces onto the next span (preventing monospace ligature misalignment).
 * Returns `Array<[text, kind, emph]>`.
 */
export function buildSpans(tokens, highlightRange = null) {
  const split = [];
  let pos = 0;
  const hasHi = Array.isArray(highlightRange) && highlightRange[1] > highlightRange[0];
  const [h0, h1] = hasHi ? highlightRange : [-1, -1];

  for (const [raw, kind] of tokens) {
    const text = raw.replaceAll("\t", "    ");
    const nextPos = pos + text.length;
    if (!hasHi || nextPos <= h0 || pos >= h1) {
      split.push([text, kind, false]);
    } else {
      const s0 = Math.max(0, h0 - pos);
      const s1 = Math.min(text.length, h1 - pos);
      if (s0 > 0) split.push([text.slice(0, s0), kind, false]);
      if (s1 > s0) split.push([text.slice(s0, s1), kind, true]);
      if (s1 < text.length) split.push([text.slice(s1), kind, false]);
    }
    pos = nextPos;
  }

  const out = [];
  let carry = "";
  for (const [text, kind, emph] of split) {
    if (emph) {
      if (carry) {
        const last = out[out.length - 1];
        if (last && !last[2]) last[0] += carry;
        else out.push([carry, "plain", false]);
        carry = "";
      }
      const last = out[out.length - 1];
      if (last && last[1] === kind && last[2] === true) last[0] += text;
      else out.push([text, kind, true]);
      continue;
    }
    const merged = carry + text;
    const body = merged.trimEnd();
    carry = merged.slice(body.length);
    if (!body) continue;
    const last = out[out.length - 1];
    if (last && last[1] === kind && last[2] === false) last[0] += body;
    else out.push([body, kind, false]);
  }
  if (carry && !out.length) out.push([carry, "plain", false]);
  return out;
}

/**
 * Enrich `diffRows` output with stateful syntax tokens (`spans`) and paired `-`/`+` intra-line highlights.
 * Tracks old-side and new-side multi-line comment/string state separately and resets on file/hunk boundaries.
 */
export function colorizeDiffRows(rows, filePath = "") {
  let lang = languageFromPath(filePath);
  const ranges = new Array(rows.length).fill(null);

  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== "-") { i++; continue; }
    let delEnd = i;
    while (delEnd < rows.length && rows[delEnd].kind === "-") delEnd++;
    let addEnd = delEnd;
    while (addEnd < rows.length && rows[addEnd].kind === "+") addEnd++;
    const delCount = delEnd - i, addCount = addEnd - delEnd;
    if (delCount > 0 && delCount === addCount && delCount <= 12) {
      for (let k = 0; k < delCount; k++) {
        const a = (rows[i + k].text || "").replaceAll("\t", "    ");
        const b = (rows[delEnd + k].text || "").replaceAll("\t", "    ");
        const r = lineChangeRange(a, b);
        if (r) {
          ranges[i + k] = r.oldRange;
          ranges[delEnd + k] = r.newRange;
        }
      }
    }
    i = addEnd;
  }

  let oldState = null, newState = null;
  return rows.map((row, idx) => {
    if (row.kind === "file") {
      const m = /^diff --git a\/.+ b\/(.+)$/.exec(row.text || "");
      if (m) lang = languageFromPath(m[1]);
      oldState = null;
      newState = null;
      return row;
    }
    if (row.kind === "@") {
      oldState = null;
      newState = null;
      return row;
    }
    if (row.kind === "-") {
      const res = tokenizeLineStateful(row.text || "", lang, oldState);
      oldState = res.state;
      return { ...row, spans: buildSpans(res.tokens, ranges[idx]) };
    }
    if (row.kind === "+") {
      const res = tokenizeLineStateful(row.text || "", lang, newState);
      newState = res.state;
      return { ...row, spans: buildSpans(res.tokens, ranges[idx]) };
    }
    if (row.kind === " ") {
      const res = tokenizeLineStateful(row.text || "", lang, newState ?? oldState);
      oldState = res.state;
      newState = res.state;
      return { ...row, spans: buildSpans(res.tokens, ranges[idx]) };
    }
    return row;
  });
}

/** Return true for East Asian Wide / Fullwidth / Emoji code points that occupy ~2 monospace columns. */
export function isWideCodePoint(cp) {
  if (cp < 0x1100) return false;
  return (
    (cp >= 0x1100 && cp <= 0x115f)
    || cp === 0x2329 || cp === 0x232a
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3040 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe19)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff01 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || cp >= 0x1f300
  );
}

function charDisplayCols(cp, wideCols) {
  if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  return isWideCodePoint(cp) ? wideCols : 1;
}

/**
 * Wrap syntax-highlighted spans (`Array<[text, kind, emph]>`) into visual lines of at most `maxCols` columns,
 * preserving syntax token kinds and intra-line word-diff emphasis across line breaks (CJK-aware).
 */
export function wrapSpans(spans, maxCols, wideCols = 2) {
  const limit = Math.max(8, Number(maxCols) || 8);
  const wide = Number.isFinite(wideCols) && wideCols > 0 ? wideCols : 2;
  if (!Array.isArray(spans) || !spans.length) return [[[" ", "plain", false]]];

  // Fast path: check if entire line already fits in a single visual row
  let total = 0;
  for (let s = 0; s < spans.length; s++) {
    const seg = spans[s][0];
    for (let i = 0; i < seg.length;) {
      const c = seg.charCodeAt(i);
      const cp = c < 0xd800 ? c : seg.codePointAt(i);
      total += charDisplayCols(cp, wide);
      i += cp > 0xffff ? 2 : 1;
    }
    if (total > limit) break;
  }
  if (total <= limit) return [spans];

  const lines = [[]];
  let col = 0;
  for (let s = 0; s < spans.length; s++) {
    const [seg, kind, emph] = spans[s];
    if (!seg) continue;
    let start = 0;
    for (let i = 0; i < seg.length;) {
      const c = seg.charCodeAt(i);
      const cp = c < 0xd800 ? c : seg.codePointAt(i);
      const w = charDisplayCols(cp, wide);
      if (col > 0 && col + w > limit) {
        if (i > start) lines[lines.length - 1].push([seg.slice(start, i), kind, Boolean(emph)]);
        lines.push([]);
        start = i;
        col = 0;
      }
      col += w;
      i += cp > 0xffff ? 2 : 1;
    }
    if (seg.length > start) lines[lines.length - 1].push([seg.slice(start), kind, Boolean(emph)]);
  }
  if (!lines[lines.length - 1].length && lines.length > 1) lines.pop();
  return lines;
}

/** Memoized row wrapper for `v_virtual_list` wrapped diff rendering. */
export function wrapRowLines(row, maxCols, wideCols = 2) {
  const key = `${maxCols}:${Math.round(wideCols * 100)}`;
  if (row._wrapKey === key && row._wrappedLines) return row._wrappedLines;
  const baseSpans = row.spans && row.spans.length
    ? row.spans
    : [[(row.text || " ").replaceAll("\t", "    "), "plain", false]];
  const wrapped = wrapSpans(baseSpans, maxCols, wideCols);
  row._wrapKey = key;
  row._wrappedLines = wrapped;
  return wrapped;
}
