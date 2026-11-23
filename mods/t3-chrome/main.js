import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, props, updates, layout, shared, spaces, window, settings, appHome, readTextFile, writeTextFile, notify, exec } from "herdr";
import { tip, glow } from "./tip.js";
import { stopsInit, stopsEnd, stop, focusRoot } from "./focus.js";
import { sidebarParts } from "./sidebar.js";
import { initSettings, settingsView } from "./settings.js";
import { KEY } from "./store.js";
import { panelState, showPage, hidePanel, toggleWide } from "./panel.js";
import { button as drawButton, radiusOf } from "./button.js";
import { t3Settings } from "./layout-settings.js";

// The space panel's pages (docs/adr/0011), as its stack has them: a page the layout lacks has no tab.
// Review wears pulls.review's own mark, as the Review bar does: a review, not a git command. In its colors, so an image.
const PAGES = {
  files: ["Files", "folder-tree"],
  sessions: ["Sessions", "clock"],
  favorites: ["Favorites", "star"],
  changes: ["Changes", "git-commit"],
  tools: ["Tools", "wrench"],
  review: ["Review", "pulls-review", true]
};

const currentSettings = () => {
  try {
    return typeof t3Settings === "function" ? t3Settings() : (shared(KEY?.settings) ?? {});
  } catch {
    return {};
  }
};

// The sidebar shows either Lists (Spaces and Agents) or the Inbox (t3-inbox): a stack in the layout.
const inboxShown = () => sidebarParts(layout()).stack?.active === "inbox";
export default class WorkspaceChrome extends View {
  async close() {
    this.portTimer?.cancel();
    this.lightTimer?.cancel();
    stopsEnd(this);
  }

  init(_props, cx) {
    if (props()?.view === "settings") return initSettings(this, cx);
    stopsInit(this, cx);
    if (props()?.part === "panel") {
      this.ports = [];
      this.tabScroll = 0;
      this.wasOpen = false;
      this.scanPorts(cx);
      this.portTimer = cx.timer.every(6000, (cx) => this.scanPorts(cx));
    }
    if (!props()?.footer && !props()?.part && window()?.platform === "macos") {
      this.alignLights(cx);
      // The brand copy stays alive with the sidebar hidden; no redraw is needed until a zoom actually changes the file.
      this.lightTimer = cx.timer.every(250, cx => this.alignLights(cx));
    }
  }

