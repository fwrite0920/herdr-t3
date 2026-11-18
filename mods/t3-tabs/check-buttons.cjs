// The real shared button, rendered at each bar site: clicks, children and platform glyphs survive the migration.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element() {
  const n = { items: [], handlers: {}, style: {}, hoverStyle: {} };
  const p = new Proxy(n, { get: (o, k) => k in o ? o[k] : (...a) => {
    if (k === "child") n.items.push(a[0]);
    else if (k === "children") n.items.push(...a[0]);
    else if (k === "when") { if (a[0]) a[1](p); }
    else if (k === "id") n.key = a[0];
    else if (k === "hover") { const st = element(); a[0](st); n.hoverStyle = st.style; }
    else if (k === "on_mouse_down") n.handlers[a[0]] = a[1];
    else if (k.startsWith("on_")) n.handlers[k] = a[0];
    else n.style[k] = a[0];
    return p;
  } });
  return p;
}
const find = (n, id) => !n || typeof n !== "object" ? null : n.key === id ? n : n.items.map(x => find(x, id)).find(Boolean);
const t = { chrome: "#111111", background: "#222222", dim: "#555555", muted: "#777777", foreground: "#ffffff", hover: "#333333", selected: "#444444" };
const calls = [], space = { id: "s", active: true, tabs: [] }, tab = { id: "b", active: true, named: true, name: "Task" };
let part = { part: "end" }, platform = "windows", panelOpen = false;
const cx = { notify() {}, stop_propagation() {} };
const env = {
  View: class {}, div: element, svg: src => { const e = element(); e.src = src; return e; }, image: element, h_flex: element,
  Popup: { new: (_id, trigger) => element().child(trigger) },
  theme: () => t, props: () => part, settings: () => ({ zoom: 1 }), window: () => ({ platform, buttons: true }),
  spaces: () => [space], agents: () => [], terminals: () => [], panes: () => [], layout: () => ({}), shared: () => null,
  sidebarParts: () => ({ stack: { active: "lists" } }), panelState: () => ({ pages: ["files"], page: "files", open: panelOpen }),
  tip: (_view, _t, _id, _label, el) => el, stop: (_view, _t, _id, el) => el, focusRoot: (_view, el) => el,
  glow: (view, id) => on => { view.hot = on ? id : null; }, within: () => false,
  run: (cmd, args) => calls.push([cmd, args]), newTab: s => calls.push(["new", s.id]), togglePanel: () => calls.push(["panel"]),
  toggleWide: () => calls.push(["wide"]), hidePanel: () => calls.push(["hide"]), updates: () => ({ app: {} }), KEY: {},
  navigation: () => ({ atHome: false, frame: () => ({ tabs: [tab], context: null }) }),
  subAgents: () => () => [], namer: () => p => p.title, programIcon: () => null,
  programOf: () => null, ownStatus: s => s, treeStatus: s => s, projectMark: () => element(), detailsFor() {}, detailsAt() {}, detailsWatch() {},
};
function load(dir) {
  const scope = vm.createContext({ ...env });
  const strip = src => src.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
  vm.runInContext("(() => {\n" + strip(fs.readFileSync(path.join(dir, "button.js"), "utf8")) + "\nglobalThis.drawButton = button; globalThis.radiusOf = radiusOf;\n})();", scope);
  vm.runInContext(fs.readFileSync(path.join(dir, "main.js"), "utf8").replace(/^import .*;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class"), scope);
  return Object.assign(new scope.Mod(), { nameW: {}, strip: 0, pressed: null, over: null, area: 600 });
}
const click = (root, id) => { const el = find(root, id); assert.ok(el, id); el.handlers.on_click({}, cx); return el; };
const tabs = load(__dirname);
let root = tabs.render();
click(root, "tab-new"); click(root, "panel-toggle");
for (const id of ["minimize", "maximize", "close-window"]) {
  const el = click(root, id);
  assert.equal(el.style.h, 28); assert.equal(el.style.w, 28); assert.equal(el.items[0].style.size, 16);
}
assert.deepEqual(calls.splice(0), [["new", "s"], ["panel"], ["window.minimize", undefined], ["window.maximize", undefined], ["window.close", undefined]]);
panelOpen = true;
assert.equal(find(tabs.render(), "panel-toggle").style.bg, t.selected);
platform = "linux";
root = tabs.render();
assert.equal(find(root, "minimize").items[0], "−"); assert.equal(find(root, "maximize").items[0], "□");
const toggle = tabs.sidebarToggle(t, () => {}, [{ status: "done" }], a => a.status);
assert.equal(toggle.style.h, 28); assert.equal(toggle.style.px, 10); assert.equal(toggle.style.gap, 6);
assert.equal(toggle.style.w, undefined); assert.ok(find(toggle, "agents-done"));
assert.equal(tabs.sidebarToggle(t, () => {}, [], a => a.status).style.w, 28, "nothing to count: the 28px square");
click(toggle, "sidebar-toggle");
assert.equal(calls.pop()[0], "layout.toggle");
part = {};
tabs.overTab = "b";
root = tabs.render();
const close = click(root, "close-b");
assert.equal(close.style.h, 16); assert.equal(close.items.length, 1); assert.equal(close.items[0].style.size, 12);
assert.equal(close.hoverStyle.bg, t.raised, "as T3's tab close, bg-muted"); assert.equal(calls.pop()[0], "t3-tabs.close-tab:b");
tabs.overTab = null;
assert.notEqual(find(tabs.render(), "close-b").items[0]?.src, "mods/t3-tabs/icons/x.svg", "the close icon still hides until the tab is hovered");
find(tabs.render(), "tab-b").handlers.middle({}, cx);
assert.equal(calls.pop()[0], "t3-tabs.close-tab:b", "a middle press closes the tab");

// Inbox mode: viewed agent pill (program icon + name) sits left, followed by a rule and the tool strip in a flex-1 tail; + stays in tabs-end.
const origSidebar = env.sidebarParts, origAgents = env.agents, origPanes = env.panes, origNav = env.navigation;
let inboxCtx = { space, tab: "ag", parent: null, heads: ["a1"], head: "a1", sub: null, held: false, away: false, kin: [], programs: [tab] };
env.sidebarParts = () => ({ stack: { active: "inbox" } });
env.agents = () => [{ address: "a1", tab: "ag", pane: "p1", title: "Fix auth", program: { key: "codex", name: "Codex" }, status: "idle" }];
env.panes = () => [{ pane: "p1", tab: "ag", terminal: "a1" }, { pane: "p2", tab: "b", terminal: "sh", title: "pwsh" }];
env.navigation = () => ({ atHome: false, frame: () => ({ tabs: [{ id: "ag", active: true }, tab], context: inboxCtx }) });
part = { part: "end" };
const inboxEnd = load(__dirname);
assert.ok(find(inboxEnd.render(), "tab-new"), "Inbox keeps + in tabs-end since space crumb is gone");
part = {};
const inboxTabs = load(__dirname);
const inboxRoot = inboxTabs.render();
const area = find(inboxRoot, "tab-area");
assert.deepEqual(area.items.map(n => n.key), ["crumb", "crumb-rule", "tab-tail"], "Inbox: agent pill, rule, then tool tail");
assert.equal(find(inboxRoot, "crumb-space"), undefined, "space crumb removed to avoid duplicating pane folder");
assert.equal(find(inboxRoot, "crumb-name-peer-a1").items[0], "Codex", "agent pill shows program name instead of session title");
assert.equal(find(inboxRoot, "crumb").style.flex_grow, undefined, "breadcrumb hugs its content");
assert.ok("flex_1" in find(inboxRoot, "tab-tail").style, "free space stays to the right of tool tabs");
find(inboxRoot, "tab-scroll").handlers.on_size_change({ width: 50 }, cx);
const tight = inboxTabs.render();
assert.deepEqual([find(tight, "tab-strip").style.ml, Boolean(find(tight, "strip-fade-start")), Boolean(find(tight, "strip-fade-end"))], [-0, false, true], "overflow starts at the left and fades the end");
inboxCtx = { space, tab: "ag", parent: null, heads: [], head: null, sub: null, held: false, away: true, kin: [], programs: [tab] };
assert.deepEqual(find(inboxTabs.render(), "tab-area").items.map(n => n.key), ["tab-tail"], "without an agent in context, only the tool tail shows");
env.sidebarParts = origSidebar; env.agents = origAgents; env.panes = origPanes; env.navigation = origNav;

const chrome = load(path.join(__dirname, "../t3-chrome"));
part = { footer: true };
root = chrome.render();
for (const id of ["settings", "t3-settings"]) assert.equal(click(root, id).style.h, 32);
assert.deepEqual(calls.splice(0).map(c => c[0]), ["app.settings", "t3-tabs.settings"]);
part = {};
root = chrome.render();
for (const id of ["sidebar-mode", "sidebar-toggle"]) assert.equal(click(root, id).style.h, 28);
assert.deepEqual(calls.splice(0).map(c => c[0]), ["t3-tabs.sidebar", "layout.toggle"]);
part = { part: "panel" };
root = chrome.render();
for (const id of ["panel-wide", "panel-close"]) assert.equal(click(root, id).style.h, 24);
assert.deepEqual(calls.splice(0), [["wide"], ["hide"]]);
console.log("ok: tab/window/sidebar and chrome buttons use the real helper and preserve their clicks, counts and platform glyphs.");
