// Catppuccin's file and folder icons (catppuccin/vscode-icons), matched in VS Code's order: the name with its folder
// (`workflows/ci.yml`), the name, the longest extension, then the plain file. Case doesn't count. scripts/vendor.sh makes
// the data, dark icons/cat/ and light icons/cat-light/; scripts/sync.sh copies them to the mods that draw file icons.
// Each returns a path in the mod's own folder: draw it with image(`mods/<mod>/${fileIcon(...)}`).
import { FILE_NAMES, FILE_EXTENSIONS, FOLDER_NAMES } from "./file-icons-data.js";

function isLight(t) {
  const hex = /^#([0-9a-f]{6})/i.exec(t?.background ?? "");
  if (!hex) return false;
  const n = parseInt(hex[1], 16);
  return (n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114 >= 128;
}

const dirOf = (t) => isLight(t) ? "icons/cat-light" : "icons/cat";

/** @param {string} name a file's name, or its path @param {string} [path] its path, for the folder a match may name @param {any} [t] theme (picks light icons on light backgrounds) */
export function fileIcon(name, path = name, t = null) {
  const base = name.split("/").pop().toLowerCase(), parent = path.toLowerCase().split("/").slice(-2, -1)[0];
  // Own keys only: a file called `constructor` isn't Object's.
  const own = (table, key) => Object.hasOwn(table, key) ? table[key] : undefined;
  const look = (table, key) => (parent ? own(table, `${parent}/${key}`) : undefined) ?? own(table, key);
  let icon = look(FILE_NAMES, base);
  const parts = base.split(".");
  for (let i = 1; !icon && i < parts.length; i++) icon = look(FILE_EXTENSIONS, parts.slice(i).join("."));
  return `${dirOf(t)}/${icon ?? "_file"}.svg`;
}

// A chain of folders (`packages/cli/src`) is named by its last.
/** @param {string} name @param {boolean} [open] @param {any} [t] theme (picks light icons on light backgrounds) */
export function folderIcon(name, open = false, t = null) {
  const base = name.split("/").pop().toLowerCase();
  return `${dirOf(t)}/${Object.hasOwn(FOLDER_NAMES, base) ? FOLDER_NAMES[base] : "_folder"}${open ? "_open" : ""}.svg`;
}