  scanPorts(cx) {
    if (currentSettings().livePorts === false) {
      if (this.ports?.length) { this.ports = []; cx.notify(); }
      return;
    }
    if (!panelState().open || window()?.active === false) return;
    cx.spawn(async (cx) => {
      try {
        const plat = window()?.platform;
        let out = "";
        if (plat === "windows") {
          const res = await exec("netstat", ["-ano", "-p", "tcp"]).catch(() => null);
          out = res?.stdout ?? "";
        } else {
          const res = await exec("lsof", ["-iTCP", "-sTCP:LISTEN", "-n", "-P"]).catch(() => null);
          out = res?.stdout ?? "";
        }
        if (!out) return;
        const DEV_COMMON = new Set([
          3000, 3001, 3002, 3003, 3004, 3005, 4000, 4173, 4200, 4321, 5000, 5001,
          5173, 5174, 5175, 5176, 8000, 8001, 8080, 8081, 8088, 8888, 9000, 9001
        ]);
        const found = new Map();
        for (const line of out.split("\n")) {
          if (!line.includes("LISTEN")) continue;
          const m = line.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|:::?):(\d+)\s/);
          if (m) {
            const p = parseInt(m[1], 10);
            if (DEV_COMMON.has(p) || (p >= 3000 && p <= 3010) || (p >= 5170 && p <= 5180) || (p >= 8080 && p <= 8090)) {
              if (plat === "windows") {
                const pid = line.trim().split(/\s+/).pop();
                if (!found.has(p)) found.set(p, { pid, name: "" });
              } else {
                const name = line.trim().split(/\s+/)[0] || "";
                if (!found.has(p)) found.set(p, { pid: "", name });
              }
            }
          }
        }
        if (plat === "windows" && found.size) {
          const tl = await exec("tasklist", ["/FO", "CSV", "/NH"]).catch(() => null);
          if (tl?.stdout) {
            const pidMap = new Map();
            for (const row of tl.stdout.split(/\r?\n/)) {
              const cols = row.match(/^"([^"]+)","(\d+)"/);
              if (cols) pidMap.set(cols[2], cols[1].replace(/\.exe$/i, ""));
            }
            for (const info of found.values()) {
              if (info.pid && pidMap.has(info.pid)) info.name = pidMap.get(info.pid);
            }
          }
        }
        const list = Array.from(found.entries()).sort((a, b) => a[0] - b[0]).map(([port, info]) => ({ port, name: info.name }));
        if (JSON.stringify(list) !== JSON.stringify(this.ports)) {
          this.ports = list;
          cx.notify();
        }
      } catch {}
    });
  }

  alignLights(cx) {
    if (shared("layout") !== "herdr-t3") return;
    const root = /** @type {any} */ (layout()), w = window(), zoom = Number(settings().zoom) || 1;
    if (w?.platform !== "macos" || w.fullscreen || root?.titlebar !== "none" || !root.traffic_lights || this.lightsWriting) return;
    // Once per zoom and layout value: an update that rewrites the layout is aligned again, a failure isn't retried.
    const seen = `${zoom}:${root.traffic_lights[1]}`;
    if (this.lightsSeen === seen) return;
    this.lightsSeen = seen;
    // Native buttons are unzoomed, centered 8px below y; the brand row's center is 20 logical px.
    const y = Math.round((12 + 20 * (zoom - 1)) * 1000) / 1000;
    if (root.traffic_lights[1] === y) return;
    this.lightsWriting = true;
    cx.spawn(async () => {
      try {
        const file = `${appHome()}/layouts/herdr-t3.json`, before = await readTextFile(file);
        if (before === null) throw new Error("Couldn't read the layout file.");
        const saved = JSON.parse(before);
        if (saved.titlebar !== "none" || !saved.traffic_lights || saved.traffic_lights[1] === y) return;
        saved.traffic_lights = [saved.traffic_lights[0], y];
        const after = before.replace(/("traffic_lights"\s*:\s*)\[[^\]]*\]/, (_match, key) => key + JSON.stringify(saved.traffic_lights));
        if (JSON.stringify(JSON.parse(after)) !== JSON.stringify(saved)) throw new Error("Couldn't locate the layout's window buttons.");
        await writeTextFile(file, after, before);
      } catch (e) {
        notify({ title: "Couldn't align the window buttons", body: String(e), level: "error" });
      } finally { this.lightsWriting = false; }
    });
  }

  render(cx) {
    if (props()?.view === "settings") return settingsView(this);
    const t = theme();
    if (props()?.part === "panel") return this.panelHead(t, cx);
    if (props()?.footer) {
      // As T3's footer: a row of 32px icon buttons, and at its end, once Herdr has downloaded an update, its restart.
      const ready = updates().app.ready;
      // T3's undo notice, the inbox's (t3-inbox.notice), in this row's free space so it covers nothing: "Settled," or
      // "Settled 2," then Undo, which the inbox does. It fades in and out over 200ms, Undo inert while it goes. One older than
      // its 5s and the fade is left from before a restart.
      const n = shared(KEY.notice);
      // Short of room the summary is cut, never Undo: GPUI's flex doesn't do T3's two wraps, which squeezed Undo to nothing.
      const notice = n && Date.now() - n.at < 6000 && h_flex().id(`undo-notice-${n.gen}`).flex_1().min_w(0).h(24).justify_end().gap(4).items_center()
        .text_size(11).text_color(t.dim).opacity(n.shown ? 1 : 0).transition("opacity", { duration: 200, easing: "ease-out" })
        .child(div().min_w(0).truncate().child(`${n.action}${n.count === 1 ? "" : ` ${n.count}`},`))
        // As T3's InlineButton: medium, foreground, underlined on hover.
        .child(h_flex().id("undo-notice-undo").flex_none().h(24).items_center().font_medium().text_color(t.foreground)
          .when(n.live && Date.now() - n.at < 5000, (el) => el.hover((s) => s.underline()).role("button").accessibility_label(`Undo: ${n.action} ${n.count} agent${n.count === 1 ? "" : "s"}`)
            .on_click(() => run("t3-tabs.undo")))
          .child("Undo")
          .when(n.live && Date.now() - n.at < 5000, (el) => stop(this, t, "undo-notice-undo", el, 4)));
      const button = (id, icon, label, action, key) => tip(this, t, id, label, stop(this, t, id, drawButton(t, id, { size: "default", icon, label, hot: this.hot === id })
        .on_hover(glow(this, id))
        // Each opens over its button, before the pointer can report leaving it.
        .on_click((_e, cx) => { this.hot = null; action(); cx.notify(); }), radiusOf("default")), { action: key });
      // T3's footer: 8 in and 4 above its row, whatever height the layout gives the block.
      return focusRoot(this, div().size_full().bg(t.chrome).px(8).pt(4).child(h_flex().h(32).gap(4).items_center()
        .child(button("settings", "mods/t3-chrome/icons/settings.svg", "Settings", () => run("app.settings"), "app.settings"))
        .child(button("t3-settings", "mods/t3-chrome/icons/sliders-horizontal.svg", "Herdr T3 settings", () => run("t3-tabs.settings"), "t3-tabs.settings"))
        .child(notice || div().flex_1())
        .when(Boolean(ready), el => el.child(tip(this, t, "app-update", `Update ${ready} downloaded. Click to restart`, stop(this, t, "app-update", div().id("app-update").h(32).px(12).flex_none().flex().items_center()
          .rounded_full().bg(t.accent + "26").text_size(12).text_color(t.accent).hover(s => s.bg(t.accent + "40")).on_hover(glow(this, "app-update"))
          .role("button").accessibility_label(`Restart into Herdr ${ready}`)
          .on_click(() => run("app.update")).child("Update"), 16))))));
    }
    // Room for the macOS window buttons (layout traffic_lights), a place to drag the window, and the
    // sidebar toggle at its right edge; while the sidebar is hidden, t3-tabs shows it after the buttons.
    const inbox = inboxShown(), w = window();
    // Herdr's mark and name where its own layout has them, past the macOS window buttons; a click goes Home, which has no
    // button of its own. Its colours are louder than anything else here, so it waits at 70% and its name is muted, both lit
    // on hover, with no background behind them. As T3's, no tooltip. The window buttons are screen points, unzoomed: the last ends at 68
    // (traffic_lights x 16, three 12s 8 apart), and the logo's tile shows 16pt from it, less the PNG's 2 of clear edge and
    // this button's 6 in. Short of room the name gives way whole, never cut to "Her…", and never the buttons.
    const zoom = settings().zoom || 1, left = w?.platform === "macos" && !w?.fullscreen ? (68 + 16 - 2) / zoom - 6 : 8, on = this.hot === "home"
      // Lit at Home too: its tab bar is empty and its panes may be anyone's, so this says where you are.
      || spaces().some((s) => s.active && s.id === shared(KEY.home));
    // What the name has past the left inset: less the 8 at the right, two 28px buttons, this button's 6 each side, the 20px logo and 8 gap.
    const named = !this.brandW || this.brandW - left - 8 - 56 - 12 - 20 - 8 >= (this.nameW || 0);
    return focusRoot(this, h_flex().id("brand").size_full().bg(t.chrome).pl(left).pr(8).items_center()
      .on_size_change((size, cx) => { this.brandW = size.width / zoom; cx.notify(); })
      .child(stop(this, t, "home", h_flex().id("home").h(28).min_w(0).px(6).gap(8).items_center().rounded(8)
        .text_size(14).font_medium().text_color(on ? t.foreground : t.muted).on_hover(glow(this, "home"))
        .role("button").accessibility_label("Home")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("t3-tabs.home"))
        .child(image("frame/welcome/herdr.png").size(20).flex_none().rounded(5).opacity(on ? 1 : 0.7))
        .when(named, el => el.child(div().id("home-name").flex_none().child("Herdr")
          .on_size_change((size, cx) => { this.nameW = size.width / zoom; cx.notify(); }))), 8))
      .child(div().flex_1())
      // T3's 28px title bar buttons, side by side instead of its 12 apart, so each stands over a button of the list's top row below.
      // The mode a click shows: a tray for the Inbox, rows with their marks for the lists.
      .child(tip(this, t, "sidebar-mode", inbox ? "Show lists" : "Show inbox", stop(this, t, "sidebar-mode", drawButton(t, "sidebar-mode", {
        size: "sm", icon: `mods/t3-chrome/icons/${inbox ? "layout-list" : "inbox"}.svg`, label: inbox ? "Show lists" : "Show inbox", hot: this.hot === "sidebar-mode" })
        .on_hover(glow(this, "sidebar-mode"))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("t3-tabs.sidebar")), radiusOf("sm")), { action: "t3-tabs.sidebar", below: true }))
      .child(tip(this, t, "sidebar-toggle", "Hide sidebar", stop(this, t, "sidebar-toggle", drawButton(t, "sidebar-toggle", {
        size: "sm", icon: "mods/t3-chrome/icons/panel-left.svg", label: "Hide sidebar", hot: this.hot === "sidebar-toggle" })
        .on_hover(glow(this, "sidebar-toggle"))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        // It goes with the sidebar, before the pointer can report leaving it.
        .on_click(() => { this.hot = null; run("layout.toggle", { id: "sidebar" }); }), radiusOf("sm")), { action: "layout.toggle:sidebar", below: true })));
  }

  // The space panel's top: its pages as T3's panel tabs (28px, 12px words), then widen and close as 24px icon buttons.
  // Tabs sit inside a scrollable clipped strip so narrow panels never push Expand/Close (or wide-mode window buttons) off-screen.
  panelHead(t, cx) {
    const s = panelState(), space = spaces().find(p => p.active), w = window();
    const cfg = currentSettings();
    const tabsConfig = cfg.panelTabs ?? {};
    const visiblePages = s.pages.filter(id => id === "files" || id === "review" || tabsConfig[id]);
    if (s.open && s.page && !visiblePages.includes(s.page) && cx?.timer) {
      cx.timer.after(0, () => showPage(visiblePages[0] ?? "files"));
    }
    if (s.open && !this.wasOpen && cx?.timer) {
      this.wasOpen = true;
      cx.timer.after(0, (c) => this.scanPorts(c));
    } else if (!s.open && this.wasOpen) {
      this.wasOpen = false;
    }
    // Review's run for this space, marked as a tab's agent is: what was news in a pane's card before (docs/adr/0011).
    const word = space && shared("review.status")?.[space.id];
    const mark = word === "working" ? svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
      : word === "blocked" ? div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(11).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!")
      : word === "done" ? div().size(6).flex_none().rounded_full().bg(t.done) : null;
    const own = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const page = (id) => {
      const [label, icon, colored] = PAGES[id] ?? [id, "folder-tree"], on = s.page === id, key = `page-${id}`;
      return stop(this, t, key, own(h_flex().id(key).h(28).pl(8).pr(10).gap(6).flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
        .border_1().border_color(on ? t.foreground + "1a" : t.chrome)
        .bg(on ? t.raised : t.chrome).text_color(on || this.hot === key ? t.foreground : t.dim)
        .when(on, el => el.font_medium())
        .when(!on, el => el.hover(st => st.bg(t.hover).border_color(t.hover))).on_hover(glow(this, key))
        .role("tab").aria_selected(on).accessibility_label(label)
        .on_click(() => showPage(id))
        // A colored mark waits at 70% until its tab is shown or hovered, as the brand bar's Herdr mark.
        .child(colored ? image(`mods/t3-chrome/icons/${icon}.svg`).size(14).flex_none().opacity(on || this.hot === key ? 1 : 0.7)
          : svg(`mods/t3-chrome/icons/${icon}.svg`).size(14).flex_none())
        .child(label)
        .when(id === "review" && mark != null, el => el.child(mark))), 6);
    };
    /** @param {"xs" | "sm"} [size] */
    const button = (id, icon, label, action, key = undefined, size = "xs", glyph = undefined) => tip(this, t, id, label, stop(this, t, id, own(drawButton(t, id, {
      size, icon: icon ? `mods/t3-chrome/icons/${icon}.svg` : undefined, label, hot: this.hot === id })
      .on_hover(glow(this, id))
      .on_click((_e, cx) => { this.hot = null; action(); cx.notify(); })
      .when(Boolean(glyph), el => el.child(glyph))), radiusOf(size)), { action: key, below: true });
    const zoom = Number(settings()?.zoom) || 1;
    const maxScroll = Math.max(0, (this.tabsStripW ?? 0) - (this.tabsBoxW ?? 0));
    const scrollAt = Math.max(0, Math.min(this.tabScroll ?? 0, maxScroll));
    this.tabScroll = scrollAt;
    const fade = (id, start) => h_flex().id(id).absolute().top(0).bottom(0).w(12).when(start, el => el.left(0)).when(!start, el => el.right(0))
      .children((start ? ["ff", "b0", "60"] : ["60", "b0", "ff"]).map(a => div().w(4).h_full().bg(/** @type {any} */ (t.chrome + a))));
    const sidebarHidden = Boolean(s.wide && sidebarParts(layout()).rail?.hidden);
    const shownPorts = (cfg.livePorts !== false && this.ports?.length) ? this.ports.slice(0, 3) : [];
    const extraPorts = Math.max(0, (this.ports?.length ?? 0) - shownPorts.length);
    return focusRoot(this, h_flex().id("panel-head").size_full().min_w(0).bg(t.chrome).gap(4).items_center()
      .when(sidebarHidden, el => el.child(button("panel-sidebar-toggle", "panel-left", "Show sidebar", () => run("layout.toggle", { id: "sidebar" }), "layout.toggle:sidebar", "sm")))
      .child(h_flex().id("panel-tabs-scroll").relative().flex_1().min_w(0).h_full().items_center().overflow_hidden()
        .on_size_change((size, cx) => { const wPx = size.width / zoom; if (Math.abs((this.tabsBoxW ?? 0) - wPx) > 0.5) { this.tabsBoxW = wPx; cx.notify(); } })
        .on_scroll_wheel((e, cx) => {
          if (maxScroll <= 0) return;
          const d = (Math.abs(e.delta.x) > Math.abs(e.delta.y) ? e.delta.x : e.delta.y) / zoom;
          this.tabScroll = Math.max(0, Math.min((this.tabScroll ?? 0) - d, maxScroll));
          cx.notify();
        })
        .child(h_flex().id("panel-tabs-strip").flex_none().h_full().gap(4).items_center().ml(-scrollAt)
          .on_size_change((size, cx) => { const wPx = size.width / zoom; if (Math.abs((this.tabsStripW ?? 0) - wPx) > 0.5) { this.tabsStripW = wPx; cx.notify(); } })
          .children(visiblePages.map(page)))
        .when(scrollAt > 0.5, el => el.child(fade("panel-fade-start", true)))
        .when(scrollAt < maxScroll - 0.5, el => el.child(fade("panel-fade-end", false))))
      .when(shownPorts.length > 0, (el) => el.child(
        h_flex().flex_none().gap(4).items_center().mr(4)
          .children(shownPorts.map((entry) => {
            const port = typeof entry === "object" ? entry.port : entry;
            const proc = typeof entry === "object" ? entry.name : "";
            const key = `port-${port}`, url = `http://localhost:${port}`;
            return tip(this, t, key, `${proc ? `${proc} · ` : ""}Open in browser`,
              stop(this, t, key, own(h_flex().id(key).h(22).px(6).gap(4).flex_none().items_center().rounded(6).bg(t.raised).cursor_pointer()
                .hover(st => st.bg(t.hover)).on_hover(glow(this, key))
                .role("button").accessibility_label(`Open ${url}`)
                .on_click((_e, cx) => {
                  const plat = window()?.platform;
                  if (plat === "windows") exec("rundll32", ["url.dll,FileProtocolHandler", url]).catch(() => null);
                  else exec(plat === "macos" ? "open" : "xdg-open", [url]).catch(() => null);
                  cx.notify();
                })
                .child(div().size(6).rounded_full().bg(t.done))
                .child(div().text_size(11).font_medium().text_color(t.foreground).child(`:${port}`))),
              6), { hint: url, below: true });
          }))
          .when(extraPorts > 0, (pEl) => pEl.child(div().px(5).h(22).flex().items_center().rounded(6).bg(t.raised).text_size(11).text_color(t.muted).child(`+${extraPorts}`)))
      ))
      .child(button("panel-wide", s.wide ? "minimize-2" : "maximize-2", s.wide ? "Restore panel" : "Expand panel", toggleWide))
      .child(button("panel-close", "x", "Close panel", hidePanel, "t3-tabs.panel"))
      // In wide mode `work` (and `tabs-end`) is hidden, so surface native window buttons here on Windows/Linux.
      .when(Boolean(s.wide && w?.buttons), el => el
        .child(button("panel-minimize", w.platform === "windows" ? "win-min" : undefined, "Minimize", () => run("window.minimize"), undefined, "sm", w.platform === "windows" ? undefined : "−"))
        .child(button("panel-maximize", w.platform === "windows" ? (w.maximized ? "win-restore" : "win-max") : undefined, w.maximized ? "Restore" : "Maximize", () => run("window.maximize"), undefined, "sm", w.platform === "windows" ? undefined : "□"))
        .child(button("panel-close-window", w.platform === "windows" ? "win-close" : "x", "Close window", () => run("window.close"), undefined, "sm"))));
  }
}
