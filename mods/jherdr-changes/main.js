import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Scrollbar, v_virtual_list } from "gpui-base";
import { checking, spaces, focused, panes, exec, readTextFile, watchFolder, settings, theme } from "herdr";
import { changesLocation } from "./model.js";
import { ChangesController } from "./controller.js";

function location() {
  return changesLocation(spaces().find(s => s.active), focused(), panes());
}

export default class Changes extends View {
  init(_props, cx) {
    this.controller = new ChangesController(exec, readTextFile);
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("submit", (_e, cx) => this.commit(this.controller.state, cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (!checking()) cx.timer.every(10000, cx => this.refresh(this.controller.state, cx));
  }

  close() {
    this.controller.state = null;
    this.watch?.cancel();
  }

  refresh(s, cx) {
    if (!s?.location || s.loading || this.controller.writes.has(this.controller.writeKey(s))) return;
    cx.spawn(async cx => {
      await this.controller.refresh(s);
      if (s !== this.controller.state) return;
      this.watchRoot(s, cx);
      cx.notify();
    });
  }

  watchRoot(s, cx) {
    const root = s.location.on ? null : s.root;
    if (this.watchRootPath === root) return;
    this.watchRootPath = root;
    this.watch?.cancel();
    if (!root) return;
    cx.spawn(async cx => {
      try {
        while (s === this.controller.state && this.watchRootPath === root) {
          this.watch = watchFolder(root);
          await this.watch;
          if (s === this.controller.state && this.watchRootPath === root) this.refresh(s, cx);
        }
      } catch {
        if (s === this.controller.state) this.watchRootPath = null;
      }
    });
  }

  selectFile(s, file, cx) {
    if (s !== this.controller.state) return;
    s.path = file.path === s.path ? null : file.path;
    s.collapsed = !s.path;
    s.rows = [];
    cx.spawn(async cx => { await this.controller.load(s); cx.notify(); });
    cx.notify();
  }

  commit(s, cx) {
    const message = this.input.value();
    const target = location();
    if (!message.trim() || !this.controller.canCommit(s, target)) return;
    s.note = null;
    cx.spawn(async cx => {
      try {
        const done = await this.controller.commit(s, location(), message);
        if (done && s === this.controller.state && message === this.input.value()) this.input.set_value("");
      } catch (e) { s.note = "Commit failed: " + String(e.message || e); }
      this.refresh(this.controller.state, cx);
      cx.notify();
    });
    cx.notify();
  }

  fileRow(s, file, t) {
    const color = file.kind === "A" ? t.ansi2 : file.kind === "M" ? t.blocked : t.ansi1;
    const parts = file.path.split("/"), name = parts.pop();
    return h_flex().id("file-" + file.path).h(28).flex_none().gap(8).px(8).items_center().rounded(7)
      .when(s.path === file.path, el => el.bg(t.selected)).hover(el => el.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => this.selectFile(s, file, cx)).tooltip(file.path)
      .child(div().w(14).text_color(color).child(file.kind))
      .child(h_flex().flex_1().min_w(0).child(div().truncate().text_color(t.dim).child(parts.length ? parts.join("/") + "/" : ""))
        .child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(file.add > 0, el => el.child(div().text_color(t.ansi2).child("+" + file.add)))
      .when(file.del > 0, el => el.child(div().text_color(t.ansi1).child("−" + file.del)));
  }

  diffRow(row, t) {
    const color = row.kind === "+" ? t.ansi2 : row.kind === "-" ? t.ansi1 : null;
    return h_flex().h(20).gap(10).px(12).items_center()
      .when(Boolean(color), el => el.bg(color + "18"))
      .when(row.number !== undefined, el => el.child(div().w(32).text_right().text_color(t.dim).child(String(row.number))))
      .child(div().child(row.text || " "));
  }

  render(cx) {
    const target = checking() ? null : location();
    if (this.controller.select(target)) {
      this.watchRootPath = null;
      this.watch?.cancel();
      this.input.set_value("");
      this.refresh(this.controller.state, cx);
    }
    const s = this.controller.state, t = theme();
    const enabled = Boolean(this.input.value().trim() && this.controller.canCommit(s, target));
    const totals = s.files.reduce((a, f) => [a[0] + f.add, a[1] + f.del], [0, 0]);
    const empty = s.error || (s.loading ? "Loading changes…" : s.root ? "No uncommitted changes" : "No folder");
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background)
      .border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape" && this.typing) { this.handle.focus(); cx.stop_propagation(); } })
      .child(h_flex().h(42).px(14).gap(8).flex_none().items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes")).child(div().rounded(4).px(5).border_1().border_color(t.border)
          .text_size(10).text_color(t.muted).child(s.files.length + (s.files.length === 1 ? " file" : " files")))
        .child(div().flex_1()).child(div().text_color(t.ansi2).child("+" + totals[0]))
        .child(div().text_color(t.ansi1).child("−" + totals[1])))
      .child(div().relative().flex_1().min_h(44).max_h(Math.max(44, s.files.length * 28 + 12)).border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6)
          .children(s.files.map(f => this.fileRow(s, f, t)))
          .when(!s.files.length, el => el.child(div().p(8).text_color(t.dim).child(empty))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(s.limited, el => el.child(div().px(12).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().relative().flex_1().min_h(0).text_size(11).font_family(settings().font_family ?? "JetBrains Mono")
        .child(div().id("diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(s.width || 300).h_full().child(v_virtual_list("changes-diff", s.rows.length, 20, i => String(i),
            range => s.rows.slice(range.start, range.end).map(row => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(s.collapsed && s.files.length, el => el.child(div().absolute().px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(s.note), el => el.child(div().px(10).text_color(t.ansi1).child(s.note)))
      .child(h_flex().h(52).flex_none().px(10).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8)
          .border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8)
          .bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim)
          .when(enabled, el => el.cursor_pointer().on_click((_e, cx) => this.commit(s, cx)))
          .child(this.controller.writes.has(this.controller.writeKey(s)) ? "Committing…" : "Commit")));
  }
}
