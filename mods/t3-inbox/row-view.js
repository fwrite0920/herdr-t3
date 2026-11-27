import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Popup } from "gpui-base";
import { settings, props, home } from "herdr";
import { namer } from "./name.js";
import { projectMark } from "./project.js";
import { glow, tip, tipMark, keyOf } from "./tip.js";
import { MOTION } from "./motion.js";
import { detailsLive, detailsFor, detailsLine, detailsCard } from "./details.js";
import { programIcon } from "./program.js";
import { stop, within } from "./focus.js";
import { snoozeButton } from "./snooze.js";
import { SLIM } from "./list-view.js";
import { openMenu } from "./menu.js";

// The settle key: the layout's tab bar holds it; a standalone Inbox, its own command.
const settleKey = () => keyOf("t3-tabs.settle") ? "t3-tabs.settle" : "t3-inbox.settle";

// As T3's sidebar times: no "ago", nothing past days.
function ago(ms, now) {
  const m = Math.floor((now - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

// How long it's been working, as T3's Working pill: 9s, 4m, 1h 5m.
function took(ms, now) {
  const s = Math.max(0, Math.floor((now - ms) / 1000)), m = Math.floor(s / 60);
  return s < 60 ? `${s}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Time left on a snooze, rounded up as T3's: 10m, 3h, 2d.
function left(ms, now) {
  const m = Math.max(1, Math.ceil((ms - now) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.ceil(m / 60)}h` : `${Math.ceil(m / 1440)}d`;
}

// Last path segment of a pane's live working directory (or `~` for the local home directory).
function folderName(cwd, remote) {
  if (!cwd) return "";
  const s = String(cwd).replace(/\\/g, "/");
  if (s === "~" || s === "/") return s;
  if (/^[a-zA-Z]:\/?$/.test(s)) return s.slice(0, 2);
  const clean = s.replace(/\/+$/, "");
  if (!remote && typeof home === "function") {
    const h = String(home() ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (h && clean.toLowerCase() === h.toLowerCase()) return "~";
  }
  const cut = clean.lastIndexOf("/");
  return cut >= 0 ? clean.slice(cut + 1) : clean;
}

// Strip redundant leading `π ` / `π > ` from Pi/OMP terminal titles when the card already shows the program icon.
function cleanTitle(a, raw) {
  const text = String(raw ?? "");
  const key = String(a?.program?.key ?? "").toLowerCase();
  const name = String(a?.program?.name ?? "").toLowerCase();
  if (key !== "pi" && key !== "omp" && name !== "pi" && name !== "omp") return text;
  const stripped = text.replace(/^π\s*(?:[->]\s*)?/, "").trim();
  return stripped || text;
}

export function inboxRowView(view, t, model, actions, drag) {
  const { now, ps, sp, term, state, viewing, running, woke, busy, pins, started, since, wake, hidden, napUntil, settledAt } = model;
  const { settle, unsettle, away, pick } = actions;
  const { dragging, plan, verb, badge, swept, row, open, sweepFrom, justDropped } = drag;
  const zoom = Number(settings()?.zoom) || 1;
  const rawTitle = namer();
  const title = (a) => cleanTitle(a, rawTitle(a));
  const hover = (a) => (on, cx) => {
    if (on) { view.hovered = a.address; detailsFor(view, a.address, cx); }
    else if (view.hovered === a.address) { view.hovered = null; detailsFor(view, null, cx); }
    cx.notify();
  };
  // A button's icon and text brighten together: a hover style reaches the text but not the svg, so it's state.
  const lit = (id, color) => (view.hot === id ? t.foreground : color);
  // A space's mark, as t3-spaces draws it.
  const avatar = (id, name, size) => projectMark(sp.find((s) => s.id === id) ?? { name: name ?? "" }, size, t, ps);
  // A control's label in a row belongs to the same group as the row's card, so it too opens at once.
  const delay = detailsLive(view) ? 0 : 150;
  // A right-click: the agent's menu, as an Agents row's and the tab bar title's; a page's card (Review) is its pane's. The
  // layout names the menu (props.menu); the Inbox on its own has none.
  const menuMod = props()?.menu;
  const context = (a) => (el) => el.on_mouse_down("right", (_e, cx) => {
    detailsFor(view, null, cx);
    openMenu(view, a.mod ? "pane" : "agent", a.mod ? { pane: a.pane } : { address: a.address }, cx, menuMod);
  });
  const machineOf = (a) => a.address.includes("/") ? a.address.split("/")[0] : null;
  const paneOf = (a) => ps.find((p) => p.pane === a.pane);
  const branchOf = (a) => paneOf(a)?.branch;
  const folderOf = (a) => folderName(paneOf(a)?.cwd, Boolean(machineOf(a)));
  const headerLabel = (a) => folderOf(a) || a.program?.name || a.space_name || "";
  const leadIcon = (a, size = 14) => programIcon(a.program, size, t.muted)
    ?? svg("mods/t3-inbox/icons/folder.svg").size(size).flex_none().text_color(t.dim);
  // A row's details, as T3's thread card: on the row's right from its top. A 1px anchor just outside its top right corner, as
  // a Popup hangs from its trigger's bottom left; clamped at the window's bottom the card slides up and still clears the row.
  // A control lit in the row speaks for itself instead, as T3's group lets one tooltip up at a time: the card fades, up clear until the pointer goes.
  // The whole corner holds it, so the gap between two controls doesn't flash it.
  const details = (a) => {
    const machine = machineOf(a), branch = branchOf(a), folder = folderOf(a), pic = programIcon(a.program, 12, t.muted);
    const up = view.details === a.address || view.detailsOut === a.address;
    return Popup.new(`details-${a.address}`, div()).absolute().top(-1).right(-1).size(1)
      .when(up && !view.napMenu && !dragging && !view.sweep?.moved, (pop) => pop.content(detailsCard(view, t, a.address, title(a), [
        folder && detailsLine(t, svg("mods/t3-inbox/icons/folder.svg").size(12).flex_none().text_color(t.muted), folder),
        a.space_name && a.space_name !== folder && detailsLine(t, avatar(a.space, a.space_name, 12), a.space_name),
        machine && detailsLine(t, svg("mods/t3-inbox/icons/server.svg").size(12).flex_none().text_color(t.muted), machine),
        branch && detailsLine(t, svg("mods/t3-inbox/icons/git-branch.svg").size(12).flex_none().text_color(t.muted), branch),
        pic && detailsLine(t, div().flex_none().opacity(0.6).child(pic), a.program.name),
      ], { hide: Boolean(view.hot) || view.detailsHold === a.address }).ml(4)));
  };

  // `ghost`: the copy that follows the pointer, drawn without handlers or ids the list already uses.
  const card = (a, ghost) => {
    const st = state(a), on = viewing(a);
    const machine = machineOf(a), branch = branchOf(a);
    // As T3's sidebar, a card says nothing of its sub-agents: its state takes theirs in (tree.js).
    const meta = branch ?? "";
    // Snooze is offered for anything not needing the person, working too, as T3's. A failed turn counts as needing them
    // here, and a mod pane has no terminal to hold the label.
    const canNap = !ghost && !a.mod && st !== "blocked", menu = canNap && view.napMenu === a.address;
    // The pointer or keys going into its menu leave the card, but it stays as it was: the menu hangs from the clock, and
    // Settle going would pull the clock, and the menu with it, out from under the pointer.
    const over = !dragging && !view.sweep?.moved && (menu || view.hovered === a.address || within(view, [`card-${a.address}`, `settle-${a.address}`, `snooze-${a.address}`, `woke-${a.address}`]));
    // As T3's rows: what you're on or what wants you leads; the rest recede until hovered, in color only so nothing reflows.
    const leads = on || ghost || st === "blocked" || st === "done" || woke(a);
    // Program icon moved to the card's top-left beside the live folder name; bottom-right keeps only the remote machine mark.
    const marks = machine ? h_flex().gap(4).flex_none().items_center()
      .child(div().when(!ghost, (m) => m.id(`machine-${a.address}`).accessibility_label(`On ${machine}`))
        .flex_none().child(svg("mods/t3-inbox/icons/server.svg").size(14).text_color(t.dim))) : null;
    // Hovered, the corner offers Settle, but only for what's finished: a working or stuck tree stays in sight.
    const offer = over && !busy(a);
    const id = `settle-${a.address}`;
    const napOffer = canNap && over;
    // Orca-inspired borderless status corner: lightweight plain text/duration (no boxed pill), cross-fading to controls on hover.
    const errored = term?.get(a.address)?.status === "error";
    const statusDot = running(a)
      ? svg("mods/t3-inbox/icons/working.svg").size(12).flex_none().text_color(t.working).spin(1100)
      : st === "blocked"
        ? div().size(8).flex_none().rounded_full().bg(errored ? t.ansi1 : t.blocked)
        : st === "done"
          ? div().size(8).flex_none().rounded_full().bg(t.ansi2)
          : woke(a)
            ? svg("mods/t3-inbox/icons/alarm-clock.svg").size(12).flex_none().text_color(t.blocked)
            : div().size(6).flex_none().rounded_full().bg((t.dim ?? "#666666") + "66");
    const statusText = (color, label, time, medium = false) => h_flex().id(`state-${a.address}`).h(20).gap(3).flex_none().items_center().text_size(11.5).text_color(color)
      .when(medium, (el) => el.font_medium())
      .when(Boolean(label), (el) => el.child(div().child(label)))
      .when(Boolean(time), (el) => el.children(time.split(" ").map((part) => div().font_family(settings().font_family ?? "JetBrains Mono").child(part))));
    // It wakes where it was, so this carries the weight, as T3's; a click dismisses it, and it stays on hover.
    const wokeMark = woke(a) && tip(view, t, `woke-${a.address}`, "Dismiss Woke notification", stop(view, t, `woke-${a.address}`, h_flex().id(`woke-${a.address}`).h(20).gap(4).flex_none().items_center().text_size(11.5).font_medium().text_color(t.blocked)
      .hover((s) => s.underline()).on_hover(glow(view, `woke-${a.address}`)).role("button").accessibility_label("Dismiss Woke notification")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        view.hot = null; // It goes, before the pointer can report leaving it.
        wake(a, cx);
        cx.notify();
      })
      .child("Woke"), 4), { delay });
    const acting = offer || napOffer, quiet = acting && (menu || !woke(a));
    if (!acting && view.detailsHold === a.address) view.detailsHold = null;
    // Lifted, or marked by a sweep, the corner says what letting go will do instead.
    // The state or the time, faded out on hover where Settle fades in over it, as T3's corner.
    const word = running(a)
        ? statusText(t.working, null, started(a) > 0 && started(a) < Infinity ? took(started(a), now) : null)
        : st === "blocked"
          ? statusText(errored ? t.ansi1 : t.blocked, errored ? "Error" : "Needs you", null, true)
          : wokeMark
            || (st === "done"
              ? statusText(t.ansi2, "Done", null, true)
              : div().id(`state-${a.address}`).flex_none().text_size(11.5).text_color(t.dim).child(since(a) > 0 ? ago(since(a), now) : ""));
    // Still at work when it wakes, it says both, as T3's row; hovered, Woke stays and Working makes way.
    const status = running(a) && wokeMark ? h_flex().gap(4).flex_none().items_center().when(!acting, (el) => el.child(word)).child(wokeMark) : word;
    // T3's align="end" with its flip: right edges together if the menu fits to the clock's left, else from the clock's left edge and out over the sidebar's. Popover only clamps, so the flip is here; no press (the keyboard), the flip.
    const clock = canNap && snoozeButton(view, t, a, { now, offer: napOffer, delay }, pick);
    const corner = ghost ? (verb ? badge(verb) : div())
      : swept(a) ? badge("settle")
      // As T3's corner: hovered, the controls take the slot and the state fades out from under them, but for Woke.
      : h_flex().id(`corner-${a.address}`).relative().h(20).min_w(32).gap(4).flex_none().items_center().justify_end()
        .when(acting, (el) => el.on_hover((on, cx) => { view.detailsHold = on ? a.address : null; cx.notify(); }))
        .child(div().flex_none().when(quiet, (el) => el.absolute().top(0).right(0)).opacity(quiet ? 0 : 1).transition("opacity", MOTION).child(status))
        .child(h_flex().id(`controls-${a.address}`).h(20).flex_none().items_center().when(!acting, (el) => el.absolute().top(0).right(0))
        // When Settle is hidden (!offer, e.g. hovered Working card), keep its faded placeholder behind Snooze so it never steals clicks from Snooze.
        .when(!offer, (el) => el.child(div().absolute().top(0).right(0).child(
          h_flex().id(id).h(20).px(6).mr(-4).gap(4).flex_none().items_center().rounded(6).text_size(12).opacity(0).transition("opacity", MOTION)
            .child(svg("mods/t3-inbox/icons/check.svg").size(14).flex_none().text_color(t.muted)).child("Settle"))))
        .when(Boolean(clock), (el) => el.child(clock))
        .when(offer, (el) => el.child(div().child(
          tip(view, t, id, a.mod ? "Settle and close" : "Settle agent", h_flex().id(id).h(20).px(6).mr(-4).gap(4).flex_none().items_center().rounded(6)
            .text_size(12).text_color(lit(id, t.muted)).opacity(1).transition("opacity", MOTION)
            .on_hover(glow(view, id)).role("button").accessibility_label(a.mod ? "Settle and close" : "Settle")
            .when(!a.mod, (b) => b.on_mouse_down("left", sweepFrom("settle", a)))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              if (justDropped()) return;
              // A click is no sweep. Its release stops here, so the sidebar's mouse-up won't end the one the press began.
              view.sweep = null;
              settle([a], cx);
              cx.notify();
            })
            .child(svg("mods/t3-inbox/icons/check.svg").size(14).flex_none().text_color(lit(id, t.muted)))
            .child("Settle")
            .when(offer, (el) => stop(view, t, id, el, 6)), { action: on ? settleKey() : undefined, delay })))));
    // Orca-inspired 3-line card: borderless at rest (framed only when active or needing attention),
    // fixed 14px left lane aligning status dot -> program icon -> branch icon, title leading on line 1.
    const restBorder = t.chrome ?? t.border;
    const base = v_flex().id(`${ghost ? "ghost-" : ""}card-${a.address}`).relative().px(10).py(7).flex_none().rounded(8)
      .border(1).border_color(on ? (t.accent ? t.accent + "55" : t.border) : st === "blocked" ? (t.blocked ? t.blocked + "33" : t.border) : restBorder)
      .when(!ghost, (el) => el.opacity(1))
      .when(!on && st === "blocked", (el) => el.bg((t.blocked ?? "#c4b28a") + "10"));
    return (ghost ? base : row(base, a, details).role("button").accessibility_label(title(a)).on_hover(hover(a)).when(Boolean(menuMod), context(a))
      .on_click(open(a)).on_size_change((size) => { view.cardH = size.height / zoom; }))
      .when(on, (el) => el.bg(t.selected))
      .when(!on && !ghost && !dragging && !view.sweep?.moved, (el) => el.when(menu, (m) => m.bg(t.hover).border_color(t.hover)).hover((s) => s.bg(t.hover).border_color(t.hover)).active((s) => s.bg(t.selected).border_color(t.selected)))
      // Line 1: left status lane + optional pin + primary task title + lightweight right time/state (or hover controls).
      .child(h_flex().h(20).gap(6).items_center()
        .child(div().id(`status-lane-${a.address}`).size(14).flex_none().flex().items_center().justify_center().child(statusDot))
        // Lifted, a pin keeps its glyph only while it stays among the pins.
        .when(pins.includes(a.address) && (!ghost || plan?.section === "pinned" || !plan), (el) => el.child(svg("mods/t3-inbox/icons/pin.svg").size(12).flex_none().text_color(t.dim)))
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).when(leads, (el) => el.font_medium())
          .text_color(leads || over || swept(a) ? t.foreground : t.muted).child(title(a)))
        .child(corner))
      // Line 2: program icon + live folder name (plus remote mark here when there is no branch line).
      .child(h_flex().h(18).mt(3).gap(6).items_center().text_size(12).text_color(t.dim)
        .child(div().size(14).flex_none().flex().items_center().justify_center().child(leadIcon(a, 13)))
        .child(div().flex_1().min_w(0).truncate().child(headerLabel(a)))
        .when(Boolean(marks) && !meta, (el) => el.child(marks)))
      // Line 3: git branch (middle-truncated) + remote machine mark.
      .when(Boolean(meta), (el) => el.child(h_flex().h(16).mt(2).gap(6).items_center().text_size(12).text_color(t.dim)
        .child(div().size(14).flex_none().flex().items_center().justify_center()
          .child(svg("mods/t3-inbox/icons/git-branch.svg").size(12).flex_none().text_color(t.dim)))
        // T3's MiddleTruncate: a branch's start and end tell it apart.
        .child(div().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_ellipsis_middle().child(meta))
        .when(Boolean(marks), (m) => m.child(marks))))
      .when(!ghost, (el) => stop(view, t, `card-${a.address}`, el, 8));
  };

  // A settled or snoozed row: one dim line; viewing it leaves it so. Hovered it brightens and its time becomes a
  // bare undo arrow, or for a snoozed one, which shows when it comes back, Wake's crossed-out alarm clock, as in T3.
  const slim = (a, ghost) => {
    const on = viewing(a), over = !dragging && !view.sweep?.moved && (view.hovered === a.address || within(view, [`slim-${a.address}`, `wake-${a.address}`, `unsettle-${a.address}`])), bright = on || over || ghost || swept(a);
    const napping = hidden(a), undoId = `${napping ? "wake" : "unsettle"}-${a.address}`, undoLabel = napping ? "Wake agent" : "Un-settle";
    // Lead mark matches active cards: program icon, with tooltip showing the live folder (or program/space fallback).
    const mark = leadIcon(a, 14), markTip = headerLabel(a);
    const undo = h_flex().id(undoId).h(24).px(6).flex_none().items_center().justify_center().rounded(6)
      .opacity(over ? 1 : 0).transition("opacity", MOTION)
      // Faded out it's no button: a click there is the row's.
      .when(over, (el) => el.on_hover(glow(view, undoId)).role("button").accessibility_label(undoLabel)
        .on_mouse_down("left", sweepFrom(napping ? "unsnooze" : "unsettle", a)).on_click((_e, cx) => {
        cx.stop_propagation();
        if (justDropped()) return;
        view.sweep = null;
        away(a, cx);
        if (napping) wake(a, cx); else unsettle(a, cx);
        cx.notify();
      }))
      .child(svg(`mods/t3-inbox/icons/${napping ? "alarm-clock-off" : "undo"}.svg`).size(napping ? 12 : 14).mb(1).flex_none().text_color(lit(undoId, t.muted)))
      .when(over, (el) => stop(view, t, undoId, el, 6));
    const time = napping
      ? h_flex().gap(4).items_center().text_color(t.accent).child(svg("mods/t3-inbox/icons/alarm-clock.svg").size(12).flex_none().text_color(t.accent)).child(left(napUntil(a), now))
      : !ghost && ago(settledAt(a)[0], now);
    const base = h_flex().id(`${ghost ? "ghost-" : ""}slim-${a.address}`).h(SLIM).px(10).gap(10).flex_none().items_center().rounded(6);
    return (ghost ? base : row(base, a, details).role("button").accessibility_label(title(a)).on_hover(hover(a)).when(Boolean(menuMod), context(a)).on_click(open(a)))
      .when(on, (el) => el.bg(t.selected))
      .when(!on && !ghost && !dragging && !view.sweep?.moved, (el) => el.hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
      .child(h_flex().id(`slim-mark-${a.address}`).size(16).flex_none().items_center().justify_center().opacity(bright ? 1 : 0.4).transition("opacity", MOTION).child(ghost ? mark : tipMark(view, t, `slim-space-${a.address}`, markTip, mark, { delay })))
      .child(div().flex_1().min_w(0).truncate().when(on, (el) => el.font_medium()).text_color(bright ? t.foreground : t.muted).child(title(a)))
      .child(ghost ? (verb ? badge(verb) : div()) : swept(a) ? badge(view.sweep.action === "unsnooze" ? "wake" : "unsettle")
        // T3's corner: the time fades out on hover as the undo arrow fades in over it.
        : h_flex().id(`slim-corner-${a.address}`).relative().h(24).min_w(32).flex_none().items_center().justify_end()
          .child(div().flex_none().text_size(12).text_color(t.dim).opacity(over ? 0 : 1).transition("opacity", MOTION).child(time))
          .child(div().absolute().top(0).right(-4).child(tip(view, t, undoId, undoLabel, undo, { action: on && !napping ? settleKey() : undefined, delay }))))
      .when(!ghost, (el) => stop(view, t, `slim-${a.address}`, el));
  };


  return { card, slim };
}
