// The space panel's Files page (docs/adr/0011, docs/research/space-panel-plan.md): the active space's folder, read-only, as
// one block: the file picked on the left, the tree on the right by the window's edge, the split between them dragged.
// One copy serves every space, here or on another machine: what each one shows is kept by its id.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Editor, EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, nextCommand, exec, readTextFile, theme, settings, shared, setShared, home, appHome, window, watchFolder, notify } from "herdr";
import { Buffer } from "buffer";
import * as fs from "fs/promises";
import uFuzzy from "./vendor/ufuzzy.js";
import { panelState, hidePanel } from "./panel.js";
import { step, scrollList } from "./list.js";
import { fileIcon } from "./file-icons.js";
import { TREE_ROW, treeRows, rowAt, treeKey, treeList, treeRow, revealRow, sortEntries } from "./file-tree.js";
import { withTopNav, navToggle, foldAllButton, ghostButton, navOpen, setNavOpen, holdWidth } from "./nav-column.js";
import { fileMenuItems, fileMenuView, agentFor, runCommon, mention } from "./file-menu.js";
import { button as drawButton } from "./button.js";
import { KEY, migratePagePrefs, wrapLines, setWrapLines } from "./store.js";
import { loadingState, emptyState, errorBar } from "./panel-states.js";
import { LIST, IGNORED, PROBE, REMOTE_SEARCH, RANKED, join, parentOf, nameOf, ancestors, parseListing, parseStatus, parseIgnored, markIgnored, folderEntries, terms, narrows,
  filterPaths, rank, extOf, kindOf, isSvg, isJson, isHtml, formatBytes, imageDimensions, svgDimensions, defaultImageMode, computeImageLayout, stepImageZoom, formatJsonPreview,
  resolveRelPath, describeFileKind, languageOf, readProblem, failedRead, ticket, resolveRoot, parseQueryLocation, lineRange, parseRgJson } from "./model.js";

const MOD = "mods/t3-files";
const RESULTS = 200, REMOTE_IMAGE = 4 * 1024 * 1024, TEXT_MAX = 1024 * 1024, HEAD_PREVIEW = 256 * 1024;
// Expand all lists at most this many folders, Git-ignored ones left closed, as T3's.
// shortcut: a folder past it stays closed; list more in batches if a big repo wants it all.
const EXPAND_MAX = 200;
// Asked again while it shows: here every 5 s, another machine every 10; a refresh that took long, 10 times as long, a minute at
// most. Nothing is watched: Herdr's folder watch can't be stopped once asked, and a hidden page runs nothing.
const LOCAL_EVERY = 5000, REMOTE_EVERY = 10000, SLOWEST = 60000;
// Herdr runs each exec as a process with two pipes: listing every folder Expand all opened at once can exhaust open files.
// Listing reads go READ_AT_ONCE at a time across every space this copy reads.
const READ_AT_ONCE = 8;
let reading = 0;
const waiting = [];
const limited = async (read) => {
  while (reading >= READ_AT_ONCE) await new Promise((go) => waiting.push(go));
  reading++;
  try { return await read(); } finally { reading--; waiting.shift()?.(); }
};
const FULL = 3; // the spaces last shown that keep all they read; older ones keep their file, open folders and search
const CACHE = "cache/t3-files"; // under the app's home, where image() can read
const MARKDOWN = "t3-files.markdown"; // "code" once someone picked it; Preview otherwise

const GIT = ["--no-optional-locks", "-c", "core.fsmonitor=false"]; // keep reads from updating the index or filesystem-monitor state

