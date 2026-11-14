import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, focused, run, shared, setShared, pickFolder, home, notify } from "herdr";

const KEY = "t3.favorites";
const MOD = "mods/t3-favorites";

const read = () => shared(KEY) ?? shared("hs.favorites") ?? [];

const norm = (p) => (p ? p.replace(/\\/g, "/").replace(/\/+$/, "") : "");

const same = (a, b) => norm(a?.folder) === norm(b?.folder) && (a?.machine ?? null) === (b?.machine ?? null);

function currentPlace() {
  const sp = spaces().find((s) => s.active);
  const ps = typeof panes === "function" ? panes() : [];
  const f = typeof focused === "function" ? focused() : null;
  const tabs = new Set((sp?.tabs ?? []).map((c) => c.id));
  const focusPane = f?.pane && tabs.has(f.tab) ? ps.find((p) => p.pane === f.pane && p.cwd) : null;
  const cwd = focusPane?.cwd || ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || sp?.folder || "";
  return { cwd, on: sp?.machine ?? null };
}

export default class Favorites extends View {
  open(f) {
    const hit = spaces().find((s) => same(s, f));
    if (hit) run("space.select", { id: hit.id });
    else run("space.new", { folder: f.folder, machine: f.machine ?? "" });
  }

  keep(folder, machine) {
    if (!folder) return;
    const list = read();
    if (list.some((f) => same(f, { folder, machine }))) {
      notify({ title: "已收藏过", body: folder, level: "info" });
      return;
    }
    const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
    const updated = [...list, { name, folder, machine: machine ?? null }];
    setShared(KEY, updated);
    setShared("hs.favorites", updated);
    notify({ title: "已收藏", body: folder, level: "success" });
  }

  addCurrent() {
    const { cwd, on } = currentPlace();
    if (!cwd) {
      notify({ title: "当前没有可收藏的目录", level: "warning" });
      return;
    }
    this.keep(cwd, on);
  }

  async browse() {
    const folder = await pickFolder({ prompt: "收藏哪个文件夹？" });
    if (folder) {
      this.keep(folder, null);
      this.open({ folder, machine: null });
    }
  }

  drop(f, cx) {
    const updated = read().filter((x) => !same(x, f));
    setShared(KEY, updated);
    setShared("hs.favorites", updated);
    cx.notify();
  }

  row(f, i, t, short) {
    const hit = spaces().find((s) => same(s, f));
    return h_flex().id(`fav-${i}`).h(42).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.open(f))
      .child(div().size(24).flex_none().flex().items_center().justify_center().rounded(6).bg(t.raised)
        .child(svg(`${MOD}/icons/folder.svg`).size(14).flex_none().text_color(t.muted)))
      .child(div().flex().flex_col().flex_1().min_w(0).gap(1)
        .child(div().w_full().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(f.name))
        .child(div().w_full().truncate().text_size(11).text_color(t.dim).child(`${f.machine ? `${f.machine} · ` : ""}${short(f.folder)}`)))
      .when(Boolean(hit), (el) => el.child(div().flex_none().px(5).py(1).rounded(4).bg(t.raised).text_size(10).text_color(t.ansi2).child("已打开")))
      .child(div().id(`fav-x-${i}`).size(20).flex_none().flex().items_center().justify_center().rounded(4).text_size(12).text_color(t.dim)
        .hover((s) => s.text_color(t.ansi1).bg(t.raised))
        .on_click((_e, cx) => { cx.stop_propagation(); this.drop(f, cx); })
        .child("✕"));
  }

  render() {
    const t = theme(), h = norm(home());
    const short = (p) => {
      const np = norm(p);
      return np && h && np.startsWith(h) ? "~" + np.slice(h.length) : p ?? "";
    };
    const list = [...read()].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    const rows = list.map((f, i) => this.row(f, i, t, short));
    return v_flex().id("t3-favorites").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().id("t3-favorites-toolbar").h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Favorites"))
        .child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(`${list.length}`))
        .child(div().flex_1())
        .child(h_flex().id("fav-add").h(26).px(8).flex_none().gap(4).items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.addCurrent())
          .child(svg(`${MOD}/icons/star.svg`).size(12).flex_none().text_color(t.accent))
          .child(div().child("收藏当前目录"))))
      .child(v_flex().id("fav-list").flex_1().min_h(0).p(8).gap(3).overflow_y_scrollbar().children(rows)
        .when(!rows.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).child("还没有收藏目录。点击上方「收藏当前目录」或下方浏览添加。"))))
      .child(h_flex().id("fav-browse").h(34).flex_none().m(8).px(10).gap(8).items_center().rounded(7).cursor_pointer().bg(t.raised).text_size(12).hover((s) => s.bg(t.hover))
        .on_click(() => this.browse())
        .child(svg(`${MOD}/icons/plus.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).text_color(t.muted).child("浏览文件夹收藏…")));
  }
}
