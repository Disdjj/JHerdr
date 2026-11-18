// Pure data model: no host calls, subprocesses, or UI state mutation.
export const STATE_KEY = "jherdr.projects.v1";
export const PROJECT_SORTS = { manual: "手动排序", asc: "名称 A → Z", desc: "名称 Z → A" };
// Only retain the public owner name. Remote URLs may include private paths and credentials.
export function githubOwner(remotes) {
  let other = null;
  for (const line of remotes.split(/\r?\n/)) {
    const fetch = /^(\S+)\s+(.+?)\s+\(fetch\)$/.exec(line);
    if (!fetch) continue;
    const url = fetch[2];
    const match = /^(?:(?:https?|ssh|git):\/\/(?:[^\s/@]+@)?github\.com(?::\d+)?\/|(?:[\w.-]+@)?github\.com:)([a-z\d][a-z\d-]{0,38})\/[\w.-]+\/?$/i.exec(url);
    if (match && fetch[1] === "origin") return match[1].toLowerCase();
    if (match && !other) other = match[1].toLowerCase();
  }
  return other;
}

export function orderedProjects({ projects, sort }) {
  return [...projects].sort((a, b) => {
    const pins = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pins || sort === "manual") return pins;
    return (sort === "desc" ? -1 : 1) * a.name.localeCompare(b.name);
  });
}
export const LABELS = { working: "运行中", blocked: "需要你", done: "已完成", idle: "空闲", unknown: "状态未知", offline: "离线" };
export const basename = (path) => String(path ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
export const normalize = (path) => {
  const value = String(path ?? "");
  return (/^[A-Za-z]:[\\/]|^\\\\/.test(value) ? value.replace(/\\/g, "/") : value).replace(/\/+$/, "") || "/";
};
export const contains = (root, path) => Boolean(root && path) && (normalize(root) === normalize(path) || normalize(path).startsWith(normalize(root) + (normalize(root) === "/" ? "" : "/")));
export const machineOf = (address) => address?.includes("/") ? address.slice(0, address.indexOf("/")) : null;
export const projectId = (machine, commonDir) => JSON.stringify([machine ?? null, normalize(commonDir)]);
export const worktreeId = (project, path) => JSON.stringify([project.id, normalize(path)]);

// Show only as much of the parent directory as is needed to tell equal names apart.
function qualifyProjects(projects) {
  const groups = new Map();
  for (const p of projects) {
    const key = JSON.stringify([p.machine, p.name]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const parents = group.map(p => normalize(p.root).split("/").slice(0, -1));
    parents.forEach((parts, index) => {
      let length = 1;
      while (length < parts.length && parents.some((other, i) =>
        i !== index && other.slice(-length).join("/") === parts.slice(-length).join("/"))) length++;
      group[index].qualifier = parts.slice(-length).join("/") || "/";
    });
  }
}

export function stateOf(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const unique = new Set();
  return {
    version: 1,
    sort: Object.hasOwn(PROJECT_SORTS, source.sort) ? source.sort : "manual",
    projects: (Array.isArray(source.projects) ? source.projects : []).filter(p => {
      if (!p || typeof p.id !== "string" || typeof p.root !== "string" || typeof p.commonDir !== "string" || unique.has(p.id)) return false;
      unique.add(p.id);
      return true;
    }),
    hidden: Array.isArray(source.hidden) ? source.hidden.filter(x => typeof x === "string") : [],
    folded: source.folded && typeof source.folded === "object" && !Array.isArray(source.folded) ? { ...source.folded } : {},
  };
}

export function registerProject(raw, project, explicit = false) {
  const state = stateOf(raw);
  if (state.hidden.includes(project.id) && !explicit) return state;
  if (explicit) state.hidden = state.hidden.filter(id => id !== project.id);
  const old = state.projects.find(p => p.id === project.id);
  state.projects = old
    ? state.projects.map(p => p.id === project.id ? { ...p, ...project, name: p.name || project.name } : p)
    : [...state.projects, project];
  return state;
}

export function moveProject(raw, id, delta) {
  const state = stateOf(raw);
  const from = state.projects.findIndex(p => p.id === id);
  if (from < 0 || state.sort !== "manual") return state;
  const project = state.projects[from];
  const group = state.projects.filter(p => Boolean(p.pinned) === Boolean(project.pinned));
  const neighbor = group[group.indexOf(project) + delta];
  if (neighbor) {
    const to = state.projects.indexOf(neighbor);
    [state.projects[from], state.projects[to]] = [neighbor, project];
  }
  return state;
}

export function dropProject(raw, sourceId, targetId, after) {
  const projects = orderedProjects(raw);
  const from = projects.findIndex(p => p.id === sourceId);
  const to = projects.findIndex(p => p.id === targetId);
  if (from < 0 || to < 0 || from === to || Boolean(projects[from].pinned) !== Boolean(projects[to].pinned)) return raw;
  const insertion = to + Number(after) - Number(from < to);
  if (from === insertion) return raw;
  const [source] = projects.splice(from, 1);
  projects.splice(insertion, 0, source);
  return { ...raw, projects, sort: "manual" };
}

export function forgetProject(raw, id) {
  const state = stateOf(raw);
  return { ...state, projects: state.projects.filter(p => p.id !== id), hidden: [...new Set([...state.hidden, id])] };
}

// --porcelain -z is essential: paths/reasons may contain spaces, quotes or newlines.
export function parseWorktrees(text) {
  const records = []; let current = null;
  for (const token of text.split("\0")) {
    if (!token) { if (current) records.push(current); current = null; continue; }
    const split = token.indexOf(" ");
    const key = split < 0 ? token : token.slice(0, split), value = split < 0 ? "" : token.slice(split + 1);
    if (key === "worktree") { if (current) records.push(current); current = { path: value, branch: null }; }
    else if (current && key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (current && key === "HEAD") current.head = value;
    else if (current && ["bare", "detached", "locked", "prunable"].includes(key)) current[key] = value || true;
  }
  if (current) records.push(current);
  return records.filter(w => !w.bare).map(w => ({ ...w, name: w.branch || (w.detached ? `detached · ${(w.head || "").slice(0, 7)}` : basename(w.path)) }));
}

export async function readRepository(execute, folder, machine = null, knownCommonDir = null) {
  const options = { on: machine, timeout: 10000 };
  let commonDir = knownCommonDir;
  if (!commonDir) {
    const common = await execute("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"], options);
    if (common.code !== 0) throw new Error(common.stderr.trim() || "不是 Git 仓库，或目录不可访问");
    commonDir = common.stdout.replace(/\r?\n$/, "");
  }
  const list = await execute("git", ["--git-dir", commonDir, "worktree", "list", "--porcelain", "-z"], options);
  if (list.code !== 0) throw new Error(list.stderr.trim() || "无法读取工作树");
  const worktrees = parseWorktrees(list.stdout);
  if (!worktrees.length) throw new Error("该仓库尚无可用的工作目录");
  const root = worktrees[0].path;
  const metadata = {};
  try {
    const remotes = await execute("git", ["-C", root, "remote", "-v"], options);
    if (remotes.code === 0) metadata.githubOwner = githubOwner(remotes.stdout);
  } catch { /* Optional metadata: a failed lookup must not hide a working checkout. */ }
  return { project: { id: projectId(machine, commonDir), machine, root, commonDir, name: basename(root), ...metadata }, worktrees };
}

export function snapshotWorkers(snapshot) {
  const panes = new Map(snapshot.panes.filter(p => p.terminal).map(p => [p.terminal, p]));
  const agents = new Map(snapshot.agents.map(a => [a.address, a]));
  const raw = new Map(snapshot.terminals.filter(t => t.state === "live").map(t => [t.address, t]));
  for (const a of snapshot.agents) if (!raw.has(a.address)) raw.set(a.address, { ...a, state: "live" });
  const result = [];
  for (const [address, terminal] of raw) {
    const pane = panes.get(address), agent = agents.get(address), program = agent?.program || pane?.program || terminal.program;
    if (!agent && !program?.agent && !terminal.status) continue;
    const parent = raw.get(terminal.parent);
    // Some CLI sessions only publish their startup cwd; the live pane is more accurate.
    const cwd = pane?.cwd || terminal.foreground?.cwd || terminal.cwd || parent?.foreground?.cwd || parent?.cwd;
    const reported = agent?.status || pane?.status || terminal.status;
    const status = reported === "error" ? "blocked" : LABELS[reported] ? reported : "unknown";
    result.push({ address, machine: machineOf(address), cwd, status,
      name: program?.name || agent?.app || terminal.name || terminal.agent || address,
      title: pane?.title || agent?.title || terminal.name || "",
      program, parent: terminal.parent, pane: pane?.pane || agent?.pane,
      active: (snapshot.focused?.shown || snapshot.focused?.terminal) === address,
    });
  }
  return result;
}

export function buildTree(projects, cache, snapshot) {
  const workers = snapshotWorkers(snapshot), trees = projects.map(project => {
    const record = cache[project.id];
    const machine = snapshot.machines.find(m => (m.name ?? null) === (project.machine ?? null));
    const offline = machine?.layout === "unavailable" || (project.machine != null && !machine);
    return { ...project, error: record?.error || null, loading: !record, offline,
      worktrees: (record?.worktrees || []).map(w => ({ ...w, id: worktreeId(project, w.path), workers: [], spaces: [] })) };
  });
  qualifyProjects(trees);
  // Longest matching checkout wins: nested repositories must not steal each other's agents.
  const destinations = trees.flatMap(p => p.worktrees.map(w => ({ p, w }))).sort((a, b) => normalize(b.w.path).length - normalize(a.w.path).length);
  for (const worker of workers) {
    const found = destinations.find(({ p, w }) => p.machine === worker.machine && contains(w.path, worker.cwd));
    if (found) found.w.workers.push({ ...worker, status: found.p.offline ? "offline" : worker.status });
  }
  const linkedSpaces = new Set();
  for (const space of snapshot.spaces) {
    const tabs = new Map((space.tabs || []).map(tab => [tab.id, tab]));
    const ownPanes = snapshot.panes.filter(pane => tabs.has(pane.tab) && pane.cwd);
    const locations = ownPanes.length ? ownPanes.map(pane => ({ path: pane.cwd, tab: tabs.get(pane.tab) })) : [{ path: space.folder }];
    for (const location of locations) {
      const found = destinations.find(({ p, w }) => (p.machine ?? null) === (space.machine ?? null) && contains(w.path, location.path));
      if (found) {
        const active = space.active && (!location.tab || location.tab.active) &&
          (!snapshot.focused?.cwd || contains(found.w.path, snapshot.focused.cwd));
        const old = found.w.spaces.find(s => s.id === space.id);
        if (old && active) { old.active = true; old.tabId = location.tab?.id; }
        else if (old) continue;
        else found.w.spaces.push({ ...space, active, tabId: location.tab?.id });
        linkedSpaces.add(space.id);
      }
    }
  }
  for (const project of trees) {
    project.counts = { working: 0, blocked: 0, done: 0 };
    for (const w of project.worktrees) {
      w.active = w.spaces.some(s => s.active) || w.workers.some(a => a.active);
      for (const a of w.workers) if (a.status in project.counts) project.counts[a.status]++;
    }
    project.active = project.worktrees.some(w => w.active);
  }
  return { projects: trees, otherSpaces: snapshot.spaces.filter(s => !linkedSpaces.has(s.id)) };
}

export function flattenTree(tree, folded = {}, query = "") {
  const rows = [], q = query.trim().toLowerCase();
  const match = (...s) => !q || s.filter(Boolean).join(" ").toLowerCase().includes(q);
  for (const project of tree.projects) {
    const full = match(project.name, project.root, project.machine);
    const children = [];
    for (const worktree of project.worktrees) {
      const branchMatch = match(worktree.name, worktree.path);
      const workers = [];
      for (const worker of worktree.workers) {
        const direct = match(worker.name, worker.title, worker.address, LABELS[worker.status]);
        if (direct || full || branchMatch) workers.push({ kind: "worker", key: worker.address, project, worktree, worker, depth: 2, direct });
      }
      if (!full && !branchMatch && !workers.length) continue;
      children.push({ kind: "worktree", key: worktree.id, project, worktree, depth: 1, direct: branchMatch });
      if (q || !folded[worktree.id]) children.push(...workers);
    }
    if (!full && !children.length) continue;
    rows.push({ kind: "project", key: project.id, project, depth: 0, direct: full });
    if (q || !folded[project.id]) rows.push(...children);
  }
  return rows;
}

export function firstSearchHit(rows, query) {
  const term = query.trim().toLowerCase();
  if (term) {
    const exact = rows.find(row => {
      if (!row.direct) return false;
      const item = row[row.kind];
      return [item.name, item.address].some(value => value?.toLowerCase() === term);
    });
    if (exact) return exact;
  }
  return rows.find(row => row.direct);
}
