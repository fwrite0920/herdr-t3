// The chat's key bindings in the app's keymap, and keeping them there.
// Uses a single shared polling watcher over keys.json mtime (instead of per-chat
// uncancellable watchFolder() calls that leak host watchers per ADR 0015).

import { appHome } from "herdr";
import * as fs from "fs/promises";
import { bindComposerKeys } from "./composer.js";
import { bindCodeKeys } from "./codeview.js";
import { bindShortcuts } from "./shortcuts.js";

const AFTER_WRITE = [300, 1500];
const POLL_MS = 3000;

let installed = false;
let watching = false;
let lastStamp = null;
let pending = [];

function install(cx) {
  bindComposerKeys(cx);
  bindShortcuts(cx);
  bindCodeKeys(cx);
}

function written(cx) {
  for (const t of pending) t.cancel();
  pending = AFTER_WRITE.map((ms) => cx.timer.after(ms, install, { owner: null }));
}

export function keepKeys(cx) {
  if (!installed) {
    installed = true;
    install(cx);
  }
  if (watching) return;
  watching = true;
  const keysPath = `${appHome().replace(/\\/g, "/").replace(/\/+$/, "")}/keys.json`;
  cx.timer.every(POLL_MS, (c) => {
    c.spawn(async (c) => {
      const st = await fs.stat(keysPath).catch(() => null);
      const stamp = st ? `${st.mtimeMs}` : null;
      if (lastStamp !== null && stamp && stamp !== lastStamp) written(c);
      if (stamp) lastStamp = stamp;
    });
  }, { owner: null });
}