const count = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const lineCount = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);
const zoom = () => Number(settings()?.zoom) || 1;
const RECENT_MAX = 6;
const psQuote = (s) => String(s).replace(/['‘’‚‛]/g, "$&$&");
const decodeBase64 = (b64) => {
  if (typeof Buffer === "function") return Buffer.from(b64, "base64");
  const bin = /** @type {any} */ (globalThis).atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};
const utf8Bytes = (text) => (typeof Buffer === "function" ? Buffer.from(text, "utf8").length : text.length);
const trimHeadPreview = (text) => {
  const cut = text.lastIndexOf("\n");
  return cut > 0 ? text.slice(0, cut + 1) : text;
};

// What one space's page knows and shows.
function blank(sp, root = sp.folder ?? "") {
  return { id: sp.id, root, on: sp.machine ?? null, git: undefined, entries: new Map(), expanded: new Set(), ignored: new Set(),
    marks: new Map(), dirs: new Set(), version: 0, file: null, recent: [], view: null, lit: null, focus: null, query: "", at: -1,
    results: null, total: 0, paths: null, searchMode: "files", matchCase: false, useRegex: false,
    textResults: null, textLoading: false, textError: null, textTruncated: false, jumpLine: null };
}

export default class Files extends View {
  init(_props, cx) {
    migratePagePrefs();
    this.states = new Map();
    this.uf = new (/** @type {any} */ (uFuzzy))();
    this.treeHandle = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search files or text" });
    this.search.on("change", (_e, cx) => { const st = this.current(); if (st && this.search.value() !== st.query) this.runSearch(st, this.search.value(), cx); });
    this.search.on("submit", (_e, cx) => {
      const st = this.current();
      if (!st) return;
      if (st.searchMode === "text") {
        const m = st.textResults?.[st.at];
        if (m) this.pickMatch(st, m, cx);
        return;
      }
      const loc = parseQueryLocation(st.query);
      if (!loc.query && loc.line && st.file) {
        st.query = ""; st.results = null; st.at = -1; this.search.set_value("");
        this.open(st, st.file, cx, false, { line: loc.line, col: loc.col });
        return;
      }
      const r = st.results?.[st.at];
      if (r) this.pick(st, r.path, cx, loc.line ? { line: loc.line, col: loc.col } : null);
    });
    this.handle = cx.focus_handle();
    this.navOpen = navOpen();
    // The width the code is laid out at, behind its room while that moves (codeView, nav-column.js holdWidth).
    /** @type {{ at?: number, want?: number, run?: number }} */
    this.codeHold = {};
    // Image preview viewport size and canvas backdrop ("auto" | "light" | "dark"), kept in memory for this run only (只记本次运行).
    /** @type {{ width: number, height: number } | null} */
    this.imgBox = null;
    this.imgBg = "auto";
    this.cached = new Set();
    // Last consumed `t3.filesOpen` timestamp, kept in memory for this run only (只记本次运行).
    this.lastOpenAt = 0;
    this.openQueuedAt = 0;
    // The state being worked for, and a count that moves each time that changes (going).
    this.awake = null; this.gen = 0;
    cx.spawn(async () => {
      const cacheDir = `${appHome()}/${CACHE}`;
      if (window()?.platform === "windows") await exec("powershell", ["-NoProfile", "-Command", `if (Test-Path -LiteralPath '${cacheDir.replace(/'/g, "''")}') { Remove-Item -Recurse -Force -LiteralPath '${cacheDir.replace(/'/g, "''")}' }`]).catch(() => null);
      else await exec("rm", ["-rf", cacheDir]).catch(() => null);
    });
    // A hidden copy isn't drawn, so this is what sees it go out of view.
    cx.timer.every(1000, (cx) => { this.sync(cx); this.poll(cx); });
    // `t3-files.open:<path from the space's folder>[:line[:col]]` and `t3-files.search:<words>`, for keys and scripts (the demo's);
    // `t3-files.close`, cmd-w while it has the keyboard, closes the panel as T3's does.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand(), st = this.current(), at = c.indexOf(":"), [what, arg] = [c.slice(0, at), c.slice(at + 1)];
        if (c === "close") hidePanel();
        if (at < 0) continue;
        if (what === "open") {
          const sp = spaces().find((s) => s.active);
          const target = st ?? (sp ? this.stateFor(sp) : null);
          if (!target) continue;
          const loc = parseQueryLocation(arg);
          const rel = loc.query || arg;
          const jump = loc.line ? { line: loc.line, col: loc.col } : null;
          if (this.awake === target && this.shown()) {
            this.open(target, rel, cx, false, jump);
            this.reveal(target, rel, cx);
          } else {
            target.file = rel;
            for (const a of ancestors(rel)) target.expanded.add(a);
            this.pendingOpen = { id: target.id, path: rel, target: jump };
            this.sync(cx);
          }
        }
        else if (st && what === "search") {
          st.searchMode = "files";
          this.search.set_value(arg);
          this.find(st, arg, cx);
        }
        else if (st && what === "search-text") {
          st.searchMode = "text";
          this.search.set_value(arg);
          this.findText(st, arg, cx);
        }
      }
    });
  }

  // Its images go with it; one a crash left is cleared at the next start.
  async close() {
    this.stopWatch();
    await Promise.all([...this.cached].map((f) => fs.unlink(`${appHome()}/${f}`).catch(() => null)));
  }

  stopWatch() {
    if (!this.watchToken) return;
    this.watchToken.stopped = true;
    this.watchToken.wait?.cancel?.();
    this.watchToken = null;
  }

  watchLocal(st, cx) {
    if (st.on || !st.root || typeof watchFolder !== "function") { this.stopWatch(); return; }
    if (this.watchToken?.root === st.root && !this.watchToken.stopped) return;
    this.stopWatch();
    const token = { root: st.root, stopped: false, wait: null };
    this.watchToken = token;
    cx.spawn(async (cx) => {
      try {
        while (!token.stopped && this.watchToken === token && this.awake === st) {
          token.wait = watchFolder(st.root);
          const changed = await token.wait;
          token.wait = null;
          if (token.stopped || this.watchToken !== token || this.awake !== st) return;
          // Ignore churn purely inside .git or node_modules when watchFolder reports changed paths.
          if (Array.isArray(changed) && changed.length && changed.every((p) => /(?:^|[\\/])(?:\.git|node_modules)(?:[\\/]|$)/.test(String(p)))) continue;
          if (st.git !== undefined && Date.now() - (st.refreshed ?? 0) >= 1000) this.recheck(st, cx);
        }
      } catch {}
    });
  }

  current() {
    const sp = spaces().find((s) => s.active);
    return sp ? this.states.get(sp.id) : null;
  }

  // A space's state, made the first time and made again when its folder moves; the latest one last. The FULL last keep all
  // they read; older ones only how they were being read, and read again when back.
  stateFor(sp) {
    const ps = typeof panes === "function" ? panes() : [];
    const f = typeof focused === "function" ? focused() : null;
    const userHome = typeof home === "function" ? home() : "";
    const root = resolveRoot(sp, ps, f, userHome);
    let st = this.states.get(sp.id);
    if (!st || st.root !== root || st.on !== (sp.machine ?? null)) { if (st) this.drop(st); st = blank(sp, root); }
    else if ([...this.states.keys()].at(-1) === sp.id) return st;
    this.states.delete(sp.id);
    this.states.set(sp.id, st);
    for (const old of [...this.states.values()].slice(0, -FULL)) this.states.set(old.id, this.slim(old));
    return st;
  }

  // What `st` read let go, for whatever still holds it too (a read under way): its editor, image and lists.
  drop(st) {
    st.view?.code?.release();
    if (st.view?.image) this.uncache(st.view.image);
    Object.assign(st, { view: null, entries: new Map(), ignored: new Set(), marks: new Map(), dirs: new Set(), rows: null, paths: null, lower: null, last: null, results: null, textResults: null, textLoading: false, textError: null, textTruncated: false });
  }

  // A space let go of, keeping its file, recent list, open folders and search's words.
  slim(st) {
    this.drop(st);
    return Object.assign(blank({ id: st.id, folder: st.root, machine: st.on }, st.root), { file: st.file, recent: [...(st.recent ?? [])], expanded: new Set(st.expanded), focus: st.focus, query: st.query, searchMode: st.searchMode });
  }

  // Consumes a cross-mod open request (`t3.filesOpen` from t3-links or better-search) outside render().
  consumeOpenRequest(cx) {
    const req = shared(KEY.filesOpen);
    if (!req?.path || !(req.at > this.lastOpenAt)) return;
    const sp = spaces().find((s) => s.active);
    if (!sp || (req.space && req.space !== sp.id)) return;
    this.lastOpenAt = req.at;
    setShared(KEY.filesOpen, null);
    const st = this.stateFor(sp);
    const jump = req.line ? { line: req.line, col: req.col ?? null, length: req.length ?? 0 } : null;
    if (this.awake === st && this.shown()) {
      this.open(st, req.path, cx, false, jump);
      this.reveal(st, req.path, cx);
    } else {
      st.file = req.path;
      for (const a of ancestors(req.path)) st.expanded.add(a);
      this.pendingOpen = { id: st.id, path: req.path, target: jump };
      this.sync(cx);
    }
  }

  // It works only while it shows: the page in the open panel, the window in front, for the active space. Shown, it reads at
  // once; hidden, answers still under way are dropped and nothing more is asked. A closed space's state goes.
  sync(cx) {
    const all = spaces(), sp = all.find((s) => s.active);
    for (const [id, st] of this.states) if (!all.some((s) => s.id === id)) { this.drop(st); this.states.delete(id); }
    const st = sp && this.shown() ? this.stateFor(sp) : null;
    if (st === this.awake) return;
    this.awake = st; this.gen++;
    if (!st?.root) { this.stopWatch(); return; }
    this.watchLocal(st, cx);
    if (st.git === undefined) this.load(st, cx); else this.recheck(st, cx);
    if (this.pendingOpen?.id === st.id) {
      const { path: p, target } = this.pendingOpen;
      this.pendingOpen = null;
      this.open(st, p, cx, false, target ?? null);
      this.reveal(st, p, cx);
    }
  }

  // The page in the open panel, the window in front.
  shown() { const p = panelState(); return p.open && p.page === "files" && Boolean(window()?.active); }
  // Whether what started now may go on: `st` still the one worked for and in view, without having gone out of it since. It
  // asks the layout itself, as sync sees a hide only at its next tick; one it finds puts the page to sleep, so showing again
  // reads again.
  going(st) {
    const gen = this.gen;
    return () => {
      if (this.gen !== gen || this.awake !== st || !this.live(st)) return false;
      if (this.shown() && spaces().find((s) => s.active)?.id === st.id) return true;
      this.awake = null; this.gen++;
      this.stopWatch();
      return false;
    };
  }
  // A ticket (model.js) that also lapses once `st` stops showing.
  fresh(st, kind) { const t = ticket(st, kind), go = this.going(st); return () => t() && go(); }
  live(st) { return this.states.get(st.id) === st; }
  changed(st) { st.version++; st.rows = null; }

  // Git asked where the folder is, then the rest as a recheck: a space read again gets its file and search back too.
  load(st, cx) {
    const going = this.going(st);
    cx.spawn(async (cx) => {
      const top = await exec("git", ["rev-parse", "--show-toplevel", "--show-prefix"], { cwd: st.root, on: st.on }).catch(() => null);
      if (!going()) return;
      const [dir, prefix] = top?.code === 0 ? top.stdout.split("\n") : [];
      st.git = dir ? { top: dir, prefix: prefix ?? "" } : null;
      this.recheck(st, cx);
    });
  }

  // Git's marks, and every folder shown listed again. The search's list of files is made again at its next word.
  async refresh(st, cx) {
    const go = this.going(st);
    if (!go() || st.git === undefined) return;
    const began = st.refreshed = Date.now();
    const shown = ["", ...st.expanded].filter((p) => p === "" || ancestors(p).every((a) => st.expanded.has(a)));
    await Promise.all([this.status(st), ...shown.map((p) => this.list(st, p))]);
    if (!go()) return;
    st.refreshed = Date.now(); st.took = st.refreshed - began; st.paths = null;
    cx.notify();
  }

  async status(st) {
    if (!st.git) return;
    const fresh = this.fresh(st, "status");
    const r = await exec("git", [...GIT, "status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: st.git.top, on: st.on }).catch(() => null);
    if (r?.code !== 0 || !fresh()) return;
    Object.assign(st, parseStatus(r.stdout, st.git.prefix));
    this.changed(st);
  }

  async list(st, rel, cx = null) {
    const fresh = this.fresh(st, `list:${rel}`), dir = join(st.root, rel);
    if (!fresh()) return;
    const inIgnored = [rel, ...ancestors(rel)].some((p) => p && st.ignored.has(p));

    if (!st.on && window()?.platform === "windows") {
      let entries = null;
      try {
        const items = await fs.readdir(dir, { withFileTypes: true });
        entries = sortEntries(items
          .filter((d) => d.name !== ".git")
          .slice(0, 501)
          .map((d) => ({ name: d.name, dir: d.isDirectory() })));
      } catch {
        const pr = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + dir.replace(/['‘’‚‛]/g, "$&$&") + "'"]).catch(() => null);
        if (pr?.code === 0) {
          try {
            const res = JSON.parse(pr.stdout || "[]");
            const list = Array.isArray(res) ? res : [res];
            entries = sortEntries(list.map((e) => ({ name: e.name, dir: Boolean(e.dir) })));
          } catch {}
        }
      }

      if (!fresh()) return;
      if (!entries) {
        if (rel) { st.entries.delete(rel); st.expanded.delete(rel); } else st.error = "This folder can't be listed.";
        this.changed(st);
        if (cx) cx.notify();
        return;
      }
      st.entries.set(rel, entries);
      if (!rel) st.error = null;
      this.changed(st);
      if (cx) cx.notify();

      if (st.git && !inIgnored && entries.length) {
        const paths = entries.map((e) => (rel ? `${rel}/` : "") + e.name + (e.dir ? "/" : ""));
        const applyIgnore = async () => {
          const found = new Set();
          // Batch -z calls to avoid Windows 32KB argv limit and handle non-ASCII/spaced names without octal quoting.
          for (let i = 0; i < paths.length; i += 100) {
            const igRes = await exec("git", ["check-ignore", "-z", "--", ...paths.slice(i, i + 100)], { cwd: st.root }).catch(() => null);
            if (!fresh()) return;
            if (igRes?.stdout) {
              for (const p of parseIgnored(igRes.stdout)) found.add(p.replace(/[/\\]+$/, ""));
            }
          }
          if (!found.size) return;
          markIgnored(st.ignored, rel, entries, found);
          this.changed(st);
          if (cx) cx.notify();
        };
        if (cx) cx.spawn(() => applyIgnore());
        else await applyIgnore();
      }
      return;
    }

    const [r, ig] = await Promise.all([
      limited(() => exec("sh", ["-c", LIST, "files", dir], { on: st.on })).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) })),
      // Asked in the folder itself, so Git answers for the repository it's in (including nested clones); in none, nothing is ignored.
      !inIgnored ? limited(() => exec("sh", ["-c", IGNORED, "files", dir, ""], { cwd: dir, on: st.on })).catch(() => null) : null,
    ]);
    if (!fresh()) return;
    if (r.code !== 0) {
      if (rel) { st.entries.delete(rel); st.expanded.delete(rel); } else st.error = "This folder can't be listed.";
    } else {
      const entries = parseListing(r.stdout);
      st.entries.set(rel, entries);
      if (!rel) st.error = null;
      if (ig) {
        markIgnored(st.ignored, rel, entries, new Set([...parseIgnored(ig.stdout)].map((name) => join(rel, name))));
      }
    }
    this.changed(st);
  }

  // While it shows (sync), asked again: every LOCAL_EVERY here or REMOTE_EVERY on another machine from the last refresh's end,
  // 10 times as long as that refresh took if longer, SLOWEST at most.
  poll(cx) {
    const st = this.awake;
    if (!st || st.git === undefined) return;
    const every = Math.min(SLOWEST, Math.max(st.on ? REMOTE_EVERY : LOCAL_EVERY, 10 * (st.took ?? 0)));
    if (Date.now() - (st.refreshed ?? 0) >= every) this.recheck(st, cx);
  }

  // Git, the folders shown and the file asked again. An image shown is copied whole each time, so it's left be: one changed
  // shows when it's picked again.
  recheck(st, cx) {
    st.refreshed = Date.now();
    cx.spawn(async (cx) => {
      await this.refresh(st, cx);
      // A search showing, found again, the lit result kept lit; each asks only while it shows.
      if (st.query && st.searchMode !== "text") this.find(st, st.query, cx, st.results?.[st.at]?.path ?? null);
      if (st.file && !st.view?.image) this.open(st, st.file, cx, true);
    });
  }

  toggle(st, path, cx) {
    if (st.expanded.has(path)) st.expanded.delete(path);
    else {
      st.expanded.add(path);
      // A folder holding just a folder opens with it, as the tree shows them as one row.
      const go = this.going(st);
      cx.spawn(async (cx) => {
        for (let p = path, kids; p && go(); p = kids?.length === 1 && kids[0].dir ? join(p, kids[0].name) : null) {
          await this.list(st, p, cx);
          kids = st.entries.get(p);
          if (kids?.length === 1 && kids[0].dir) st.expanded.add(join(p, kids[0].name));
        }
        if (!go()) return;
        this.changed(st);
        cx.notify();
      });
    }
    st.lit = null;
    this.changed(st);
    cx.notify();
  }

  // Opens the folders down to `path` (a file's, or a folder lit until the next click) and brings its row into view.
  reveal(st, path, cx) {
    if (!this.navOpen) { this.navOpen = true; setNavOpen(true); }
    for (const p of ancestors(path)) st.expanded.add(p);
    st.lit = path && path !== st.file ? path : null;
    this.changed(st);
    const go = this.going(st);
    cx.spawn(async (cx) => {
      for (const p of ancestors(path)) if (go() && !st.entries.has(p)) await this.list(st, p);
      if (!go()) return;
      // The space's folder is the tree's top.
      const id = `t3-files-tree-${st.id}`;
      if (path) revealRow(this, id, path); else this.scrollTop = { ...this.scrollTop, [id]: 0 };
      cx.notify();
    });
    cx.notify();
  }

  // A search result: the file opens, and the tree shows where it is.
  pick(st, path, cx, target = null) {
    st.query = ""; st.results = null; st.at = -1;
    this.search.set_value("");
    this.open(st, path, cx, false, target);
    this.reveal(st, path, cx);
  }

  // A text-search match: keeps the match list open so you can walk hits, opens the file at the exact match.
  pickMatch(st, m, cx) {
    this.open(st, m.path, cx, false, { line: m.line, col: m.col, length: m.length });
  }

  // Closes an opened file tab: switches to the previous recent file if any, or returns to full-height tree browsing.
  closeFile(st, rel, cx) {
    st.recent = (st.recent ?? []).filter((p) => p !== rel);
    if (st.file !== rel) { cx.notify(); return; }
    if (st.recent.length) {
      this.open(st, st.recent[0], cx);
      return;
    }
    if (st.view?.code) st.view.code.release();
    if (st.view?.image) this.uncache(st.view.image);
    st.file = null;
    st.view = null;
    st.jumpLine = null;
    if (!this.navOpen) { this.navOpen = true; setNavOpen(true); }
    this.changed(st);
    cx.notify();
  }

  // Scrolls and highlights a 1-based line (or exact match) inside the readonly code editor.
  applyJump(st, view, target, cx) {
    if (!view?.code || !target?.line) return;
    const text = view.jsonMode === "pretty" && view.prettyText ? view.prettyText : view.text;
    if (typeof text !== "string") return;
    const r = lineRange(text, target.line, target.col, target.length);
    st.jumpLine = r.line;
    view.code.set_selected_range?.({ start: r.contextAfter, end: r.contextAfter });
    const code = view.code;
    cx.timer.after(16, (cx) => {
      if (st.view?.code !== code) return;
      code.set_selected_range?.({ start: r.start, end: r.end });
      code.focus?.();
      cx.notify();
    });
  }

  // Shows a file; `again` reads it again where it may have changed, and leaves it as it was if it hasn't.
  open(st, rel, cx, again = false, target = null) {
    if (!again && target?.line && st.file === rel && st.view && !st.view.loading && !st.view.problem && st.view.text !== undefined) {
      const v = st.view;
      if (kindOf(rel) === "markdown" && shared(MARKDOWN) !== "code") setShared(MARKDOWN, "code");
      if (isSvg(rel)) v.svgMode = "code";
      if (isHtml(rel)) v.htmlMode = "code";
      if (!v.code) this.editor(v, rel);
      this.applyJump(st, v, target, cx);
      cx.notify();
      return;
    }
    if (!again) {
      if (st.view?.code) st.view.code.release();
      if (st.view?.image) this.uncache(st.view.image);
      st.file = rel; st.lit = null; st.view = { loading: true };
      st.jumpLine = target?.line ?? null;
      st.recent = [rel, ...(st.recent ?? []).filter((p) => p !== rel)].slice(0, RECENT_MAX);
      this.changed(st);
      cx.notify();
    }
    const fresh = this.fresh(st, "file"), abs = join(st.root, rel), kind = kindOf(rel);
    if (!fresh()) return;
    cx.spawn(async (cx) => {
      const view = await this.read(st, abs, rel, kind, fresh).catch(() => ({ problem: "This file can't be read." }));
      if (view?.problem) view.failed = failedRead(view.problem);
      if (!view || !fresh() || st.file !== rel) {
        if (view?.image) this.uncache(view.image);
        return;
      }
      const old = st.view;
      if (again && old && view.text !== undefined && view.text === old.text) return;
      if (old?.image && old.image !== view.image) this.uncache(old.image);
      if (view.image) {
        view.imgMode = again && old?.imgMode ? old.imgMode : defaultImageMode(view.dims, this.imgBox);
        view.imgManual = again ? Boolean(old?.imgManual) : false;
        view.imgScale = again && old?.imgScale ? old.imgScale : 1;
      }
      if (isSvg(rel)) view.svgMode = target?.line ? "code" : (again && old?.svgMode ? old.svgMode : "preview");
      if (isHtml(rel)) view.htmlMode = target?.line ? "code" : (again && old?.htmlMode ? old.htmlMode : "code");
      if (kind === "markdown" && target?.line && shared(MARKDOWN) !== "code") setShared(MARKDOWN, "code");
      if (isJson(rel) && view.text !== undefined && !view.truncated) {
        const fmt = formatJsonPreview(view.text);
        if (fmt) {
          view.prettyText = fmt.pretty;
          view.jsonMode = target?.line ? "raw" : (again && old?.jsonMode ? old.jsonMode : fmt.minified ? "pretty" : "raw");
        }
      }
      const needsCode = view.text !== undefined && (
        Boolean(target?.line)
        || (kind === "text" && (!isHtml(rel) || view.htmlMode === "code"))
        || (kind === "markdown" && shared(MARKDOWN) === "code")
        || (isSvg(rel) && view.svgMode === "code")
      );
      if (needsCode) this.editor(view, rel);
      if (old?.code) old.code.release();
      st.view = view;
      if (target?.line && view.code) this.applyJump(st, view, target, cx);
      cx.notify();
    });
  }

  /** @returns {Promise<any>} */
  async read(st, abs, rel, kind, fresh) {
    if (st.marks.get(rel) === "D" && !(st.entries.get(parentOf(rel)) ?? []).some((e) => e.name === nameOf(rel)))
      return { problem: "This file was deleted." };
    let size = null;
    if (st.on) {
      const p = await exec("sh", ["-c", PROBE, "probe", abs], { on: st.on });
      if (!fresh()) return null;
      if (p.code !== 0) return { problem: "This file can't be read." };
      const [bytes, nuls] = p.stdout.trim().split(" ").map(Number);
      size = Number.isFinite(bytes) ? bytes : null;
      if (kind !== "image" && nuls > 0) return { problem: "This is a binary file, so there's no text to show.", binary: true, bytes: size };
      if (kind !== "image" && size > TEXT_MAX) {
        const head = await exec("sh", ["-c", `head -c ${HEAD_PREVIEW} "$1"`, "head", abs], { on: st.on }).catch(() => null);
        if (!fresh()) return null;
        if (head?.code === 0 && !head.stdout.includes("\0")) {
          const text = trimHeadPreview(head.stdout);
          return { text, bytes: size, truncated: true, shownBytes: Math.min(size, HEAD_PREVIEW) };
        }
        return { problem: "This file is larger than 1 MB, too large to preview.", binary: true, bytes: size };
      }
    }
    if (kind === "image") {
      if (st.on && size > REMOTE_IMAGE)
        return { problem: `This image is larger than 4 MB, too large to bring over from ${st.on}.`, binary: true, bytes: size };
      const name = `${CACHE}/${Date.now()}-${nameOf(rel).replace(/[^\w.-]/g, "_")}`, dest = `${appHome()}/${name}`;
      await fs.mkdir(`${appHome()}/${CACHE}`, { recursive: true }).catch(() => null);
      if (!fresh()) return null;
      let dims = null, imgBytes = size, svgText;
      if (st.on) {
        if (isSvg(rel) && (size == null || size <= TEXT_MAX)) {
          const text = await readTextFile(abs, { on: st.on }).catch(() => null);
          if (!fresh()) return null;
          if (typeof text === "string" && !text.includes("\0")) {
            await fs.writeFile(dest, text);
            svgText = text;
            dims = svgDimensions(text);
            imgBytes = size ?? utf8Bytes(text);
          }
        }
        if (svgText === undefined) {
          const r = await exec("base64", [abs], { on: st.on, timeout: 60000 });
          if (!fresh()) return null;
          if (r.code !== 0) return { problem: "This image can't be read." };
          const b64 = r.stdout.replace(/\s+/g, "");
          const bytes = decodeBase64(b64);
          if (!bytes.length && size > 0) return { problem: "This image can't be read." };
          const ok = await this.writeImageBytes(dest, bytes, b64);
          if (!fresh()) { await fs.unlink(dest).catch(() => null); return null; }
          if (!ok) return { problem: "This image can't be read." };
          dims = imageDimensions(bytes);
          imgBytes = size ?? bytes.length;
        }
      } else if (window()?.platform === "windows") {
        const r = await exec("powershell", ["-NoProfile", "-Command", `Copy-Item -LiteralPath '${psQuote(abs)}' -Destination '${psQuote(dest)}'`]).catch(() => null);
        if (r?.code !== 0) return { problem: "This image can't be read." };
      } else {
        const r = await exec("cp", [abs, dest]);
        if (r.code !== 0) return { problem: "This image can't be read." };
      }
      if (!fresh()) { await fs.unlink(dest).catch(() => null); return null; }
      if (!st.on && typeof fs.readFile === "function") {
        if (isSvg(rel)) {
          const text = await fs.readFile(dest, "utf8").catch(() => null);
          if (typeof text === "string") {
            svgText = text;
            dims = svgDimensions(text);
            imgBytes = utf8Bytes(text);
          }
        } else {
          const raw = await fs.readFile(dest).catch(() => null);
          if (raw && raw.length) {
            dims = imageDimensions(raw);
            imgBytes = raw.length;
          }
        }
      }
      if (!fresh()) { await fs.unlink(dest).catch(() => null); return null; }
      this.cached.add(name);
      return { image: name, dims, bytes: imgBytes, ...(svgText !== undefined ? { text: svgText } : {}) };
    }
    let text;
    try { text = await readTextFile(abs, { on: st.on }); }
    catch (e) {
      const msg = String(e);
      if (!st.on && msg.includes("exceeds 1 MiB")) {
        const large = await this.readLargeLocal(abs, fresh);
        if (large) return large;
      }
      if (!st.on && msg.includes("UTF-8")) {
        const bytes = await this.localFileSize(abs);
        if (!fresh()) return null;
        return { problem: readProblem(e), binary: true, bytes };
      }
      return { problem: readProblem(e) };
    }
    if (text === null) return { problem: "This file isn't there anymore." };
    if ((st.on && text.includes("\uFFFD")) || text.includes("\0"))
      return { problem: "This file isn't UTF-8 text, so there's nothing to show.", binary: true, bytes: size ?? utf8Bytes(text) };
    return { text, bytes: size ?? utf8Bytes(text) };
  }

  // Write decoded image bytes under appHome(). Works around a Herdr 0.1.16 / gpui-shell 0.7.1 bug where
  // fs.writeFile(path, Uint8Array) silently creates a 0-byte file by falling back to writing ASCII base64 + native decode.
  async writeImageBytes(dest, bytes, b64) {
    await fs.writeFile(dest, bytes);
    if (!bytes.length || typeof fs.readFile !== "function") return true;
    const written = await fs.readFile(dest).catch(() => null);
    if (written && written.length === bytes.length) return true;
    const b64Path = `${dest}.b64`;
    try {
      await fs.writeFile(b64Path, b64);
      let r;
      if (window()?.platform === "windows") {
        r = await exec("powershell", ["-NoProfile", "-Command",
          `& { param($s,$d) [IO.File]::WriteAllBytes($d, [Convert]::FromBase64String([IO.File]::ReadAllText($s))) } '${psQuote(b64Path)}' '${psQuote(dest)}'`
        ]).catch(() => null);
      } else {
        r = await exec("sh", ["-c", 'base64 -d "$1" > "$2" 2>/dev/null || base64 -D "$1" > "$2"', "b64", b64Path, dest]).catch(() => null);
      }
      return r?.code === 0;
    } finally {
      await fs.unlink(b64Path).catch(() => null);
    }
  }

  async localFileSize(abs) {
    try {
      if (typeof fs.stat === "function") {
        const s = await fs.stat(abs);
        if (typeof (/** @type {any} */ (s)).size === "number") return /** @type {any} */ (s).size;
      }
    } catch {}
    if (window()?.platform === "windows") {
      const r = await exec("powershell", ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${psQuote(abs)}' -ErrorAction Stop).Length`]).catch(() => null);
      const n = Number(r?.stdout?.trim());
      return r?.code === 0 && Number.isFinite(n) ? n : null;
    }
    const r = await exec("sh", ["-c", 'wc -c < "$1"', "size", abs]).catch(() => null);
    const n = Number(r?.stdout?.trim());
    return r?.code === 0 && Number.isFinite(n) ? n : null;
  }

  async readLargeLocal(abs, fresh) {
    if (window()?.platform === "windows") {
      const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p,$lim) $fi = Get-Item -LiteralPath $p -ErrorAction Stop; $len = $fi.Length; $fs = [IO.File]::OpenRead($p); try { $n = [int][Math]::Min($len, $lim); $buf = New-Object byte[] $n; $read = $fs.Read($buf, 0, $n); $probe = [Math]::Min($read, 8192); $bin = $false; for ($i = 0; $i -lt $probe; $i++) { if ($buf[$i] -eq 0) { $bin = $true; break } }; if ($bin) { [Console]::Out.Write("BIN:$len") } else { [Console]::Out.Write("TXT:$len\n"); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($buf, 0, $read)) } } finally { $fs.Dispose() } } '${psQuote(abs)}' ${HEAD_PREVIEW}`;
      const r = await exec("powershell", ["-NoProfile", "-Command", script]).catch(() => null);
      if (!fresh() || r?.code !== 0) return null;
      if (r.stdout.startsWith("BIN:")) return { problem: "This is a binary file, so there's no text to show.", binary: true, bytes: Number(r.stdout.slice(4)) || null };
      if (r.stdout.startsWith("TXT:")) {
        const nl = r.stdout.indexOf("\n"), bytes = Number(r.stdout.slice(4, nl)) || null;
        return { text: trimHeadPreview(r.stdout.slice(nl + 1)), bytes, truncated: true, shownBytes: HEAD_PREVIEW };
      }
      return null;
    }
    const p = await exec("sh", ["-c", PROBE, "probe", abs]).catch(() => null);
    if (!fresh() || p?.code !== 0) return null;
    const [bytes, nuls] = p.stdout.trim().split(" ").map(Number);
    if (nuls > 0) return { problem: "This is a binary file, so there's no text to show.", binary: true, bytes: Number.isFinite(bytes) ? bytes : null };
    const head = await exec("sh", ["-c", `head -c ${HEAD_PREVIEW} "$1"`, "head", abs]).catch(() => null);
    if (!fresh() || head?.code !== 0 || head.stdout.includes("\0")) return null;
    return { text: trimHeadPreview(head.stdout), bytes: Number.isFinite(bytes) ? bytes : null, truncated: true, shownBytes: HEAD_PREVIEW };
  }

  uncache(name) {
    this.cached.delete(name);
    fs.unlink(`${appHome()}/${name}`).catch(() => null);
  }

  // The view's code, wrapped as the layout's Lines choice says (store.js), which it notes: the editor takes it only when made.
  editor(view, rel) {
    const t = theme();
    const value = view.jsonMode === "pretty" && view.prettyText ? view.prettyText : view.text;
    view.wrap = wrapLines();
    view.code = EditorState.new({ language: languageOf(nameOf(rel)), value, readonly: true, soft_wrap: view.wrap, font_family: /** @type {string} */ (settings().font_family), font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  openLink(st, url, cx) {
    if (!url) return;
    if (/^https?:\/\//i.test(url)) { cx.open_url(url); return; }
    const target = resolveRelPath(st.file, url);
    if (target) { this.open(st, target, cx); this.reveal(st, target, cx); }
  }

  openExternal(st, rel, cx) {
    if (!st.root || !rel || st.on) return;
    const platform = window()?.platform;
    const rawAbs = join(st.root, rel);
    const abs = platform === "windows" ? rawAbs.replace(/\//g, "\\") : rawAbs;
    runCommon("open", { abs, rel, agent: null, platform }, cx);
  }

  runSearch(st, query, cx) {
    if (st.searchMode === "text") this.findText(st, query, cx);
    else this.find(st, query, cx);
  }

  // Every term in the path, case aside (stripping an optional trailing `:line[:col]`).
  // `keep`: the path to keep lit, if it's still found.
  find(st, query, cx, keep = null) {
    st.query = query;
    st.textResults = null; st.textLoading = false; st.textError = null;
    if (!keep) st.at = 0;
    const cleanQuery = parseQueryLocation(query).query;
    const words = terms(cleanQuery), fresh = this.fresh(st, "search");
    if (!words.length) { st.results = null; cx.notify(); return; }
    if (!fresh()) return;
    cx.spawn(async (cx) => {
      let found, total;
      if (st.on) {
        await cx.sleep(200);
        if (!fresh()) return;
        const r = await exec("sh", ["-c", REMOTE_SEARCH, "search", cleanQuery], { cwd: st.root, on: st.on }).catch(() => null);
        if (!fresh()) return;
        found = (r?.stdout ?? "").split("\n").filter(Boolean);
        total = found.length;
        st.more = total >= RANKED;
      } else {
        if (!st.paths) {
          let stdout = null, nul = false;
          if (st.git) {
            const r = await exec("git", [...GIT, "ls-files", "-co", "--exclude-standard", "-z"], { cwd: st.root }).catch(() => null);
            if (r?.code === 0) { stdout = r.stdout; nul = true; }
          }
          if (stdout === null) {
            if (window()?.platform === "windows") {
              const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $n = (Get-Location).Path.TrimEnd('\\').Length + 1; (Get-ChildItem -LiteralPath . -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '[\\\\/]\\.git([\\\\/]|$)' } | Select-Object -First 200000 | ForEach-Object { $_.FullName.Substring($n).Replace('\\', '/') })"], { cwd: st.root }).catch(() => null);
              if (r?.code === 0) stdout = r.stdout;
            } else {
              const r = await exec("sh", ["-c", "find . -name .git -prune -o -type f -print | sed 's|^\\./||' | head -n 200000"], { cwd: st.root }).catch(() => null);
              if (r?.code === 0) stdout = r.stdout;
            }
          }
          if (!fresh()) return;
          st.paths = (stdout ?? "").split(nul ? "\0" : /\r?\n/).filter(Boolean);
          st.lower = st.paths.map((p) => p.toLowerCase());
          st.last = null;
        }
        const from = narrows(cleanQuery, st.last?.query) ? st.last.idx : null;
        const idx = await filterPaths(st.lower, words, from, () => cx.sleep(0), fresh);
        if (!idx) return;
        st.last = { query: cleanQuery, idx };
        total = idx.length;
        found = idx.slice(0, total <= RANKED ? RANKED : RESULTS).map((i) => st.paths[i]);
        st.more = false;
      }
      st.results = found.length <= RANKED ? rank(this.uf, found, cleanQuery, RESULTS) : found.slice(0, RESULTS).map((path) => ({ path, ranges: [] }));
      st.total = total;
      const kept = keep ? st.results.findIndex((r) => r.path === keep) : -1;
      st.at = kept >= 0 ? kept : Math.min(Math.max(keep ? 0 : st.at, 0), st.results.length - 1);
      cx.notify();
    });
    cx.notify();
  }

  // Read-only full-text search across the space using ripgrep (`rg --json`), local or remote.
  findText(st, query, cx) {
    st.query = query;
    st.results = null;
    st.at = 0;
    const trimmed = query.trim();
    const fresh = this.fresh(st, "text");
    if (!trimmed) {
      st.textResults = null; st.textLoading = false; st.textError = null; st.textTruncated = false;
      cx.notify();
      return;
    }
    if (!st.root || !fresh()) return;
    st.textLoading = true;
    st.textError = null;
    cx.spawn(async (cx) => {
      await cx.sleep(180);
      if (!fresh()) return;
      const args = ["--json", "--max-count", "40", "--max-columns", "300", "--max-filesize", "1M", "--no-messages"];
      if (!st.matchCase) args.push("-i");
      if (!st.useRegex) args.push("-F");
      args.push("--", trimmed, ".");
      const r = await exec("rg", args, { cwd: st.root, on: st.on, timeout: 10000 }).catch(() => null);
      if (!fresh()) return;
      st.textLoading = false;
      if (!r) {
        st.textResults = [];
        st.textTruncated = false;
        st.textError = "ripgrep (rg) is required for text search.";
        cx.notify();
        return;
      }
      if (r.code === 1) {
        st.textResults = [];
        st.textTruncated = false;
        st.textError = null;
        st.at = -1;
        cx.notify();
        return;
      }
      if (r.code !== 0 && !r.stdout) {
        st.textResults = [];
        st.textTruncated = false;
        const msg = String(r.stderr || "").trim().split(/\r?\n/)[0];
        st.textError = msg || "ripgrep (rg) is required for text search.";
        cx.notify();
        return;
      }
      const parsed = parseRgJson(r.stdout, RESULTS);
      st.textResults = parsed.matches;
      st.textTruncated = parsed.truncated;
      st.textError = null;
      st.at = parsed.matches.length ? 0 : -1;
      cx.notify();
    });
    cx.notify();
  }

  // A row's menu: file-menu.js's items.
  menuItems(st, path) {
    const abs = join(st.root, path), agent = agentFor(st.id), platform = window()?.platform, dir = Boolean(this.rows(st).find((r) => r.path === path)?.dir);
    const items = fileMenuItems({ page: "files", dir, remote: Boolean(st.on), platform, agent }).map((it) => ({ ...it,
      hint: it.id === "copy-path" ? st.on ?? "" : it.id === "mention" ? agent.program?.name ?? "" : "",
      run: (cx) => runCommon(it.id, { abs, rel: path, agent, platform }, cx) }));
    if (!st.on) {
      items.push({
        id: "vscode",
        label: "Open in VS Code",
        icon: "code",
        hint: "",
        run: () => {
          if (platform === "windows") exec("cmd", ["/c", "code", abs]).catch(() => null);
          else exec("code", [abs]).catch(() => null);
          return true;
        }
      });
    }
    return items;
  }

  rows(st) { return st.rows ??= treeRows(folderEntries(st), (p) => st.expanded.has(p)); }

  render(cx) {
    const t = theme(), sp = spaces().find((s) => s.active);
    if (!sp) return div().id("t3-files").size_full();
    this.sync(cx);
    const st = this.stateFor(sp);
    // Lines changed: the editor made again, just after this draw, as an editor can't be made in one.
    const v = st.view;
    if (v?.code && v.wrap !== wrapLines()) cx.timer.after(0, (cx) => {
      if (st.view !== v || !v.code || v.wrap === wrapLines()) return;
      const old = v.code;
      this.editor(v, st.file);
      old.release();
      cx.notify();
    });
    // A cross-mod open request (`t3.filesOpen` from t3-links or better-search) is consumed right after render().
    const openReq = shared(KEY.filesOpen);
    if (openReq?.path && openReq.at > this.lastOpenAt && openReq.at !== this.openQueuedAt && (!openReq.space || openReq.space === sp.id)) {
      this.openQueuedAt = openReq.at;
      cx.timer.after(0, (cx) => this.consumeOpenRequest(cx));
    }
    // The search field shows this space's words.
    if (this.searchFor !== st.id) { this.searchFor = st.id; if (this.search.value() !== st.query) this.search.set_value(st.query); }
    const bodyHeight = Math.max(240, (this.size?.height ?? 720) - 40);
    return v_flex().id("t3-files").relative().size_full().min_h(0).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { this.size = { width: size.width / zoom(), height: size.height / zoom() }; cx.notify(); })
      .on_mouse_down("right", (e, cx) => {
        if (!this.menuFor) return;
        this.menu = { path: this.menuFor, x: e.local_position.x / zoom(), y: e.local_position.y / zoom(), at: -1 };
        this.menuFor = null;
        this.handle.focus();
        cx.notify();
      })
      .child(this.toolbar(st, t))
      // What failed, under the toolbar: the folder's listing, or the file's read. Retry asks again.
      .when(Boolean(st.error), (el) => el.child(errorBar(t, "t3-files-error", st.error, (cx) => cx.spawn(async (cx) => this.refresh(st, cx)), this)))
      .when(Boolean(!st.error && st.view?.failed), (el) => el.child(errorBar(t, "t3-files-error", st.view.problem, (cx) => this.open(st, st.file, cx), this)))
      .child(div().flex_1().min_h(0).child(withTopNav(t, "t3-files", bodyHeight, {
        content: this.content(st, t),
        head: this.searchHead(st, t),
        list: st.searchMode === "text" && st.query.trim() ? this.foundText(st, t) : st.results ? this.found(st, t) : this.tree(st, t),
        open: this.navOpen,
        fullNav: !st.file,
      })))
      .when(Boolean(this.menu), (el) => el.child(fileMenuView(this, t, MOD, this.menuItems(st, this.menu.path), this.handle, this.size ?? { width: 800, height: 600 })));
  }

  // The page's toolbar, across it, there with no file too: where the file is (the folder's name alone without one), quick
  // actions (mention in agent, copy path, open in default app / VS Code), mode toggles (Markdown, SVG, HTML, JSON),
  // Wrap for code, tree toggle & close.
  toolbar(st, t) {
    const v = st.view;
    const md = kindOf(st.file ?? "") === "markdown", code = shared(MARKDOWN) === "code";
    const svgFile = Boolean(st.file && isSvg(st.file) && v?.image && v?.text !== undefined);
    const htmlFile = Boolean(st.file && isHtml(st.file) && v?.text !== undefined);
    const jsonFile = Boolean(st.file && isJson(st.file) && v?.prettyText);
    const parts = st.file?.split("/") ?? [];
    const shownText = v?.jsonMode === "pretty" && v?.prettyText ? v.prettyText : v?.text;
    const lines = shownText !== undefined && !v?.image ? lineCount(shownText) : 0;
    const sizeText = v?.bytes != null && !v?.image ? formatBytes(v.bytes) : "";
    const lineTag = st.jumpLine && !v?.image ? `L${st.jumpLine}` : "";
    const metaParts = [lineTag, lines > 0 ? `${count(lines)}L` : "", sizeText].filter(Boolean);
    const metaLabel = metaParts.join(" · ");
    const codeActive = Boolean(v?.code && (
      (!md && !svgFile && !htmlFile)
      || (md && code)
      || (svgFile && v.svgMode === "code")
      || (htmlFile && v.htmlMode === "code")
    ));
    const agent = st.file ? agentFor(st.id) : null;
    const crumb = (label, path, last) => div().id(`crumb-${path}`).flex_none().px(4).rounded(4).text_color(last ? t.foreground : t.muted)
      .when(!last, (el) => el.cursor_pointer().hover((s) => s.bg(t.foreground + "12").text_color(t.foreground)).on_click((_e, cx) => this.reveal(st, path, cx)))
      .child(label);
    const seg = (id, label, on, click) => div().id(id).h(24).px(8).flex().items_center().rounded(6).text_size(12)
      .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => { if (!on) click(cx); })
      .child(label);
    const ensureCode = () => { if (v?.text !== undefined && !v.code) this.editor(v, st.file); };
    return h_flex().id("t3-files-toolbar").h(40).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
        // The first word 16 in, as Review's scope button's: the toolbar's 8 and an xs button's 8 (a crumb's own 4, and 4 more).
        .child(h_flex().flex_1().min_w(0).overflow_hidden().items_center().text_size(12).pl(4)
          .when(Boolean(st.root), (el) => el.child(crumb(nameOf(st.root.replace(/[/\\]+$/, "")) || st.root, "", !st.file)))
          .children(parts.flatMap((part, i) => [div().flex_none().text_color(t.dim).child("/"), crumb(part, parts.slice(0, i + 1).join("/"), i === parts.length - 1)])))
        .when(Boolean(metaLabel), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(metaLabel)))
        .when(md, (el) => el.child(h_flex().flex_none().gap(2)
          .child(seg("t3-files-preview", "Preview", !code, (cx) => { setShared(MARKDOWN, "preview"); cx.notify(); }))
          .child(seg("t3-files-code", "Code", code, (cx) => { ensureCode(); setShared(MARKDOWN, "code"); cx.notify(); }))))
        .when(svgFile, (el) => el.child(h_flex().flex_none().gap(2)
          .child(seg("t3-files-svg-preview", "Preview", v.svgMode !== "code", (cx) => { v.svgMode = "preview"; cx.notify(); }))
          .child(seg("t3-files-svg-code", "Code", v.svgMode === "code", (cx) => { v.svgMode = "code"; ensureCode(); cx.notify(); }))))
        .when(htmlFile, (el) => el.child(h_flex().flex_none().gap(2)
          .child(seg("t3-files-html-code", "Code", v.htmlMode !== "preview", (cx) => { v.htmlMode = "code"; ensureCode(); cx.notify(); }))
          .child(seg("t3-files-html-preview", "Preview", v.htmlMode === "preview", (cx) => { v.htmlMode = "preview"; cx.notify(); }))))
        .when(jsonFile, (el) => el.child(h_flex().flex_none().gap(2)
          .child(seg("t3-files-json-pretty", "Pretty", v.jsonMode === "pretty", (cx) => {
            v.jsonMode = "pretty";
            if (v.code) v.code.release();
            this.editor(v, st.file);
            cx.notify();
          }))
          .child(seg("t3-files-json-raw", "Raw", v.jsonMode !== "pretty", (cx) => {
            v.jsonMode = "raw";
            if (v.code) v.code.release();
            this.editor(v, st.file);
            cx.notify();
          }))))
        // The page's buttons 4 apart, as Review's.
        .child(h_flex().flex_none().gap(4).items_center()
          .when(Boolean(st.file && agent), (el) => el.child(ghostButton(t, MOD, "t3-files-mention", "at-sign", `Mention in ${agent.program?.name ?? "agent"}`, (cx) => mention(st.file, agent.address, cx), { view: this })))
          .when(Boolean(st.file), (el) => el.child(ghostButton(t, MOD, "t3-files-copy-path", "copy", "Copy relative path", (cx) => {
            cx.write_to_clipboard(st.file);
            notify({ title: "Copied path", body: st.file, level: "info" });
          }, { view: this })))
          .when(Boolean(st.file && st.root && !st.on), (el) => el.child(ghostButton(t, MOD, "t3-files-open-default", "external-link", "Open in default app", (cx) => this.openExternal(st, st.file, cx), { view: this })))
          // Open in VS Code (local spaces only)
          .when(Boolean(st.root && !st.on), (el) => el.child(ghostButton(t, MOD, "t3-files-open-vscode", "code", "Open in VS Code", () => {
            const target = st.file ? join(st.root, st.file) : st.root;
            const platform = window()?.platform;
            if (platform === "windows") exec("cmd", ["/c", "code", target]).catch(() => null);
            else exec("code", [target]).catch(() => null);
          }, { view: this })))
          // Wrap or scroll long lines, this page's own choice (only shown when code view is active).
          .when(codeActive, (el) => el.child(ghostButton(t, MOD, "t3-files-wrap", "text-wrap", wrapLines() ? "Scroll long lines" : "Wrap long lines", (cx) => { setWrapLines(!wrapLines()); cx.notify(); }, { on: wrapLines(), view: this })))
          .when(Boolean(st.file), (el) => el.child(navToggle(t, MOD, "t3-files-nav-toggle", this.navOpen, (cx) => { this.navOpen = !this.navOpen; setNavOpen(this.navOpen); cx.notify(); }, false, this)))
          .when(Boolean(st.file), (el) => el.child(ghostButton(t, MOD, "t3-files-close-file", "x", "Close file", (cx) => this.closeFile(st, st.file, cx), { view: this }))));
  }

  // Recent open files strip: appears automatically once 2+ files have been opened so switching between them takes one click.
  fileTabs(st, t) {
    const recent = st.recent ?? [];
    if (recent.length < 2) return null;
    return h_flex().id("t3-files-tabs").h(30).flex_none().px(6).gap(4).items_center().border_b(1).border_color(t.border).bg(t.raised).overflow_hidden()
      .children(recent.map((rel, i) => {
        const active = rel === st.file;
        const mark = st.marks.get(rel);
        const markColor = mark === "A" ? t.ansi2 : mark === "D" ? t.ansi1 : mark === "R" ? t.ansi6 : t.ansi3;
        return h_flex().id(`t3-file-tab-${i}`).h(22).px(6).gap(5).flex_none().max_w(160).items_center().rounded(5).cursor_pointer().text_size(11.5)
          .when(active, (el) => el.bg(t.background).border_1().border_color(t.border).text_color(t.foreground).font_medium())
          .when(!active, (el) => el.text_color(t.muted).hover((s) => s.bg(t.foreground + "12").text_color(t.foreground)))
          .on_click((_e, cx) => { if (!active) { this.open(st, rel, cx); this.reveal(st, rel, cx); } })
          .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); this.closeFile(st, rel, cx); })
          .child(image(`${MOD}/${fileIcon(rel, rel, t)}`).size(13).flex_none())
          .child(div().flex_1().min_w(0).truncate().child(nameOf(rel)))
          .when(Boolean(mark), (el) => el.child(div().flex_none().text_size(10).font_bold().text_color(markColor).child(mark)))
          .child(div().id(`t3-file-tab-close-${i}`).size(14).flex_none().flex().items_center().justify_center().rounded(3).text_color(t.dim)
            .hover((s) => s.bg(t.foreground + "18").text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.closeFile(st, rel, cx); })
            .child(svg(`${MOD}/icons/x.svg`).size(10)));
      }));
  }

  // The file: recent-file tabs when 2+ files are open, then Preview or Code for Markdown/SVG/HTML, image viewer, code or binary card.
  content(st, t) {
    const v = st.view, md = kindOf(st.file ?? "") === "markdown", code = shared(MARKDOWN) === "code";
    const svgCode = Boolean(st.file && isSvg(st.file) && v?.svgMode === "code" && v?.code);
    const htmlPreview = Boolean(st.file && isHtml(st.file) && v?.htmlMode === "preview" && v?.text !== undefined);
    if (!st.file) return emptyState(t, "t3-files-empty", `${MOD}/icons/file-text.svg`, "No file open", st.root ? "Pick one in the tree, or search for it." : "This space has no folder.");
    const tabs = this.fileTabs(st, t);
    const truncBanner = v?.truncated ? h_flex().id("t3-files-truncated").h(28).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised).text_size(11).text_color(t.muted)
      .child(div().flex_1().min_w(0).truncate().child(`Large file (${formatBytes(v.bytes)}) · showing first ${formatBytes(v.shownBytes)}`))
      .when(Boolean(!st.on), (el) => el.child(div().id("t3-files-truncated-open").flex_none().cursor_pointer().text_color(t.foreground).hover((s) => s.underline())
        .on_click((_e, cx) => this.openExternal(st, st.file, cx))
        .child("Open in default app"))) : null;
    const body = div().flex_1().min_h(0).min_w(0).w_full()
      .child(!v || v.loading ? loadingState(t, "t3-files-loading", "Loading the file…")
        // A read that failed is the error bar's (the toolbar's); a binary/oversized file gets an actionable card; other notices an empty state.
        : v.problem && v.failed ? div()
        : v.problem && v.binary ? this.binaryView(st, v, t)
        : v.problem ? emptyState(t, "t3-files-problem", `${MOD}/icons/file-text.svg`, nameOf(st.file), v.problem)
        : v.image && !svgCode ? this.imageView(st, v, t)
        : md && !code ? div().id("t3-files-md").size_full().overflow_y_scrollbar().px(20).py(16)
          .child(TextView.markdown(`t3-files-md-${st.id}-${st.file}`, v.text).selectable(true).scrollable(false).text_size(14).on_link_click((url, cx) => this.openLink(st, url, cx)))
        : htmlPreview ? div().id("t3-files-html").size_full().overflow_y_scrollbar().px(20).py(16)
          .child(TextView.html(`t3-files-html-${st.id}-${st.file}`, v.text).selectable(true).scrollable(false).text_size(14).on_link_click((url, cx) => this.openLink(st, url, cx)))
        // Laid out at the width its room last held (nav-column.js holdWidth), cut off or short of it while the room moves.
        : v.code ? this.codeView(v.code)
        : div());
    return v_flex().size_full().min_h(0).min_w(0)
      .when(Boolean(tabs), (el) => el.child(tabs))
      .when(Boolean(truncBanner), (el) => el.child(truncBanner))
      .child(body);
  }

  // Image preview: info + zoom/fit/backdrop controls above a scrollable viewport that keeps natural aspect ratio.
  imageView(st, v, t) {
    const ext = extOf(st.file ?? "").toUpperCase() || "IMAGE";
    const mode = v.imgMode ?? "fit";
    const layout = computeImageLayout(v.dims, this.imgBox, mode, v.imgScale);
    const scale = layout?.scale ?? v.imgScale ?? 1;
    const pct = `${Math.round(scale * 100)}%`;
    const metaParts = [ext];
    if (v.dims) metaParts.push(`${v.dims.width} × ${v.dims.height}`);
    if (v.bytes != null) metaParts.push(formatBytes(v.bytes));
    const pill = (id, label, on, click) => div().id(id).h(20).px(6).flex().items_center().rounded(4).text_size(11).flex_none()
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected).font_medium())
      .when(!on, (el) => el.cursor_pointer().hover((s) => s.bg(t.foreground + "12").text_color(t.foreground)))
      .on_click((_e, cx) => click(cx))
      .child(label);
    const setMode = (next, cx) => { v.imgMode = next; v.imgManual = true; if (next === "actual") v.imgScale = 1; cx.notify(); };
    const stepZoom = (dir, cx) => { v.imgMode = "custom"; v.imgManual = true; v.imgScale = stepImageZoom(scale, dir); cx.notify(); };
    const canvasBg = this.imgBg === "light" ? "#f3f4f6" : this.imgBg === "dark" ? "#111214" : t.raised;
    const imgEl = layout
      ? image(v.image).w(layout.width).h(layout.height).flex_none()
      : image(v.image).max_w_full().max_h_full();
    const minW = Math.max(0, (this.imgBox?.width ?? 0) - 24);
    const minH = Math.max(0, (this.imgBox?.height ?? 0) - 24);
    return v_flex().id("t3-files-image").size_full().min_h(0).min_w(0)
      .child(h_flex().id("t3-files-img-bar").h(32).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.raised).overflow_hidden()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(metaParts.join(" · ")))
        .when(Boolean(v.dims), (el) => el.child(h_flex().flex_none().gap(2).items_center()
          .child(pill("t3-files-img-fit", "Fit", mode === "fit", (cx) => setMode("fit", cx)))
          .child(pill("t3-files-img-width", "Width", mode === "width", (cx) => setMode("width", cx)))
          .child(pill("t3-files-img-actual", "100%", mode === "actual", (cx) => setMode("actual", cx)))
          .child(div().w(1).h(12).mx(2).bg(t.border).flex_none())
          .child(pill("t3-files-img-out", "−", false, (cx) => stepZoom(-1, cx)))
          .child(div().id("t3-files-img-pct").min_w(34).text_center().text_size(11).text_color(t.dim).child(pct))
          .child(pill("t3-files-img-in", "+", false, (cx) => stepZoom(1, cx)))))
        .child(div().w(1).h(12).mx(2).bg(t.border).flex_none())
        .child(h_flex().flex_none().gap(2).items_center()
          .child(pill("t3-files-img-bg-auto", "Auto", this.imgBg === "auto", (cx) => { this.imgBg = "auto"; cx.notify(); }))
          .child(pill("t3-files-img-bg-light", "Light", this.imgBg === "light", (cx) => { this.imgBg = "light"; cx.notify(); }))
          .child(pill("t3-files-img-bg-dark", "Dark", this.imgBg === "dark", (cx) => { this.imgBg = "dark"; cx.notify(); }))))
      .child(div().id("t3-files-img-viewport").flex_1().min_h(0).min_w(0).w_full().overflow_scrollbar()
        .on_size_change((size, cx) => {
          const width = size.width / zoom(), height = size.height / zoom();
          if (this.imgBox && Math.abs(this.imgBox.width - width) < 2 && Math.abs(this.imgBox.height - height) < 2) return;
          this.imgBox = { width, height };
          if (!v.imgManual && v.dims) v.imgMode = defaultImageMode(v.dims, this.imgBox);
          cx.notify();
        })
        .child(div().p(12).flex().items_center().justify_center()
          .when(minW > 0, (el) => el.min_w(minW))
          .when(minH > 0, (el) => el.min_h(minH))
          .child(div().id("t3-files-img-frame").p(4).rounded(6).border_1().border_color(t.border).bg(canvasBg).flex().items_center().justify_center()
            .child(imgEl))));
  }

  // Actionable card for binary files or oversized remote images.
  binaryView(st, v, t) {
    const abs = join(st.root, st.file), platform = window()?.platform;
    const winAbs = platform === "windows" ? abs.replace(/\//g, "\\") : abs;
    const kindLabel = describeFileKind(st.file);
    const meta = v.bytes != null ? `${kindLabel} · ${formatBytes(v.bytes)}` : kindLabel;
    const revealLabel = platform === "macos" ? "Reveal in Finder" : "Reveal in File Explorer";
    const actionBtn = (id, label, icon, press) => drawButton(t, id, { variant: "outline", size: "sm", text: label, icon: `${MOD}/icons/${icon}.svg`, surface: "card", hot: this.hot === id })
      .on_hover((on, cx) => { if (on) this.hot = id; else if (this.hot === id) this.hot = null; cx.notify(); })
      .on_click((_e, cx) => press(cx));
    return v_flex().id("t3-files-binary").size_full().p(24).gap(10).items_center().justify_center().text_center()
      .child(image(`${MOD}/${fileIcon(st.file, st.file, t)}`).size(32).flex_none())
      .child(div().text_size(14).font_medium().text_color(t.foreground).child(nameOf(st.file)))
      .child(div().text_size(12).text_color(t.muted).child(meta))
      .when(Boolean(v.problem), (el) => el.child(div().max_w(360).text_size(12).text_color(t.dim).child(v.problem)))
      .child(h_flex().mt(4).gap(8).items_center().justify_center()
        .when(Boolean(!st.on), (el) => el.child(actionBtn("t3-files-bin-open", "Open in default app", "external-link", (cx) => this.openExternal(st, st.file, cx))))
        .when(Boolean(!st.on && (platform === "macos" || platform === "windows")), (el) => el.child(actionBtn("t3-files-bin-reveal", revealLabel, "folder-open", (cx) => runCommon("reveal", { abs: winAbs, rel: st.file, agent: null, platform }, cx))))
        .child(actionBtn("t3-files-bin-copy", st.on ? `Copy path (${st.on})` : "Copy path", "copy", (cx) => {
          cx.write_to_clipboard(abs);
          notify({ title: "Copied path", body: abs, level: "info" });
        })));
  }

  codeView(code) {
    const hold = this.codeHold;
    return div().id("t3-files-code").size_full().min_w(0).overflow_hidden()
      .on_size_change((size, cx) => {
        const width = size.width / zoom();
        if (Math.abs(width - (hold.want ?? hold.at ?? -1)) < 1) return;
        holdWidth(hold, width, (ms, f) => cx.timer.after(ms, f));
        cx.notify();
      })
      // Always at the held width once known: switching between it and w_full laid the file out again, as long as the drag's step.
      .child(Editor.new(code).h_full().when(hold.at != null, (el) => el.w(hold.at)).when(hold.at == null, (el) => el.w_full()));
  }

  // The top pane's head: file/text mode toggle, search input, regex/case pills (text mode), match count, refresh, and fold all.
  searchHead(st, t) {
    const isText = st.searchMode === "text";
    const list = isText ? st.textResults : st.results;
    const matchLabel = isText
      ? (st.textLoading ? "…" : st.textResults ? `${count(st.textResults.length)}${st.textTruncated ? "+" : ""}` : null)
      : (st.results ? `${count(st.total)}${st.more ? "+" : ""}` : null);
    const chip = (id, label, on, title, click) => div().id(id).h(20).px(6).flex().items_center().flex_none().rounded(4).text_size(11)
      .role("button").accessibility_label(title)
      .text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected).font_medium())
      .when(!on, (el) => el.cursor_pointer().hover((s) => s.bg(t.foreground + "12").text_color(t.foreground)))
      .on_click((_e, cx) => click(cx))
      .child(label);
    const setMode = (mode, cx) => {
      if (st.searchMode === mode) return;
      st.searchMode = mode;
      st.at = -1;
      if (st.query) this.runSearch(st, st.query, cx);
      else { st.results = null; st.textResults = null; st.textError = null; cx.notify(); }
    };
    const clearSearch = (cx) => {
      st.query = ""; st.results = null; st.textResults = null; st.textLoading = false; st.textError = null; st.at = -1;
      this.search.set_value("");
      cx.notify();
    };
    return h_flex().id("t3-files-search").flex_1().min_w(0).h_full().gap(4).items_center()
      .on_key_down((e, cx) => {
        if (e.key === "escape" && st.query) { clearSearch(cx); cx.stop_propagation(); return; }
        else if (list?.length) { const to = step(e, st.at, list.length); if (to < 0) return; st.at = to; }
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(svg(`${MOD}/icons/search.svg`).size(15).flex_none().text_color(t.dim))
      .child(Input.new(this.search).flex_1().h(26).text_size(12).text_color(t.foreground))
      .when(Boolean(matchLabel), (el) => el.child(div().flex_none().px(3).text_size(11).text_color(t.dim).child(matchLabel)))
      .when(Boolean(st.query), (el) => el.child(ghostButton(t, MOD, "t3-files-clear-search", "x", "Clear search", (cx) => clearSearch(cx), { view: this })))
      .when(isText, (el) => el.child(h_flex().flex_none().gap(2).items_center()
        .child(chip("t3-files-match-case", "Aa", st.matchCase, "Match case", (cx) => {
          st.matchCase = !st.matchCase;
          if (st.query) this.findText(st, st.query, cx); else cx.notify();
        }))
        .child(chip("t3-files-use-regex", ".*", st.useRegex, "Use regular expression", (cx) => {
          st.useRegex = !st.useRegex;
          if (st.query) this.findText(st, st.query, cx); else cx.notify();
        }))))
      .child(h_flex().id("t3-files-search-mode").flex_none().gap(1).p(2).rounded(6).bg(t.raised).items_center()
        .child(chip("t3-files-mode-files", "Files", !isText, "Search file names", (cx) => setMode("files", cx)))
        .child(chip("t3-files-mode-text", "Text", isText, "Search file contents (ripgrep)", (cx) => setMode("text", cx))))
      .child(ghostButton(t, MOD, "t3-files-refresh", "rotate-cw", "Refresh files", (cx) => this.recheck(st, cx), { view: this }))
      .child(foldAllButton(t, MOD, "t3-files-fold-all", st.expanded.size === 0, (cx) => this.foldAll(st, cx), this));
  }

  // Collapse all while any folder is open; else open every folder, Git-ignored ones aside, EXPAND_MAX at most.
  foldAll(st, cx) {
    if (st.expanded.size) { st.expanded.clear(); this.changed(st); cx.notify(); return; }
    const go = this.going(st);
    cx.spawn(async (cx) => {
      const queue = [""];
      for (let n = 0; queue.length && n < EXPAND_MAX && go(); n++) {
        const rel = queue.shift();
        if (!st.entries.has(rel)) await this.list(st, rel);
        if (rel) st.expanded.add(rel);
        for (const e of st.entries.get(rel) ?? []) if (e.dir && !st.ignored.has(join(rel, e.name))) queue.push(join(rel, e.name));
      }
      if (!go()) return;
      this.changed(st);
      cx.notify();
    });
  }

  // The folder's tree, as T3's: a click opens a file or a folder; the keys move a ring, ↵ opens what it's on.
  tree(st, t) {
    if (!st.root || st.error) return div().p(8).text_size(12).text_color(t.dim).child(!st.root ? "This space has no folder." : "");
    if (!st.entries.has("")) return loadingState(t, "t3-files-tree-loading", "Loading files…");
    const rows = this.rows(st);
    if (!rows.length) return div().p(8).text_size(12).text_color(t.dim).child("This folder is empty.");
    const lit = st.lit ? rowAt(rows, st.lit) : -1, ringed = this.treeHandle.is_focused() ? rows.findIndex((r) => r.path === st.focus) : -1;
    const act = (r, cx) => { if (r.dir) this.toggle(st, r.path, cx); else this.open(st, r.path, cx); };
    const draw = (r, i) => {
      const mark = !r.dir && st.marks.get(r.path), open = r.dir && r.open;
      return treeRow(t, MOD, r, `row-${r.path}`, { selected: r.path === st.file || i === lit, focused: i === ringed, status: mark || undefined, dim: r.ignored || r.gone, struck: r.gone,
        drag: { path: join(st.root, r.path), on: st.on },
        trailing: r.dir && !open && st.dirs.has(r.path) ? div().size(6).mr(5).flex_none().rounded_full().bg(t.muted) : null })
        .on_click((_e, cx) => { st.focus = null; act(r, cx); })
        .on_mouse_down("right", () => { this.menuFor = r.path; });
    };
    return div().id("t3-files-tree").size_full().track_focus(this.treeHandle)
      .on_mouse_down("left", () => this.treeHandle.focus())
      .on_key_down((e, cx) => {
        const at = st.focus ? rows.findIndex((r) => r.path === st.focus) : rows.findIndex((r) => r.path === st.file);
        const k = treeKey(e.keystroke, rows, at);
        if (!k) return;
        if (k.at !== undefined) { st.focus = rows[k.at].path; revealRow(this, `t3-files-tree-${st.id}`, st.focus); }
        else { st.focus = (k.toggle ?? k.pick).path; act(k.toggle ?? k.pick, cx); }
        cx.stop_propagation();
        cx.notify();
      })
      .child(treeList(this, `t3-files-tree-${st.id}`, rows, draw).size_full());
  }

  // Search results: the name, then its folder dimmed, matched letters bright; at most 200, and how many more.
  found(st, t) {
    const results = st.results;
    if (!results.length) return div().p(8).text_size(12).text_color(t.dim).child("No matching files.");
    const pieces = (text, from, ranges, color) => {
      const out = [];
      let at = 0;
      for (const [a, b] of ranges) {
        const s = Math.max(a - from, at), e = Math.min(b - from, text.length);
        if (e <= s) continue;
        if (s > at) out.push(div().flex_none().text_color(color).child(text.slice(at, s)));
        out.push(div().flex_none().text_color(t.foreground).font_semibold().child(text.slice(s, e)));
        at = e;
      }
      if (at < text.length) out.push(div().flex_none().text_color(color).child(text.slice(at)));
      return out;
    };
    const draw = (i) => {
      const r = results[i], cut = r.path.lastIndexOf("/") + 1, dir = r.path.slice(0, Math.max(0, cut - 1));
      const loc = parseQueryLocation(st.query);
      const jump = loc.line ? { line: loc.line, col: loc.col } : null;
      return h_flex().id(`found-${i}`).h(TREE_ROW).mx(2).px(6.4).gap(4.8).items_center().rounded(6).text_size(12).overflow_hidden().whitespace_nowrap()
        .when(i === st.at, (el) => el.bg(t.foreground + "1f"))
        .on_hover((on, cx) => { if (on && st.at !== i) { st.at = i; cx.notify(); } })
        .on_click((_e, cx) => this.pick(st, r.path, cx, jump))
        .on_mouse_down("right", () => { this.menuFor = r.path; })
        .child(image(`${MOD}/${fileIcon(r.path, r.path, t)}`).size(16).flex_none())
        .child(h_flex().flex_none().children(pieces(r.path.slice(cut), cut, r.ranges, t.foreground)))
        .when(Boolean(dir), (el) => el.child(h_flex().min_w(0).overflow_hidden().children(pieces(dir, 0, r.ranges, t.dim))));
    };
    const shownAll = !st.more && st.total <= results.length;
    return v_flex().size_full().min_h(0)
      .child(div().flex_1().min_h(0).child(scrollList(this, "t3-files-found", { count: results.length, row: TREE_ROW, at: st.at, draw, wheeled: (keep) => { st.at = keep; } }).size_full()))
      .when(!shownAll, (el) => el.child(div().flex_none().px(8).py(6).text_size(11).text_color(t.dim).truncate()
        .child(`${results.length} of ${count(st.total)}${st.more ? "+" : ""} matches · type more to narrow`)));
  }

  // Full-text ripgrep results: two-line rows with file:line, 1-click @ handoff, and highlighted snippet.
  foundText(st, t) {
    if (st.textLoading && !st.textResults?.length) return loadingState(t, "t3-files-text-loading", "Searching contents…");
    if (st.textError) return div().id("t3-files-text-error").p(10).text_size(12).text_color(t.ansi1).child(st.textError);
    const list = st.textResults ?? [];
    if (!list.length) return div().id("t3-files-text-empty").p(10).text_size(12).text_color(t.dim).child("No matching text.");
    const agent = agentFor(st.id);
    const pieces = (text, ranges) => {
      const out = [];
      let at = 0;
      for (const [a, b] of ranges) {
        const s = Math.max(a, at), e = Math.min(b, text.length);
        if (e <= s) continue;
        if (s > at) out.push(div().flex_none().text_color(t.muted).child(text.slice(at, s)));
        out.push(div().flex_none().text_color(t.foreground).font_semibold().bg(t.accent + "26").rounded(2).child(text.slice(s, e)));
        at = e;
      }
      if (at < text.length) out.push(div().flex_none().text_color(t.muted).child(text.slice(at)));
      return out;
    };
    const TEXT_ROW = 40;
    const draw = (i) => {
      const m = list[i], active = i === st.at;
      return v_flex().id(`text-found-${i}`).h(TEXT_ROW).mx(2).px(8).py(4).gap(2).justify_center().rounded(6).overflow_hidden().cursor_pointer()
        .when(active, (el) => el.bg(t.foreground + "18"))
        .on_hover((on, cx) => { if (on && st.at !== i) { st.at = i; cx.notify(); } })
        .on_click((_e, cx) => this.pickMatch(st, m, cx))
        .on_mouse_down("right", () => { this.menuFor = m.path; })
        .child(h_flex().w_full().min_w(0).gap(5).items_center().text_size(11.5)
          .child(image(`${MOD}/${fileIcon(m.path, m.path, t)}`).size(14).flex_none())
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(`${m.path}:${m.line}`))
          .when(Boolean(active && agent), (el) => el.child(div().id(`text-mention-${i}`).h(16).px(4).flex().items_center().flex_none().rounded(4)
            .text_size(10.5).text_color(t.dim).hover((s) => s.bg(t.foreground + "18").text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); mention(`${m.path}:L${m.line}`, agent.address, cx); })
            .child("@"))))
        .child(h_flex().w_full().min_w(0).pl(19).overflow_hidden().whitespace_nowrap().text_size(11.5).children(pieces(m.snippet, m.ranges)));
    };
    return v_flex().id("t3-files-text-results").size_full().min_h(0)
      .child(div().flex_1().min_h(0).child(scrollList(this, "t3-files-text-found", { count: list.length, row: TEXT_ROW, at: st.at, draw, wheeled: (keep) => { st.at = keep; } }).size_full()))
      .when(Boolean(st.textTruncated), (el) => el.child(div().flex_none().px(8).py(5).text_size(11).text_color(t.dim).truncate()
        .child(`Showing first ${count(list.length)} matches · refine query to narrow`)));
  }

}
