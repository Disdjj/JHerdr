import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, panes, spaces, terminals, machines, focused, shared, setShared, exec, run, theme,
  props, checking, pickFolder, knownAgents, nextCommand, openOverlay, closeOverlay, setAgentOrder, appHome, home, settings, readTextFile, notify } from "herdr";
import { STATE_KEY, LABELS, PROJECT_SORTS, orderedProjects, stateOf, moveProject, dropProject, forgetProject, buildTree, flattenTree, firstSearchHit, activeSummary, visibleOtherSpaces, activeZedFolder, contains, basename, normalize } from "./model.js";
import { RepositoryController, readAgentCatalog, openActiveFolderInZed, removeWorktree } from "./controller.js";
import { AgentSettings, agentIcon } from "./agent-settings.js";

const MOD = "jherdr-projects";
const projectActions = [
  { id: "open-local", title: "打开项目", icon: "folder" },
  { id: "clone", title: "从 URL 克隆", icon: "git-branch" },
  { id: "new", title: "新建项目", icon: "folder-plus" },
  { id: "template", title: "从模板开始", icon: "layers" },
];
const icon = (name, size = 14) => svg(`mods/${["more", "refresh", "sort", "zed"].includes(name) ? MOD : "workspace-chrome"}/${name}.svg`).size(size).flex_none();
const programFile = () => appHome() + "/programs.json";
const catalogFor = machine => readAgentCatalog(() => readTextFile(programFile()), knownAgents, machine);
const enabledAgents = async ({ on }) => (await catalogFor(on)).agents.filter(a => a.enabled);
const snapshot = () => ({ spaces: spaces(), panes: panes(), agents: agents(), terminals: terminals(), machines: machines(), focused: focused() });
const state = () => stateOf(shared(STATE_KEY));
const save = value => setShared(STATE_KEY, value);
const statusColor = (status, t) => ({ working: "#A5C68D", blocked: "#E6B56D", done: "#8BB8DA", idle: t.dim, offline: t.dim, unknown: t.dim })[status] || t.dim;

