// The layout's settings dialog, opened by t3-tabs (`t3-tabs.settings`). Herdr's own Settings copied (frame/settings/main.js):
// its sizes, type and theme colors as they are there, not T3's, so it reads as Herdr's. What it holds is t3.settings (docs/adr/0009).
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Select, Popup } from "gpui-base";
import { theme, props, closeOverlay, run, shared, setShared, appHome, readTextFile, exec } from "herdr";
import * as fs from "fs/promises";
import { SETTINGS, t3Settings, DEFAULT_PANEL_TABS } from "./layout-settings.js";
import { stopsInit, stop, focusRoot } from "./focus.js";
import { menuJump } from "./list.js";

const SECTIONS = [
  { id: "home", title: "Home", icon: "mods/t3-chrome/icons/house.svg" },
  { id: "panel", title: "Space Panel", icon: "mods/t3-chrome/icons/folder-tree.svg" },
];

const ROWS = [
  { key: "afterAway", title: "After putting away", about: "Settling, snoozing or dragging away the agent in view.", options: () => [["home", "Home"], ["next", "Next card"]] },
  { key: "homeMod", title: "Home shows", about: "A terminal, or a mod that offers itself with \"home\": true in its mod.json.", options: (view) => view.homeMods },
];

const PANEL_TABS_CONFIG = [
  { id: "files", title: "Files", about: "Browse workspace files, preview markdown and code.", locked: true },
  { id: "sessions", title: "Sessions", about: "Recent sessions, conversation history and agent resume." },
  { id: "changes", title: "Changes", about: "Git status, staged changes, diffs and commit actions." },
  { id: "favorites", title: "Favorites", about: "Pinned workspaces, directories, and favorite files." },
  { id: "tools", title: "Tools", about: "Explore installed AI skills, plugins, and MCP server tools." },
  { id: "todos", title: "Todos", about: "Project task checklist synchronized with TODO.md and agent actions." },
];

// Home as a shell, not a mod (homeMod null): an agent started there turns that space into an ordinary one (t3-tabs/navigation.js).
const TERMINAL = [null, "Terminal"];

export function initSettings(view, cx) {
  view.keys = cx.focus_handle();
  view.keys.focus();
  stopsInit(view, cx, "modal");
  view.section = props()?.section || view.section || "home";
  view.homeMods = [];
  // The row whose menu is open, and each row's handles: its button's, and its menu's while open.
  view.picking = null;
  view.pickAt = -1;
  view.pick = Object.fromEntries(ROWS.map((r) => [r.key, { focus: cx.focus_handle(), keys: cx.focus_handle() }]));
  findHomeMods(view, cx);
}

// The mods that can be Home: `"home": true` in their mod.json.
// The layout's own page reads Default, as its title is Home's own name; Terminal comes next.
async function findHomeMods(view, cx) {
  const dir = `${appHome()}/mods`;
  const names = (await exec("ls", [dir]).catch(() => null))?.stdout.split("\n").filter(Boolean) ?? (await fs.readdir(dir).catch(() => []));
  const found = (await Promise.all(names.map(async (name) => {
    try { return { name, ...JSON.parse(await readTextFile(`${dir}/${name}/mod.json`) ?? "{}") }; } catch { return null; }
  }))).filter((m) => m?.home);
  view.homeMods = found.map((m) => [m.name, m.name === "t3-home" ? "Default" : m.title ?? m.name]).sort((a, b) => Number(b[0] === "t3-home") - Number(a[0] === "t3-home") || a[1].localeCompare(b[1]));
  view.homeMods.splice(view.homeMods[0]?.[0] === "t3-home" ? 1 : 0, 0, TERMINAL);
  cx.notify();
}

