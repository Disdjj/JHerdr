export const LAYOUT = "jherdr";
export const MOD = "jherdr-projects";

// Used only on uninstall when the person permanently removed all old layouts.
// This creates a minimal usable native workspace; it does not recover deleted custom layouts.
export function recoveryLayout() {
  return { id: "root", type: "column", children: [
    { id: "tabs", type: "block", size: { px: 42 }, content: { mod: "tabs" } },
    { id: "main", type: "block", content: { tab: "active" } },
  ] };
}

export function buildLayout(source) {
  const layout = structuredClone(source);
  const find = (node, id) => node.id === id ? node : (node.children || []).map(c => find(c, id)).find(Boolean);
  const sidebar = find(layout, "sidebar");
  const lists = find(layout, "sidebar-lists");
  if (!sidebar || !lists) throw new Error("基线布局没有 sidebar / sidebar-lists；请选择 main 或 shepherdr 布局。");
  sidebar.size = { px: 310 };
  sidebar.min = 250;
  sidebar.max = 480;
  lists.children = [{ id: "spaces", type: "block", size: { weight: 1 }, min: 100, content: { mod: MOD } }];
  lists.resizable = false;
  const tabs = find(layout, "tabs");
  if (tabs?.type === "block") {
    const { content, window_drag } = tabs;
    delete tabs.content;
    delete tabs.window_drag;
    Object.assign(tabs, { type: "row", resizable: false, children: [
      { id: "jherdr-tab-strip", type: "block", content, window_drag, size: { weight: 1 } },
      { id: "jherdr-zed", type: "block", size: { px: 69 }, content: { mod: MOD, props: { zedToolbar: true } } },
    ] });
  }
  layout.preview = "layouts/jherdr-preview.svg";
  layout.colors = { ...(layout.colors || {}), canvas: "#0D0D17", background: "#0D0D17", chrome: "#141420",
    foreground: "#DDDDE7", muted: "#A3A3B8", dim: "#818199", border: "#292938", raised: "#20202E",
    hover: "#232332", selected: "#2C2C3E", accent: "#8C9EC6", popover: "#1B1B29" };
  return layout;
}
