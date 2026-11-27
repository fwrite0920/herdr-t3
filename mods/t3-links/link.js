// Cmd-click / Ctrl-click on a file path in a terminal opens that file in Herdr T3's Files space panel
// and jumps to the referenced line/column (e.g. src/app.ts:42:7, src/app.ts(42,7), src/app.ts#L42).
// Unsupported binaries, directories, missing files and paths outside the space's root pass through to Herdr.
import { spaces, panes, home, exec, run, setShared } from "herdr";
import * as fs from "fs/promises";
import { KEY } from "./store.js";
import { BINARY, parseLinkPlace, resolveLinkPath, resolveSpaceRoot, relativeToRoot } from "./parser.js";

const CHECK_TIMEOUT = 5000;

async function isRegularFile(path, machine) {
  if (machine) {
    try {
      const r = await exec("test", ["-f", path], { on: machine, timeout: CHECK_TIMEOUT });
      return r.code === 0;
    } catch { return false; }
  }
  try {
    const st = await fs.stat(path);
    return Boolean(st?.isFile?.());
  } catch { return false; }
}

/** @param {import("herdr").LinkClick} click */
export async function handleLink({ link, source }) {
  if (link.kind !== "file" || !source?.tab) return "pass";
  const own = parseLinkPlace(link.raw);
  const line = link.line ?? own.line;
  const col = link.line ? (link.column ?? null) : own.col;
  const filePath = resolveLinkPath(link, source, own.rest);
  if (!filePath || BINARY.test(filePath)) return "pass";

  const on = source.machine ?? null;
  if (!await isRegularFile(filePath, on)) return "pass";

  const all = spaces();
  const sp = all.find((s) => s.id === source.space) ?? all.find((s) => s.tabs.some((t) => t.id === source.tab));
  if (!sp) return "pass";

  const root = resolveSpaceRoot(sp, panes(), source, home());
  const rel = relativeToRoot(filePath, root);
  if (!rel) return "pass";

  if (!sp.active) run("space.select", { id: sp.id });
  setShared(KEY.filesOpen, { space: sp.id, path: rel, line, col, at: Date.now() });
  run("layout.select", { stack: "panel-body", child: "files" });
  run("layout.show", { id: "panel" });
  return "handled";
}