export function settingsView(view) {
  const t = theme(), now = t3Settings(), done = () => closeOverlay(props().overlay);
  const currentSection = view.section || props()?.section || "home";

  // What Home shows changes at once, as the person picking it expects to see.
  const pick = (key, value) => {
    setShared(SETTINGS, { ...shared(SETTINGS), [key]: value });
    if (key === "homeMod") run("t3-tabs.home-mod");
  };

  // Herdr's row: what it is on the left, the control on the right.
  const row = (r) => h_flex().w_full().gap(16).py(12).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(14).text_color(t.foreground).child(r.title))
        .child(div().text_size(12.5).line_height("18px").text_color(t.dim).child(r.about)))
      .child(menu(r));

  // Native toggle row for settings switches
  const toggleRow = (id, title, about, on, onToggle, locked = false) => h_flex()
      .w_full().gap(16).py(12).items_center().border_b(1).border_color(t.border)
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(14).text_color(t.foreground).child(title))
        .child(div().text_size(12.5).line_height("18px").text_color(t.dim).child(about)))
      .child(locked
        ? div().px(8).py(3).rounded(6).bg(t.hover).text_size(11.5).text_color(t.dim).child("Required")
        : div().id(id).w(36).h(20).rounded(10).p(2).cursor_pointer()
            .bg(on ? t.accent : t.hover)
            .flex().items_center()
            .when(on, (el) => el.justify_end())
            .on_click((_e, cx) => { onToggle(); cx.notify(); })
            .child(div().w(16).h(16).rounded(8).bg(on ? t.background : t.muted)));

  // The layout's menu, as the agents list's sort menu, on the kit's Select as the Snooze unit's
  const menu = (r) => {
    const options = r.options(view), id = `st-${r.key}`, label = options.find(([v]) => v === now[r.key])?.[1] ?? now[r.key];
    const { focus, keys } = view.pick[r.key], open = view.picking === r.key;
    const show = (on) => { view.picking = on ? r.key : null; view.pickAt = -1; };
    const choose = (value) => {
      show(false);
      focus.focus();
      if (value !== now[r.key]) pick(r.key, value);
    };
    const trigger = stop(view, t, id, h_flex().id(id).w_full().h(32).px(11).gap(8).rounded(8).border_1().border_color(t.border).bg(t.raised).items_center().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_hover((on) => { view.overPick = on ? r.key : null; })
      .role("button").accessibility_label(`${r.title}: ${label}`)
      .on_click((_e, cx) => {
        show(!open);
        (open ? focus : keys).focus();
        cx.notify();
      })
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).text_color(t.foreground).child(label))
      .child(svg("mods/t3-chrome/icons/chevron-down.svg").size(14).mr(-4).flex_none().text_color(t.muted)), 8, { handle: focus });
    const list = v_flex().id(`${id}-menu`).w(220).mt(4).p(4).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg().text_size(14)
      .track_focus(keys)
      .on_mouse_down_out((_e, cx) => { if (view.overPick !== r.key) { show(false); cx.notify(); } })
      .on_key_down((e, cx) => {
        if (e.key === "enter" || e.key === "space") { if (view.pickAt >= 0) choose(options[view.pickAt][0]); }
        else if (e.key === "escape") { show(false); focus.focus(); }
        else {
          const to = menuJump(view, e, options.map(([, l]) => l), view.pickAt);
          if (to < 0) return;
          view.pickAt = to;
        }
        cx.stop_propagation();
        cx.notify();
      })
      .children(options.map(([value, name], i) => h_flex().id(`${id}-${value ?? "terminal"}`).h(28).px(8).gap(8).rounded(4).items_center().text_color(t.foreground)
        .when(i === view.pickAt, (el) => el.bg(t.selected))
        .on_hover((over, cx) => { if (over && view.pickAt !== i) { view.pickAt = i; cx.notify(); } })
        .role("list_box_option").aria_selected(value === now[r.key]).accessibility_label(name)
        .on_click((_e, cx) => { choose(value); cx.notify(); })
        .child(div().flex_1().min_w(0).truncate().child(name))
        .when(value === now[r.key], (el) => el.child(svg("mods/t3-chrome/icons/check.svg").size(14).flex_none().text_color(t.foreground)))));
    return Select.new(id).w(220).flex_none().accessibility_label(r.title).open(open).track_focus(focus).content_focus_handle(keys)
      .on_open_change((on, cx) => { show(on); cx.notify(); })
      .child(Popup.new(`${id}-popup`, trigger).w_full().when(open, (el) => el.content(list)));
  };

  const nav = v_flex().flex_none().w(190).h_full().p(10).gap(2).border_r(1).border_color(t.border)
    .child(div().px(10).pt(6).pb(12).text_size(16).font_semibold().text_color(t.foreground).child("Herdr T3"))
    .children(SECTIONS.map((s) => {
      const active = currentSection === s.id;
      return h_flex().id(`st-s-${s.id}`).gap(10).px(10).py(7).items_center().rounded(7).cursor_pointer()
        .when(active, (el) => el.bg(t.raised).border_1().border_color(t.border))
        .when(!active, (el) => el.hover((st) => st.bg(t.hover)))
        .on_click((_e, cx) => {
          view.section = s.id;
          view.picking = null;
          cx.notify();
        })
        .child(svg(s.icon).size(15).text_color(active ? t.accent : t.muted))
        .child(div().flex_1().text_size(13.5).text_color(active ? t.foreground : t.dim).child(s.title));
    }));

  const homeContent = div().flex_1().min_w(0).h_full().px(28).py(22).overflow_y_scrollbar()
    .child(div().pt(6).pb(8).text_size(12).font_semibold().text_color(t.dim).child("HOME"))
    .children(ROWS.map(row));

  const panelContent = div().flex_1().min_w(0).h_full().px(28).py(22).overflow_y_scrollbar()
    .child(div().pt(6).pb(4).text_size(12).font_semibold().text_color(t.dim).child("SPACE PANEL TABS"))
    .child(div().pb(10).text_size(12.5).line_height("18px").text_color(t.dim).child("Configure which tabs appear in the Space Panel. Default shows core tabs; others can be turned on as needed."))
    .children(PANEL_TABS_CONFIG.map((item) => {
      const tabs = now.panelTabs ?? DEFAULT_PANEL_TABS;
      const on = item.locked ? true : Boolean(tabs[item.id]);
      return toggleRow(`st-tab-${item.id}`, item.title, item.about, on, () => {
        const nextTabs = { ...DEFAULT_PANEL_TABS, ...tabs, [item.id]: !on };
        pick("panelTabs", nextTabs);
      }, item.locked);
    }))
    .child(div().pt(18).pb(4).text_size(12).font_semibold().text_color(t.dim).child("DEVELOPER FEATURES"))
    .child(toggleRow("st-live-ports", "Live Dev Ports", "Detect listening localhost dev server ports (3000, 5173...) and show 1-click browser badges in the panel header.", Boolean(now.livePorts !== false), () => {
      pick("livePorts", !Boolean(now.livePorts !== false));
    }));

  return focusRoot(view, h_flex().id("settings").track_focus(view.keys).w_full().h(620).min_h(0).items_start()
    .on_key_down((e, cx) => {
      if (e.key !== "escape") return;
      done();
      cx.stop_propagation();
    })
    .child(nav)
    .child(currentSection === "panel" ? panelContent : homeContent));
}
