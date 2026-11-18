import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Button, Checkbox, InputState, Input } from "gpui-base";
import { checking, closeOverlay, props, run, writeTextFile, readTextFile } from "herdr";
import { formatCommand, saveAgentDraft } from "./agent-config.js";

export function agentIcon(program, t, size = 14) {
  if (!program?.icon) return div().w(size).text_color(t.muted).child(program?.name?.slice(0, 1) || "◇");
  return (program.tint ? svg(program.icon).text_color(t.foreground) : image(program.icon)).w(size).h(size).flex_none();
}

function action(id, text, fn, t, primary = false) {
  return Button.new(id).px(10).h(29).rounded(5).cursor_pointer().items_center().justify_center()
    .text_color(primary ? t.foreground : t.muted).when(primary, el => el.bg(t.selected))
    .hover(el => el.bg(t.hover)).on_click((_e, cx) => fn(cx)).child(text);
}

export class AgentSettings {
  constructor(load, path, cx) {
    this.load = load;
    this.path = path;
    this.rows = [];
    this.nextId = 0;
    this.busy = true;
    if (!checking()) cx.spawn(async cx => this.reload(cx));
  }

  async reload(cx) {
    this.busy = true; this.error = null; cx.notify();
    try {
      const { agents, source } = await this.load();
      this.source = source;
      this.rows = agents.map(a => {
        const command = formatCommand(a.run);
        return { ...a, originalEnabled: a.enabled, originalCommand: command, input: InputState.new({ value: command }) };
      });
      this.loaded = true;
    } catch (e) { this.error = String(e.message || e); }
    finally { this.busy = false; cx.notify(); }
  }

  add(cx) {
    const row = { isNew: true, id: ++this.nextId, enabled: true,
      nameInput: InputState.new({ placeholder: "标识，例如 my-agent" }), input: InputState.new({ placeholder: "程序名和启动参数" }) };
    this.rows.push(row);
    row.nameInput.focus(); cx.notify();
  }

  async save(cx) {
    if (this.busy || !this.loaded) return;
    this.busy = true; this.error = null; cx.notify();
    try {
      const after = saveAgentDraft(this.source, this.rows.map(r => ({ ...r,
        key: r.isNew ? r.nameInput.value().trim() : r.key, command: r.input.value() })));
      if (after !== this.source) {
        if (await readTextFile(this.path) !== this.source) throw new Error("配置已被其他窗口修改，请重新载入后再编辑");
        await writeTextFile(this.path, after, this.source);
        run("jherdr-projects.agents-updated");
      }
      closeOverlay(props().overlay);
    } catch (e) { this.error = String(e.message || e); }
    finally { this.busy = false; cx.notify(); }
  }

  row(r, t) {
    const id = r.isNew ? "draft-" + r.id : "agent-" + r.key;
    return h_flex().id(id).w_full().h(40).gap(8).items_center()
      .child(Checkbox.new("enabled-" + id).checked(r.enabled).size(17).flex_none().rounded(4)
        .border(1).border_color(r.enabled ? t.accent : t.border).items_center().justify_center().cursor_pointer()
        .accessibility_label("启用 " + (r.name || "自定义 Agent"))
        .on_change((value, cx) => { r.enabled = value; cx.notify(); })
        .when(r.enabled, el => el.child(svg("mods/workspace-chrome/check.svg").size(12).text_color(t.accent))))
      .child(r.isNew ? Input.new(r.nameInput).w(142).h(30).px(5).bg(t.background).rounded(4) :
        h_flex().w(142).gap(7).items_center().child(agentIcon(r, t)).child(div().truncate().child(r.name)))
      .child(Input.new(r.input).flex_1().min_w(0).h(30).px(7).bg(t.background).rounded(4)
        .accessibility_label((r.name || "自定义 Agent") + "启动命令"))
      .when(r.isNew, el => el.child(action("remove-" + id, "移除", cx => { this.rows = this.rows.filter(other => other !== r); cx.notify(); }, t)));
  }

  render(t) {
    const missing = this.rows.filter(r => !r.installed && !r.isNew);
    return v_flex().size_full().bg(t.popover).text_size(12).text_color(t.foreground).p(18).gap(8)
      .child(div().text_size(16).font_semibold().child("Agent 设置"))
      .child(div().text_color(t.muted).child("勾选工作树中可用的 Agent。启动命令中含空格的参数可用引号包住。"))
      .when(this.loaded, el => el.child(h_flex().mt(6).gap(8).text_size(11).text_color(t.dim)
        .child(div().w(167).child("Agent")).child("启动命令")))
      .child(v_flex().id("agent-settings-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(!this.loaded && this.busy, el => el.child("正在读取 Agent…"))
        .children(this.rows.filter(r => r.isNew || r.installed).map(r => this.row(r, t)))
        .when(this.loaded, el => el.child(h_flex().gap(6).mt(5)
          .child(action("add-agent", "＋ 添加自定义 Agent", cx => this.add(cx), t))
          .when(missing.length, el => el.child(action("show-missing", this.showMissing ? "收起未安装" : `未安装（${missing.length}）`, cx => {
            this.showMissing = !this.showMissing; cx.notify();
          }, t)))))
        .when(this.showMissing, el => el.children(missing.map(r => this.row(r, t)))))
      .when(this.error, el => el.child(div().text_color("#E6B56D").child(this.error)))
      .child(h_flex().w_full().items_center().gap(6)
        .when(this.error && !this.busy, el => el.child(action("reload-config", "重新载入", cx => cx.spawn(async cx => this.reload(cx)), t)))
        .child(div().flex_1()).child(action("cancel-agent-settings", "取消", () => closeOverlay(props().overlay), t))
        .child(action("save-agent-settings", this.busy ? "处理中…" : "保存", cx => cx.spawn(async cx => this.save(cx)), t, true)
          .disabled(this.busy || !this.loaded)));
  }
}