export default class Projects extends View {
  init(_props, cx) {
    if (props()?.zedToolbar) {
      if (!checking()) cx.spawn(async () => {
        for (;;) if (await nextCommand() === "open-zed") await this.openZed();
      });
      return;
    }
    if (props()?.removeWorktree) return;
    if (props()?.agentSettings) {
      this.agentSettings = new AgentSettings(() => catalogFor(null), programFile(), cx);
      return;
    }
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.selected = null;
    this.query = "";
    this.hoveredWorktree = null;
    this.inputFocused = false;
    this.adding = false;
    this.items = [];
    this.message = null;
    this.activeFolded = {};
    this.undoToken = 0;
    this.undoToast = null;
    if (props()?.menu) {
      this.menuLoading = props().menu === "worktree";
      this.launchers = [];
      this.menuIndex = 0;
      if (!checking()) this.handle.focus();
      if (this.menuLoading && !checking()) cx.spawn(async cx => {
        try { this.launchers = (await enabledAgents({ on: props().project.machine })).filter(a => a.installed); }
        catch { this.menuError = "暂时无法读取可用 Agent"; }
        this.menuLoading = false; cx.notify();
      });
      return;
    }
    this.input = InputState.new({ placeholder: "搜索项目、分支或 Worker" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.selected = null; cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.on("submit", (_e, cx) => {
      const row = this.firstMatch;
      if (row) this.activate(row, cx);
    });
    this.controller = new RepositoryController({ execute: exec, readState: state, writeState: save, snapshot, listAgents: enabledAgents, avatarScript: appHome() + "/data/jherdr/bin/github-avatar.mjs", changed: () => cx.notify() });
    // `check` must never discover projects or write persistent user state.
    if (checking()) return;
    if (shared("jherdr.undo")) setShared("jherdr.undo", null);
    cx.spawn(async () => this.controller.refresh());
    cx.timer.every(10000, cx => { cx.spawn(async () => this.controller.refresh()); });
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        else if (command === "agent-settings") this.showAgentSettings();
        else if (command === "agents-updated") await this.controller.invalidateLaunchers();
        else if (command === "refresh") await this.controller.refresh(true);
        else if (command === "notify-undo") this.showUndoToast(cx);
        else if (command === "undo") this.restore();
        else if (command === "toggle-active") this.setActiveOnly(!state().activeOnly);
        else if (command === "add" && !this.form && !this.adding) this.projectMenu();
        else if (projectActions.some(a => a.id === command) && !this.form && !this.adding) {
          if (command === "open-local") await this.add(cx);
          else this.startForm(command, cx);
        }
        else if (command === "search" && !this.form) this.input.focus();
        cx.notify();
      }
    });
  }

  close() { if (this.controller) this.controller.stopped = true; }

  showAgentSettings() {
    openOverlay({ mod: MOD, kind: "dialog", width: 660, height: 452, props: { agentSettings: true } });
  }

  async add(cx) {
    if (this.adding) return;
    this.adding = true; this.message = null; cx.notify();
    try {
      const folder = await pickFolder({ prompt: "打开项目" });
      if (folder) await this.enterFolder(folder, true);
    } catch (e) { this.message = `打开失败：${e.message || e}`; }
    finally { this.adding = false; cx.notify(); }
  }

  async enterFolder(folder, allowPlain = false) {
    const result = await this.controller.resolveFolder(folder, allowPlain);
    if (!result) return;
    this.input.set_value(""); this.query = "";
    this.setActiveOnly(false);
    if (result.plain) {
      const existing = spaces().find(s => !s.machine && normalize(s.folder) === normalize(folder));
      if (existing) run("space.select", { id: existing.id });
      else run("space.new", { folder, name: basename(folder) });
      return;
    }
    const tree = buildTree(state().projects, this.controller.cache, snapshot());
    const project = tree.projects.find(p => p.id === result.project.id);
    const worktree = project.worktrees.find(w => normalize(w.path) === normalize(result.checkout)) || project.worktrees[0];
    this.fold(project.id, false);
    this.selected = worktree.id;
    this.openWorktree(project, worktree);
  }

  projectMenu(bounds) {
    const width = 166;
    const zoom = Number(settings()?.zoom) || 1;
    const at = bounds && { x: Math.max(0, bounds.x + bounds.width - width * zoom), y: bounds.y + bounds.height + 3 * zoom };
    openOverlay({ mod: MOD, kind: "popup", width, height: 140, ...(at ? { at } : {}), props: { menu: "add" } });
  }

  startForm(mode, cx) {
    const name = InputState.new({ placeholder: mode === "clone" ? "默认使用仓库名" : "项目文件夹名称" });
    const url = InputState.new({ placeholder: "HTTPS 或 SSH 仓库地址" });
    this.form = { mode, name, url, parent: `${home()}/repos`, template: "web", busy: false };
    this.message = null;
    for (const input of [name, url]) input.on("submit", (_e, cx) => cx.spawn(async cx => this.submitForm(cx)));
    (mode === "clone" ? url : name).focus();
    cx.notify();
  }

  leaveForm(cx) {
    if (this.form.busy) return;
    this.form = null;
    this.message = null;
    this.handle.focus();
    cx.notify();
  }

  async chooseParent(cx) {
    const f = this.form;
    if (!f || f.busy) return;
    f.busy = true; cx.notify();
    try {
      const parent = await pickFolder({ prompt: "选择保存位置" });
      if (parent) { f.parent = parent; this.message = null; }
    } catch (e) { this.message = String(e.message || e); }
    finally { f.busy = false; cx.notify(); }
  }

  async submitForm(cx) {
    const f = this.form;
    if (!f || f.busy) return;
    f.busy = true; this.message = null; cx.notify();
    try {
      if (!f.created) {
        const name = f.name.value().trim(), source = f.mode === "clone" ? f.url.value().trim() : f.template;
        if (f.mode === "clone" && !source) throw new Error("请填写仓库地址");
        if (f.mode !== "clone" && !name) throw new Error("请填写项目名称");
        if (!f.parent) throw new Error("请选择保存位置");
        f.created = await this.controller.createProject(appHome(), f.mode, f.parent, name, source);
      }
      await this.enterFolder(f.created);
      this.form = null;
    } catch (e) { this.message = (f.created ? "项目已保存，打开失败：" : "") + (e.message || e); }
    finally { f.busy = false; cx.notify(); }
  }

  foldedMap(s = state()) {
    return s.activeOnly ? this.activeFolded : s.folded;
  }

  setActiveOnly(activeOnly) {
    const s = state();
    if (s.activeOnly === activeOnly) return;
    this.activeFolded = {};
    this.selected = null;
    save({ ...s, activeOnly });
  }

  fold(key, value) {
    const s = state();
    if (s.activeOnly) {
      this.activeFolded[key] = value ?? !this.activeFolded[key];
      return;
    }
    s.folded[key] = value ?? !s.folded[key];
    save(s);
  }

  openWorktree(project, worktree, argv) {
    if (project.offline || worktree.prunable) return;
    const all = spaces().filter(s => (s.machine ?? null) === (project.machine ?? null));
    const tabs = new Map(all.flatMap(s => s.tabs.map(tab => [tab.id, s])));
    const pane = panes().find(p => tabs.has(p.tab) && contains(worktree.path, p.cwd));
    // The tree already resolved nested repositories and the active tab. Prefer that exact mapping.
    const mapped = worktree.spaces?.find(s => s.active) || worktree.spaces?.[0];
    const existing = Array.isArray(worktree.spaces) ? mapped : (pane && tabs.get(pane.tab)) || all.find(s => contains(worktree.path, s.folder));
    if (existing) {
      run("space.select", { id: existing.id });
      if (argv) run("tab.new", { space: existing.id, folder: worktree.path, argv });
      else if (mapped?.tabId || pane?.tab) run("tab.select", { id: mapped?.tabId || pane.tab });
    } else run("space.new", { folder: worktree.path, name: worktree.name, machine: project.machine, ...(argv ? { argv } : {}) });
  }

  activate(row, cx) {
    this.selected = row.key;
    if (row.kind === "project") {
      if (this.query.trim()) {
        const root = row.project.worktrees[0];
        if (root) this.openWorktree(row.project, root);
      } else this.fold(row.key);
    }
    else if (row.kind === "worktree") {
      if (!this.query.trim()) this.fold(row.key, false);
      this.openWorktree(row.project, row.worktree);
    }
    else if (row.kind === "worker" && !row.project.offline) this.openWorker(row.worker);
    else if (row.kind === "space") run("space.select", { id: row.space.id });
    cx.notify();
  }

  openWorker(worker) {
    // Resolve live panes at click time: a background worker may already have been
    // kept since the row/menu was rendered. Reuse its tab instead of opening a peek.
    const pane = panes().find(p => p.terminal === worker.address);
    if (pane) run("pane.focus", { pane: pane.pane });
    else run("terminal.keep", { terminal: worker.address, place: "tab" });
  }

  context(row) {
    if (row.kind === "space") return;
    openOverlay({ mod: MOD, kind: "popup", width: 270, props: { menu: row.kind, project: row.project, worktree: row.worktree, worker: row.worker } });
  }

  newWorktree(project) {
    if (project.offline) return;
    this.setActiveOnly(false);
    this.fold(project.id, false);
    openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280,
      props: { action: "new", folder: project.root, machine: project.machine ?? null } });
  }

  async openZed() {
    const target = activeZedFolder(spaces(), panes(), machines());
    if (!target) { notify({ title: "没有可打开的工作目录" }); return; }
    try { await openActiveFolderInZed(exec, target); }
    catch (e) { notify({ title: "无法用 Zed 打开目录", body: String(e.message || e), level: "error" }); }
  }

  renderZedToolbar(t) {
    const target = activeZedFolder(spaces(), panes(), machines());
    const label = target ? "用 Zed 打开（⌘O） · " + (target.machine ? target.machine + " · " : "") + target.folder : "没有可打开的工作目录";
    return h_flex().size_full().items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("open-active-zed").h(26).px(8).gap(5).rounded(6).items_center().text_size(12)
        .text_color(t.muted).accessibility_label("用 Zed 打开").tooltip(label)
        .when(!target, el => el.opacity(0.4))
        .when(target, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => cx.spawn(async () => this.openZed())))
        .child(icon("zed", 14)).child("Zed"));
  }

  renderRemoval(t) {
    const { project, worktree, overlay } = props();
    const confirm = cx => cx.spawn(async cx => {
      if (this.removing) return;
      this.removing = true; this.message = null; cx.notify();
      try {
        await removeWorktree(exec, project, worktree);
        run(`${MOD}.refresh`);
        closeOverlay(overlay);
      } catch (error) { this.message = String(error.message || error); this.removing = false; cx.notify(); }
    });
    return v_flex().size_full().bg(t.popover).text_color(t.foreground).text_size(13).p(16).gap(10)
      .child(div().text_size(15).font_semibold().child("删除工作树？"))
      .child(v_flex().id("removal-details").flex_1().min_h(0).overflow_y_scrollbar().gap(6)
        .child(div().child(`${project.machine || "本机"} · ${worktree.name}`))
        .child(div().child(worktree.path))
        .child(div().text_color(t.muted).child("Git 将移除整个工作目录，包括被忽略的文件。分支保留，有未提交更改时 Git 会拒绝删除。"))
        .when(worktree.detached, el => el.child(div().text_color(statusColor("blocked", t)).child("当前是分离 HEAD。需要保留此提交时，请先创建分支。")))
        .when(worktree.spaces?.length || worktree.workers?.length, el => el.child(div().text_color(statusColor("blocked", t)).child("有会话关联此目录。删除后会话仍然打开，原工作目录将不可用。")))
        .when(this.message, el => el.child(div().text_color(statusColor("blocked", t)).child(this.message))))
      .child(h_flex().justify_end().gap(8)
        .child(this.button("cancel-remove", "取消", () => closeOverlay(overlay), t, null, this.removing))
        .child(this.button("confirm-remove", this.removing ? "删除中…" : "删除工作树", confirm, t, null, this.removing).bg(t.raised)));
  }

  changeProject(id, fields) {
    const s = state();
    s.projects = s.projects.map(p => p.id === id ? { ...p, ...fields } : p);
    save(s);
  }

  key(e, cx) {
    if (e.key === "escape" && this.projectDrag) {
      this.endProjectDrag(cx); cx.stop_propagation(); return;
    }
    if (props()?.menu) return this.menuKey(e, cx);
    if (this.form) {
      if (e.key === "escape") { this.leaveForm(cx); cx.stop_propagation(); }
      return;
    }
    if (e.key === "f" && (e.modifiers.control || e.modifiers.platform)) { this.input.focus(); cx.stop_propagation(); return; }
    if (e.key === "escape") {
      if (this.query) { this.input.set_value(""); this.query = ""; }
      this.handle.focus(); cx.stop_propagation(); cx.notify(); return;
    }
    if (this.inputFocused && !["down", "up"].includes(e.key)) return;
    const rows = this.items;
    if (!rows.length) return;
    const old = Math.max(0, rows.findIndex(r => r.key === this.selected));
    const row = rows[old];
    let next = old;
    if (e.key === "down") next = this.selected == null ? Math.max(0, rows.indexOf(this.firstMatch)) : Math.min(rows.length - 1, old + 1);
    else if (e.key === "up") next = Math.max(0, old - 1);
    else if (e.key === "home") next = 0;
    else if (e.key === "end") next = rows.length - 1;
    else if (e.key === "enter" && row) { this.activate(row, cx); cx.stop_propagation(); return; }
    else if (e.key === "right" && row) {
      if (row.kind === "project" || row.kind === "worktree") this.fold(row.key, false);
      else this.activate(row, cx);
    } else if (e.key === "left" && row) {
      if ((row.kind === "project" || row.kind === "worktree") && !this.foldedMap()[row.key]) this.fold(row.key, true);
      else { const parent = row.kind === "worker" ? row.worktree.id : row.project?.id; next = Math.max(0, rows.findIndex(r => r.key === parent)); }
    } else if ((e.key === "space" || e.key === "f10") && row) this.context(row);
    else if (e.key === "tab") { this.input.focus(); cx.stop_propagation(); return; }
    else return;
    this.handle.focus();
    this.selected = rows[next]?.key || null;
    this.scroll.scroll_to_item(next);
    cx.stop_propagation(); cx.notify();
  }

  button(id, name, action, t, glyph, disabled = false) {
    return h_flex().id(id).h(26).px(5).gap(4).rounded(5).items_center().flex_none()
      .text_color(t.muted).cursor_pointer().tooltip(name)
      .when(disabled, el => el.opacity(0.4))
      .hover(el => el.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); if (!disabled) action(cx); })
      .child(glyph ? icon(glyph, 13) : div().text_size(12).child(name));
  }

  trackProjectDrag(row, e, cx) {
    const drag = this.projectDrag;
    if (!drag) return;
    if (!drag.active && Math.hypot(e.position.x - drag.start.x, e.position.y - drag.start.y) < 5) return;
    const valid = row.kind === "project" && row.key !== drag.source && Boolean(row.project.pinned) === drag.pinned;
    const target = valid ? row.key : null;
    const after = valid && e.local_position.y >= e.bounds.height / 2;
    if (!drag.active || drag.target !== target || drag.after !== after) {
      Object.assign(drag, { active: true, target, after });
      this.suppressRowClick = true;
      cx.notify();
    }
  }

  endProjectDrag(cx, row, event) {
    const drag = this.projectDrag;
    if (!drag) return;
    this.projectDrag = null;
    if (drag.active && row?.kind === "project" && event.bounds && event.local_position) {
      const current = state();
      const next = dropProject(current, drag.source, row.key, event.local_position.y >= event.bounds.height / 2);
      if (next !== current) save(next);
    }
    cx.notify();
  }

  status(worker, t) {
    return h_flex().gap(4).flex_none().items_center().text_size(10.5).text_color(statusColor(worker.status, t))
      .child(div().child(worker.status === "blocked" ? "!" : worker.status === "idle" ? "○" : "●"))
      .child(LABELS[worker.status] || LABELS.unknown);
  }

  worktreeActions(line, row, t) {
    const { project, worktree } = row;
    if (worktree.prunable) return line.child(div().text_size(10).text_color(t.dim).child("不可用"));
    if (project.offline) return line;
    const group = v_flex().id(`worktree-hover-${row.key}`).w_full().flex_none()
      .on_hover((inside, cx) => {
        if (!inside && this.hoveredWorktree !== row.key) return;
        const next = inside ? row.key : null;
        if (next !== this.hoveredWorktree) { this.hoveredWorktree = next; cx.notify(); }
      });
    line = line.w_full();
    if (this.hoveredWorktree !== row.key) return group.child(line);
    const catalog = this.controller.launchers.get(project.machine ?? null);
    if (!catalog?.agents?.length) {
      const hint = !catalog ? "正在读取 Agent…" : catalog.error ? "Agent 加载失败" : "无可用 Agent";
      return group.child(line.child(div().text_size(10).text_color(t.dim).child(hint)));
    }
    const strip = h_flex().items_center().children(catalog.agents.map(agent => {
      const label = `在 ${worktree.name} 启动 ${agent.name}`;
      return h_flex().id(`launch-${row.key}-${agent.key}`).size(22).flex_none().items_center().justify_center()
        .rounded(4).cursor_pointer().tooltip(label).accessibility_label(label).hover(el => el.bg(t.selected))
        .on_click((_e, cx) => { cx.stop_propagation(); this.openWorktree(project, worktree, agent.run); })
        .child(agentIcon(agent, t, 15));
    }));
    // Keep enough space to read the branch when the sidebar is narrow or more agents are installed.
    if ((this.sidebarWidth ?? 295) - catalog.agents.length * 22 < 150) {
      return group.child(line).child(strip.w_full().pl(40).pb(3).flex_wrap());
    }
    return group.child(line.child(strip.flex_none()));
  }

  row(row, t, folded, marked, activeOnly = false) {
    const { kind, project, worktree, worker } = row;
    const isFolded = Boolean(folded[row.key]) && !this.query.trim();
    const canDrag = kind === "project" && !activeOnly && !this.query.trim();
    const active = marked === row.key;
    const selected = this.selected === row.key || (this.inputFocused && this.query.trim() && this.selected == null && row === this.firstMatch);
    const label = kind === "project" ? project.name : kind === "worktree" ? worktree.name : kind === "worker" ? worker.name : row.space.name;
    const tip = kind === "project" ? `${project.root}${project.error ? `\n${project.error}` : ""}` : kind === "worktree" ? `${worktree.path}${worktree.locked ? "\n已锁定" : ""}${worktree.prunable ? "\n工作目录已不可用" : ""}` : kind === "worker" ? `${worker.title}\n${worker.address} · ${worker.cwd}` : row.space.folder;
    let line = h_flex().id(`row-${row.key}`).h(kind === "project" ? 32 : 27).flex_none().pl([5, 21, 62][row.depth]).pr(6)
      .gap(5).items_center().rounded(5).text_size(12.5).cursor_pointer().tooltip(tip)
      .text_color(kind === "project" ? t.foreground : t.muted)
      .when(active, el => el.bg(t.selected).text_color(t.foreground))
      .when(selected, el => el.border(1).border_color(t.accent))
      .hover(el => el.bg(active ? t.selected : t.hover))
      .on_mouse_down("left", e => {
        this.handle.focus();
        this.suppressRowClick = false;
        this.projectDrag = canDrag ? { source: row.key, pinned: Boolean(project.pinned), start: e.position } : null;
      })
      .on_mouse_move((e, cx) => this.trackProjectDrag(row, e, cx))
      .on_mouse_up("left", (e, cx) => this.endProjectDrag(cx, row, e))
      .on_mouse_down("right", () => this.context(row))
      .on_click((_e, cx) => { if (!this.suppressRowClick) this.activate(row, cx); });
    if (canDrag) {
      const drag = this.projectDrag;
      line = line.relative().cursor_grab()
        .when(drag?.active && drag.source === row.key, el => el.opacity(0.6).cursor_grabbing())
        .when(drag?.target === row.key, el => el.child(div().absolute().left(4).right(4).h(2).bg(t.accent)
          .when(drag.after, bar => bar.bottom(0)).when(!drag.after, bar => bar.top(0))));
    }
    if ((kind === "project" || kind === "worktree") && (this.query.trim() || (kind === "worktree" && !worktree.workers.length))) {
      line = line.child(div().w(12).flex_none());
    } else if (kind === "project" || kind === "worktree") line = line.child(div().id(`fold-${row.key}`).w(12).h(24).flex_none().flex().items_center().justify_center()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .tooltip(isFolded ? "展开" : "收起").on_click((_e, cx) => { cx.stop_propagation(); this.fold(row.key); cx.notify(); })
      .child(icon(isFolded ? "chevron-right" : "chevron-down", 11)));
    if (kind === "project") {
      const avatar = this.controller.avatars.get(project.githubOwner)?.path;
      line = line.child(h_flex().size(19).flex_none().rounded(5).overflow_hidden().items_center().justify_center()
        .bg(t.raised).child(avatar ? image(avatar).size(19) : icon("folder", 14).text_color(t.muted)));
    } else if (kind === "worktree") line = line.child(icon("git-branch", 12));
    else if (kind === "worker") line = line.child(agentIcon(worker.program, t));
    const title = div().min_w(0).truncate().when(kind === "project", el => el.font_medium()).child(label);
    if (kind === "project" && project.qualifier) {
      line = line.child(v_flex().flex_1().min_w(0).child(title)
        .child(div().text_size(10).text_color(t.dim).truncate().child(project.qualifier))).h(40);
    } else line = line.child(title.flex_1());
    if (kind === "project") {
      if (project.pinned) line = line.child(icon("pin", 11).text_color(t.accent));
      if (project.machine) line = line.child(div().max_w(60).truncate().text_size(10).text_color(t.dim).child(project.machine));
      if (project.offline || project.error || project.loading) line = line.child(div().text_size(10).text_color(project.error ? "#E6B56D" : t.dim).child(project.offline ? "离线" : project.error ? "读取失败" : "读取中"));
      else {
        if (project.counts.working) line = line.child(div().text_size(10).text_color("#A5C68D").child(`${project.counts.working} 运行`));
        if (project.counts.blocked) line = line.child(div().text_size(10).text_color("#E6B56D").child(`${project.counts.blocked} 待处理`));
      }
      line = line.child(this.button(`new-worktree-${row.key}`, "新建工作树", () => this.newWorktree(project), t, "plus", project.offline)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()))
        .child(this.button(`menu-${row.key}`, "项目操作", () => this.context(row), t, "more")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()));
    } else if (kind === "worktree") return this.worktreeActions(line, row, t);
    else if (kind === "worker") line = line.child(this.status(worker, t));
    return line;
  }

  menuItems() {
    const { project, worktree, worker, menu, overlay } = props();
    const close = fn => () => { closeOverlay(overlay); fn(); };
    if (menu === "add") return projectActions.map(a => ({ ...a, action: close(() => run(`${MOD}.${a.id}`)) }));
    if (menu === "sort") return Object.entries(PROJECT_SORTS).map(([sort, title]) => ({
      title, checked: state().sort === sort, action: close(() => save({ ...state(), sort })),
    }));
    if (menu === "worker") return [{ title: "打开 Worker", action: close(() => this.openWorker(worker)), disabled: project.offline }];
    if (menu === "worktree") return [
      { title: "打开工作树", action: close(() => this.openWorktree(project, worktree)), disabled: project.offline || worktree.prunable },
      ...this.launchers.map(a => ({ title: `启动 ${a.name}`, action: close(() => this.openWorktree(project, worktree, a.run)), disabled: project.offline || worktree.prunable })),
      { title: "删除工作树…", icon: "minus", disabled: project.offline || worktree.main || Boolean(worktree.locked),
        action: close(() => openOverlay({ mod: MOD, kind: "dialog", modal: true, width: 460, height: 300,
          props: { removeWorktree: true, project, worktree } })) },
    ];
    const s = state();
    const index = s.projects.findIndex(p => p.id === project.id);
    const pinned = Boolean(s.projects[index]?.pinned);
    const peers = s.projects.filter(p => Boolean(p.pinned) === pinned);
    const position = peers.findIndex(p => p.id === project.id);
    return [
      { title: "新建工作树", icon: "plus", action: close(() => this.newWorktree(project)), disabled: project.offline },
      { title: "打开项目", action: close(() => this.openWorktree(project, project.worktrees[0] || { path: project.root, name: project.name })), disabled: project.offline },
      { title: pinned ? "取消置顶" : "置顶项目", icon: pinned ? "pin-off" : "pin", action: close(() => this.changeProject(project.id, { pinned: !pinned })) },
      { title: "上移项目", action: close(() => save(moveProject(state(), project.id, -1))), disabled: s.sort !== "manual" || s.activeOnly || position <= 0 },
      { title: "下移项目", action: close(() => save(moveProject(state(), project.id, 1))), disabled: s.sort !== "manual" || s.activeOnly || position < 0 || position >= peers.length - 1 },
      { title: "刷新工作树", action: close(() => run(`${MOD}.refresh`)) },
      { title: "从侧栏移除", action: close(() => {
        const current = state(), at = current.projects.findIndex(p => p.id === project.id);
        if (at >= 0) setShared("jherdr.undo", { project: current.projects[at], index: at });
        save(forgetProject(current, project.id));
        if (at >= 0) run(`${MOD}.notify-undo`);
      }) },
    ];
  }

  menuKey(e, cx) {
    const items = this.menuItems();
    if (e.key === "escape") closeOverlay(props().overlay);
    else if (e.key === "down") this.menuIndex = (this.menuIndex + 1) % items.length;
    else if (e.key === "up") this.menuIndex = (this.menuIndex + items.length - 1) % items.length;
    else if (e.key === "enter") { const item = items[this.menuIndex]; if (item && !item.disabled) item.action(cx); }
    else return;
    cx.stop_propagation(); cx.notify();
  }

  renderMenu(t) {
    const items = this.menuItems();
    return v_flex().id("project-menu").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx)).w_full().p(6).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .when(props().project, el => el.child(div().px(8).py(8).truncate().text_size(11).text_color(t.dim).child(props().worktree?.name || props().project.name)))
      .children(items.map((item, i) => h_flex().id(`menu-item-${i}`).h(32).px(9).gap(9).items_center().rounded(5).cursor_pointer()
        .when(i === this.menuIndex, el => el.bg(t.selected)).when(item.disabled, el => el.opacity(0.4))
        .hover(el => el.bg(t.hover)).on_click((_e, cx) => { if (!item.disabled) item.action(cx); })
        .when(item.icon, el => el.child(icon(item.icon, 15).text_color(t.muted))).child(item.title)
        .when(item.checked, el => el.child(div().flex_1()).child(icon("check", 13).text_color(t.accent)))))
      .when(this.menuLoading || this.menuError, el => el.child(div().px(8).py(8).text_size(11).text_color(t.dim).child(this.menuError || "正在查找可用 Agent…")))
      .when(props().menu === "project", el => el.child(div().px(8).py(6).text_size(10.5).text_color(t.dim).child("移除只隐藏入口，不删除文件或会话")));
  }

  dismissUndoToast() {
    if (!this.undoToast) return;
    const id = this.undoToast;
    this.undoToast = null;
    try { closeOverlay(id); } catch {}
  }

  showUndoToast(cx) {
    const undo = shared("jherdr.undo");
    if (!undo?.project) return;
    this.dismissUndoToast();
    const token = ++this.undoToken;
    this.undoToast = notify({
      title: `已从侧栏移除 ${undo.project.name}`,
      body: "点击撤销",
      timeout: 5000,
      action: { name: `${MOD}.undo` },
    });
    cx.spawn(async cx => {
      await cx.sleep(5000);
      if (this.undoToken !== token) return;
      this.dismissUndoToast();
      if (shared("jherdr.undo")) setShared("jherdr.undo", null);
    });
  }

  restore() {
    this.undoToken++;
    this.dismissUndoToast();
    const undo = shared("jherdr.undo");
    if (!undo?.project) return;
    const s = state();
    s.hidden = s.hidden.filter(id => id !== undo.project.id);
    if (!s.projects.some(p => p.id === undo.project.id)) s.projects.splice(Math.min(undo.index, s.projects.length), 0, undo.project);
    save(s); setShared("jherdr.undo", null);
  }

  renderForm(t) {
    const f = this.form;
    const action = projectActions.find(a => a.id === f.mode);
    const field = (label, input) => v_flex().gap(5)
      .child(div().text_color(t.muted).child(label))
      .child(Input.new(input).w_full().h(30).px(7).bg(t.background).rounded(5));
    const submit = f.created ? "打开项目" : f.mode === "clone" ? "克隆并打开" : "创建并打开";
    return v_flex().id("project-form").size_full().bg(t.chrome).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().px(14).h(39).items_center().gap(6)
        .child(icon(action.icon)).child(div().flex_1().text_size(13).font_medium().child(action.title))
        .child(this.button("back", "返回项目列表", cx => this.leaveForm(cx), t, "x", f.busy)))
      .child(v_flex().id("project-form-fields").px(14).py(8).gap(12).min_h(0).overflow_y_scrollbar().text_size(12)
        .when(!f.created, el => el
          .when(f.mode === "clone", el => el.child(field("仓库地址", f.url)))
          .when(f.mode === "template", el => el.child(v_flex().gap(5)
            .child(div().text_color(t.muted).child("项目模板"))
            .children([["web", "静态网页"], ["node", "Node.js 命令行"]].map(([id, title]) =>
              h_flex().id("template-" + id).h(29).px(8).gap(7).rounded(5).items_center().cursor_pointer()
                .bg(id === f.template ? t.selected : t.background).hover(s => s.bg(t.hover))
                .on_click((_e, cx) => { if (!f.busy) f.template = id; cx.notify(); })
                .child(div().w(14).when(id === f.template, el => el.child(icon("check", 13)))).child(title)))))
          .child(field(f.mode === "clone" ? "项目名称（可选）" : "项目名称", f.name))
          .child(v_flex().gap(5).child(div().text_color(t.muted).child("保存位置"))
            .child(h_flex().id("choose-parent").h(30).px(7).items_center().gap(7).bg(t.background).rounded(5)
              .cursor_pointer().tooltip(f.parent || "选择父文件夹").on_click((_e, cx) => cx.spawn(async cx => this.chooseParent(cx)))
              .child(icon("folder")).child(div().flex_1().truncate().child(f.parent || "选择文件夹…")))))
        .when(this.message, el => el.child(div().text_color("#E6B56D").child(this.message)))
        .child(h_flex().id("submit-project").h(31).items_center().justify_center().rounded(5).bg(t.selected)
          .when(f.busy, el => el.opacity(0.6)).cursor_pointer().on_click((_e, cx) => cx.spawn(async cx => this.submitForm(cx)))
          .child(f.busy ? "处理中…" : submit)));
  }

  render(cx) {
    const t = theme();
    if (props()?.zedToolbar) return this.renderZedToolbar(t);
    if (props()?.removeWorktree) return this.renderRemoval(t);
    if (this.agentSettings) return this.agentSettings.render(t);
    if (props()?.menu) return this.renderMenu(t);
    if (this.form) return this.renderForm(t);
    const s = state(), snap = snapshot(), tree = buildTree(orderedProjects(s), this.controller.cache, snap);
    const folded = this.foldedMap(s);
    const rows = flattenTree(tree, folded, this.query, s.activeOnly);
    const query = this.query.trim().toLowerCase();
    const other = visibleOtherSpaces(tree.otherSpaces, this.query, s.activeOnly)
      .map(space => ({ kind: "space", key: `space-${space.id}`, depth: 0, space, direct: true }));
    const summary = activeSummary(tree);
    this.items = [...rows, ...other];
    this.firstMatch = firstSearchHit(this.items, query);
    const active = rows.find(row => row.worker?.active) || rows.find(row => row.kind === "worktree" && row.worktree.active)
      || other.find(row => row.space.active) || rows.find(row => row.kind === "project" && row.project.active);
    setAgentOrder(rows.filter(r => r.kind === "worker").map(r => r.worker.address));
    const countColor = summary.blocked ? "#E6B56D" : summary.working ? "#A5C68D" : (s.activeOnly ? t.muted : t.dim);
    const filterTab = (id, label, on, badge, tip, select) => h_flex().id(id).h(22).px(7).gap(4).rounded(5).items_center()
      .text_size(11.5).cursor_pointer().tooltip(tip).accessibility_label(tip)
      .when(on, el => el.bg(t.selected).text_color(t.foreground).font_medium())
      .when(!on, el => el.text_color(t.muted).hover(el => el.text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); select(); cx.notify(); })
      .child(label)
      .when(badge > 0, el => el.child(div().text_size(10.5).text_color(countColor).child(String(badge))));
    return v_flex().id("jherdr-projects").size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .on_size_change((size, cx) => { if (this.sidebarWidth !== size.width) { this.sidebarWidth = size.width; cx.notify(); } })
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().h(39).px(10).gap(6).flex_none().items_center().justify_between()
        .child(h_flex().h(26).p(2).gap(2).rounded(6).bg(t.background).items_center().flex_none()
          .child(filterTab("filter-all", "全部", !s.activeOnly, 0, "显示全部项目", () => this.setActiveOnly(false)))
          .child(filterTab("filter-active", "活动", s.activeOnly, summary.total, "只看有活动 Agent 的项目", () => this.setActiveOnly(true))))
        .child(h_flex().gap(2).items_center().flex_none()
          .child(this.button("sort-projects", "项目排序", () => openOverlay({ mod: MOD, kind: "popup", width: 178, height: 108, props: { menu: "sort" } }), t, "sort"))
          .child(this.button("agent-settings", "Agent 设置", () => this.showAgentSettings(), t, "settings"))
          .child(this.button("refresh-projects", this.controller.busy ? "正在刷新" : "刷新工作树", cx => cx.spawn(async () => this.controller.refresh(true)), t, "refresh", this.controller.busy))
          .child(this.button("add-project", "添加项目", () => this.projectMenu(this.menuBounds), t, "folder", this.adding)
            .on_mouse_down("left", e => { this.menuBounds = e.bounds; }))))
      .child(h_flex().mx(10).mb(6).h(28).px(8).gap(7).items_center().flex_none().rounded(6).bg(t.background)
        .child(icon("search", 13).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(11.5).text_color(t.foreground)))
      .when(Boolean(this.message), el => el.child(div().px(14).pb(8).text_size(11).text_color("#E6B56D").child(this.message)))
      .child(v_flex().id("project-tree").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar().track_scroll(this.scroll)
        .on_mouse_up("left", (_e, cx) => this.endProjectDrag(cx))
        .on_hover((inside, cx) => { if (!inside) this.endProjectDrag(cx); })
        .children(rows.map(row => this.row(row, t, folded, active?.key, s.activeOnly)))
        .when(!this.items.length, el => el.child(v_flex().px(8).py(16).gap(10)
          .child(div().text_size(12).text_color(t.muted).child(
            this.controller.busy ? "正在读取项目…" :
            this.query ? "没有匹配的项目或 Worker" :
            s.activeOnly ? "当前没有活动的 Agent" : "固定一个项目，从这里继续工作"
          ))
          .when(!this.query && !this.controller.busy && s.activeOnly, el => el.child(this.button("show-all-projects", "查看全部项目", () => this.setActiveOnly(false), t)))
          .when(!this.query && !this.controller.busy && !s.activeOnly, el => el.child(this.button("add-first-project", "添加项目", () => this.projectMenu(), t)))))
        .when(other.length > 0, el => el.child(div().pt(18).pb(7).px(8).text_size(10.5).text_color(t.dim).child("其他工作空间")))
        .children(other.map(row => this.row(row, t, folded, active?.key, s.activeOnly))));
  }
}
