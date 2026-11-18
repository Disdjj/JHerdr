import { agentCatalog, parseProgramFile } from "./agent-config.js";

import { stateOf, registerProject, readRepository, normalize, snapshotWorkers, zedTarget } from "./model.js";

export async function openInZed(execute, folder, machine) {
  const result = await execute("zed", ["--", zedTarget(folder, machine)], { timeout: 15000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Zed 启动失败，请检查本机的 zed 命令");
}

export async function openActiveFolderInZed(execute, { folder, machine }) {
  let root;
  try {
    const git = await execute("git", ["-C", folder, "rev-parse", "--show-toplevel"], { on: machine, timeout: 5000 });
    if (git.code === 0) root = git.stdout.replace(/\r?\n$/, "");
  } catch { /* Plain directories also open when Git is unavailable. */ }
  return openInZed(execute, root || folder, machine);
}

// All asynchronous discovery is bounded. A slow/offline repository keeps its previous tree.
export class RepositoryController {
  constructor({ execute, readState, writeState, snapshot, changed, listAgents, avatarScript }) {
    Object.assign(this, { execute, readState, writeState, snapshot, changed, listAgents, avatarScript });
    this.cache = {};
    this.avatars = new Map();
    this.launchers = new Map();
    this.launcherVersion = 0;
    this.checked = new Map();
    this.busy = false;
    this.stopped = false;
  }

  saveProject(project, explicit = false) {
    const old = this.readState();
    const next = registerProject(old, project, explicit);
    if (JSON.stringify(old) !== JSON.stringify(next)) this.writeState(next);
  }

  async add(folder, machine = null) {
    const result = await readRepository(this.execute, folder, machine);
    if (this.stopped) return;
    this.cache[result.project.id] = { worktrees: result.worktrees, at: Date.now() };
    this.saveProject(result.project, true);
    this.changed();
    return result.project;
  }

  async resolveFolder(folder, allowPlain) {
    const top = await this.execute("git", ["-C", folder, "rev-parse", "--show-toplevel"], { timeout: 10000 });
    if (top.code !== 0) {
      if (allowPlain && /not a git repository|不是.*git 仓库|不在.*git 仓库/i.test(top.stderr)) return { plain: true };
      throw new Error(top.stderr.trim() || "无法读取项目目录");
    }
    const checkout = top.stdout.replace(/\r?\n$/, "");
    const project = await this.add(checkout);
    return project && { project, checkout };
  }

  async createProject(app, mode, parent, name, source) {
    const result = await this.execute("node", [app + "/data/jherdr/bin/create-project.mjs", mode, parent, name, source], { timeout: 600000 });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "无法创建项目");
    return JSON.parse(result.stdout);
  }

  invalidateLaunchers() {
    this.launcherVersion++;
    this.launchers.clear();
    this.changed();
    return this.refresh();
  }

  async refreshAvatar(owner) {
    const cached = this.avatars.get(owner);
    if (cached && Date.now() < cached.retryAt) return;
    let path = cached?.path;
    let delay = 300000;
    try {
      // The checkout may be remote, but the GPUI image is read on this computer.
      const result = await this.execute("node", [this.avatarScript, owner], { timeout: 10000 });
      if (result.code === 0) { path = result.stdout.trim(); delay = 86400000; }
    } catch { /* Keep a previous image through a transient network or launcher failure. */ }
    this.avatars.set(owner, { path, retryAt: Date.now() + delay });
  }

  async refresh(force = false) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    const version = this.launcherVersion;
    this.changed();
    try {
      const state = stateOf(this.readState()), snap = this.snapshot();
      const available = machine => machine == null || snap.machines.some(m => m.name === machine && m.layout === "ready");
      const hosts = new Set([null, ...state.projects.map(p => p.machine), ...snap.spaces.map(s => s.machine ?? null)]);
      const jobs = [];
      for (const machine of hosts) {
        if (!available(machine)) { this.launchers.delete(machine); continue; }
        const previous = this.launchers.get(machine);
        if (!this.listAgents || (!force && previous && Date.now() - previous.at < 60000)) continue;
        jobs.push(async () => {
          try {
            const agents = await this.listAgents({ on: machine });
            if (this.launcherVersion === version) this.launchers.set(machine, { agents: agents.filter(a => a.installed), at: Date.now() });
          } catch {
            if (this.launcherVersion === version) this.launchers.set(machine, { error: true, at: Date.now() });
          }
        });
      }
      for (const project of state.projects.filter(p => available(p.machine))) jobs.push(async () => {
        if (!force && Date.now() - (this.cache[project.id]?.at || 0) < 30000) return;
        try {
          const result = await readRepository(this.execute, project.root, project.machine, project.commonDir);
          if (this.stopped) return;
          this.cache[project.id] = { worktrees: result.worktrees, at: Date.now() };
          this.saveProject(result.project);
        } catch (error) {
          this.cache[project.id] = { ...this.cache[project.id], error: String(error.message || error), at: Date.now() };
        }
      });
      const candidates = new Map();
      const add = (folder, machine = null) => {
        if (!folder || !available(machine)) return;
        const key = JSON.stringify([machine, normalize(folder)]);
        if (!force && Date.now() - (this.checked.get(key) || 0) < 120000) return;
        candidates.set(key, { folder, machine });
      };
      for (const s of snap.spaces) add(s.folder, s.machine ?? null);
      const tabMachines = new Map(snap.spaces.flatMap(s => (s.tabs || []).map(t => [t.id, s.machine ?? null])));
      for (const pane of snap.panes) if (tabMachines.has(pane.tab)) add(pane.cwd, tabMachines.get(pane.tab));
      for (const worker of snapshotWorkers(snap)) add(worker.cwd, worker.machine);
      for (const [key, { folder, machine }] of candidates) jobs.push(async () => {
        this.checked.set(key, Date.now());
        try {
          const result = await readRepository(this.execute, folder, machine);
          if (this.stopped) return;
          this.cache[result.project.id] = { worktrees: result.worktrees, at: Date.now() };
          this.saveProject(result.project);
        } catch { /* A shell's folder need not be a repository. Saved projects surface errors above. */ }
      });
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
        while (index < jobs.length && !this.stopped) {
          await jobs[index++]();
          if (!this.stopped) this.changed();
        }
      }));
      if (this.avatarScript && !this.stopped) {
        const owners = [...new Set(this.readState().projects.map(p => p.githubOwner).filter(Boolean))];
        for (let i = 0; i < owners.length && !this.stopped; i += 3) {
          await Promise.all(owners.slice(i, i + 3).map(owner => this.refreshAvatar(owner)));
        }
      }
    } finally {
      this.busy = false;
      if (!this.stopped) this.changed();
      if (version !== this.launcherVersion) await this.refresh();
    }
  }
}

export async function readAgentCatalog(readConfig, discover, machine = null) {
  const [source, agents] = await Promise.all([readConfig(), discover({ on: machine })]);
  return { source, agents: agentCatalog(agents, parseProgramFile(source)) };
}
