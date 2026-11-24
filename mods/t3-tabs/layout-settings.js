// The layout's own settings (docs/adr/0009): one key in shared.json, written by t3-chrome's dialog and read where each acts,
// every time, so a change holds at once and an update never touches it. scripts/sync.sh copies this to the mods that use it.
import { shared } from "herdr";
import { KEY } from "./store.js";

export const SETTINGS = KEY.settings;

export const DEFAULT_PANEL_TABS = {
  files: true,
  sessions: true,
  changes: true,
  tools: false
};

// afterAway: where putting away the agent in view lands, "home" or "next" (card). homeMod: the mod Home is, by its folder's name; null, a terminal.
const DEFAULTS = {
  afterAway: "home",
  homeMod: "t3-home",
  livePorts: true,
  panelTabs: DEFAULT_PANEL_TABS
};

export const t3Settings = () => {
  const current = shared(SETTINGS) ?? {};
  return {
    ...DEFAULTS,
    ...current,
    panelTabs: { ...DEFAULT_PANEL_TABS, ...(current.panelTabs ?? {}) }
  };
};
