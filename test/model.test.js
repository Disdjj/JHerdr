import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, realpath, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { projectId, registerProject, stateOf, moveProject, dropProject, forgetProject, parseWorktrees, readRepository, buildTree, flattenTree, firstSearchHit, orderedProjects, githubOwner } from "../mods/jherdr-projects/model.js";
import { RepositoryController, openInZed, openActiveFolderInZed, removeWorktree } from "../mods/jherdr-projects/controller.js";
import { activeZedFolder } from "../mods/jherdr-projects/model.js";
const exec = promisify(execFile);
const execute = async (command, args) => {
  try { const r = await exec(command, args); return { ...r, code: 0 }; }
  catch (e) { return { code: e.code, stdout: e.stdout || "", stderr: e.stderr || "" }; }
};
const project = (root, machine = null) => ({ id: projectId(machine, root + "/.git"), machine, root, commonDir: root + "/.git", name: root.split("/").pop() });
const empty = () => ({ spaces: [], panes: [], agents: [], terminals: [], machines: [{ name: null, layout: "ready" }], focused: null });

test("右上角 Zed 跟随当前标签和分屏，在对应机器定位工作树", async () => {
  const space = { active: true, machine: "server", folder: "/repo", tabs: [{ id: "other" }, { id: "active", active: true }] };
  const panes = [{ tab: "other", cwd: "/unrelated" }, { tab: "active", cwd: "/repo" }, { tab: "active", cwd: "/feature/src", focused: true }];
  const target = activeZedFolder([space], panes, [{ name: "server", layout: "ready" }]);
  assert.deepEqual(target, { folder: "/feature/src", machine: "server" });
  assert.equal(activeZedFolder([space], panes, []), null);
  const calls = [];
  await openActiveFolderInZed(async (...args) => { calls.push(args); return { code: 0, stdout: "/feature\n" }; }, target);
  assert.equal(calls[0][2].on, "server");
  assert.deepEqual(calls[1].slice(0, 2), ["zed", ["--", "ssh://server/feature"]]);
});

test("Zed 在查看端启动：本地工作树路径作为单个参数，远端路径编码并保留 SSH 目标", async () => {
  const calls = [];
  const launch = async (...args) => { calls.push(args); return { code: 0 }; };
  const folder = "/repos/项目 a#b%";
  await openInZed(launch, folder, null);
  await openInZed(launch, folder, "build-host");
  assert.deepEqual(calls[0], ["zed", ["--", folder], { timeout: 15000 }]);
  assert.deepEqual(calls[1], ["zed", ["--", "ssh://build-host/repos/%E9%A1%B9%E7%9B%AE%20a%23b%25"], { timeout: 15000 }]);
  await assert.rejects(openInZed(launch, folder, "-oProxyCommand=other"), /别名/);
  await assert.rejects(openInZed(launch, "relative", null), /绝对路径/);
  await assert.rejects(openInZed(async () => ({ code: 1, stderr: "launch failed" }), folder), /launch failed/);
});

test("工作树共用本机或对应远程机器的启动图标，刷新后使用最新启动参数", async () => {
  const snap = empty();
  snap.machines.push({ name: "remote", layout: "ready" });
  snap.spaces.push(...["a", "b"].map(id => ({ id, machine: "remote", tabs: [] })));
  const calls = [];
  let args = ["agy", "--custom"];
  const controller = new RepositoryController({
    snapshot: () => snap, readState: () => stateOf(null), changed: () => {},
    listAgents: async ({ on }) => {
      calls.push(on);
      return on ? [{ key: "remote-agent", installed: true }] :
        [{ key: "agy", installed: true, run: args }, { key: "missing", installed: false }];
    },
  });
  await controller.refresh();
  await controller.refresh();
  assert.deepEqual(calls, [null, "remote"]);
  assert.deepEqual(controller.launchers.get(null).agents.map(a => a.key), ["agy"]);
  assert.deepEqual(controller.launchers.get("remote").agents.map(a => a.key), ["remote-agent"]);
  args = ["agy", "--dangerously-skip-permissions"];
  snap.machines[1].layout = "unavailable";
  await controller.refresh(true);
  assert.equal(controller.launchers.has("remote"), false);
  assert.deepEqual(controller.launchers.get(null).agents[0].run, args);
});

test("真实 Git：从任意 worktree 识别同一项目，保留特殊字符路径与 detached 状态", async t => {
  const dir = await mkdtemp(join(tmpdir(), "jherdr-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "项目 ' $(no-command)"), work = join(dir, "分支\nwith space");
  await mkdir(root);
  await exec("git", ["init", "-b", "main", root]);
  await exec("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
  await exec("git", ["-C", root, "worktree", "add", "--detach", work]);
  const first = await readRepository(execute, root), second = await readRepository(execute, work);
  assert.equal(first.project.id, second.project.id);
  assert.equal(first.worktrees.length, 2);
  assert.equal(first.worktrees[1].path, await realpath(work));
  assert.equal(first.worktrees[1].detached, true);
  await exec("git", ["-C", root, "worktree", "lock", "--reason", "保留\n工作", work]);
  const locked = await readRepository(execute, root);
  assert.equal(locked.worktrees[1].locked, "保留\n工作");
});

test("没有首次提交的仓库仍可固定", async t => {
  const root = await mkdtemp(join(tmpdir(), "jherdr-unborn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await exec("git", ["init", "-b", "main", root]);
  const result = await readRepository(execute, root);
  assert.equal(result.worktrees[0].branch, "main");
});

test("删除前复核工作树，拒绝主目录、锁和未提交文件，成功后保留分支", async t => {
  const dir = await mkdtemp(join(tmpdir(), "jherdr-remove-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"), linked = join(dir, "linked checkout");
  const git = (...args) => exec("git", ["-C", root, ...args]);
  await exec("git", ["init", "-b", "main", root]);
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
  await git("worktree", "add", "-b", "feature", linked);
  const { project, worktrees: [main, feature] } = await readRepository(execute, root);
  const remove = target => removeWorktree(execute, project, target);
  await assert.rejects(remove(main), /主工作树/);
  await assert.rejects(remove({ ...feature, branch: "stale" }), /工作树已变化/);
  await git("worktree", "lock", linked);
  await assert.rejects(remove(feature), /锁定/);
  await git("worktree", "unlock", linked);
  const file = join(linked, "unfinished");
  await writeFile(file, "keep");
  await assert.rejects(remove(feature));
  assert.equal(await readFile(file, "utf8"), "keep");
  await rm(file);
  await remove(feature);
  await assert.rejects(access(linked), { code: "ENOENT" });
  await git("show-ref", "--verify", "refs/heads/feature");
  await assert.rejects(remove(feature), /工作树已变化/);
});

test("同名项目和同路径远程项目不合并；关闭会话不改变固定顺序", () => {
  const a = project("/a/repo"), b = project("/b/repo"), c = project("/a/repo", "server");
  let state = stateOf(null);
  for (const p of [a, b, c]) state = registerProject(state, p);
  const before = JSON.stringify(state);
  const next = moveProject(state, c.id, -1);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(next.projects.map(p => p.id), [a.id, c.id, b.id]);
  assert.equal(buildTree(next.projects, {}, empty()).projects.length, 3);
});

test("移除入口后不会被自动发现立即加回；显式添加可恢复", () => {
  const p = project("/repo");
  const hidden = forgetProject(registerProject(null, p), p.id);
  assert.equal(registerProject(hidden, p).projects.length, 0);
  assert.equal(registerProject(hidden, p, true).projects.length, 1);
});

test("拖放以当前可见顺序为起点，向前或向后插入，只在同一置顶分组内保存", () => {
  const [c, a, b, p] = ["c", "a", "b", "p"].map(name => project("/" + name));
  p.pinned = true;
  const initial = stateOf({ projects: [c, p, a, b], sort: "asc", folded: { [a.id]: true } });
  const moved = dropProject(initial, a.id, c.id, true);
  assert.deepEqual(moved.projects.map(x => x.name), ["p", "b", "c", "a"]);
  assert.equal(moved.sort, "manual");
  assert.deepEqual(moved.folded, initial.folded);
  assert.deepEqual(dropProject(moved, a.id, b.id, false).projects.map(x => x.name), ["p", "a", "b", "c"]);
  for (const [from, to] of [[a.id, p.id], [p.id, a.id], [a.id, a.id], ["removed", a.id], [a.id, "removed"], [a.id, b.id]]) {
    assert.equal(dropProject(initial, from, to, false), initial);
  }
});

test("GitHub 头像优先取 origin 的 fetch 地址，只保存所有者", () => {
  const upstream = "upstream\tgit@github.com:Upstream/repo.git (fetch)";
  assert.equal(githubOwner(upstream + "\norigin\thttps://user:secret@github.com/My-Org/repo.git (fetch)"), "my-org");
  assert.equal(githubOwner("origin\thttps://git.example.com/a/repo (fetch)\n" + upstream), "upstream");
  assert.equal(githubOwner("origin\tssh://git@github.com:22/Owner/repo.git (fetch)"), "owner");
  assert.equal(githubOwner("origin\thttps://github.com.example.com/Owner/repo.git (fetch)"), null);
  assert.equal(githubOwner("origin\tgit@github.com:Owner/repo.git (push)"), null);
  assert.equal(githubOwner(""), null);
});

test("远程 Git 项目的头像缓存在查看端，同一所有者复用缓存", async () => {
  const calls = [];
  const controller = new RepositoryController({ avatarScript: "/viewer/github-avatar.mjs", execute: async (...args) => {
    calls.push(args);
    return { code: 0, stdout: "data/jherdr/avatars/org.png\n" };
  } });
  await controller.refreshAvatar("org");
  await controller.refreshAvatar("org");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ["/viewer/github-avatar.mjs", "org"]);
  assert.equal(calls[0][2].on, undefined);
  assert.equal(controller.avatars.get("org").path, "data/jherdr/avatars/org.png");
});

test("旧项目保留手动顺序，置顶和组内调整在刷新后保留", () => {
  const z = project("/z"), p = { ...project("/p"), pinned: true }, a = project("/a");
  const old = stateOf({ projects: [z, p, a] });
  const names = s => orderedProjects(s).map(item => item.name);
  assert.deepEqual(names(old), ["p", "z", "a"]);
  assert.deepEqual(names({ ...old, sort: "asc" }), ["p", "a", "z"]);
  assert.deepEqual(names({ ...old, sort: "desc" }), ["p", "z", "a"]);
  assert.deepEqual(names(moveProject(old, z.id, 1)), ["p", "a", "z"]);
  assert.deepEqual(names(moveProject(old, p.id, 1)), names(old));
  const refreshed = registerProject(old, project("/p"));
  assert.equal(refreshed.projects[1].pinned, true);
  assert.deepEqual(old.projects.map(item => item.id), [z.id, p.id, a.id]);
});

test("精确归属：最长 worktree 前缀、目录边界、机器隔离、子 worker 去重", () => {
  const p = project("/repo"), nested = project("/repo/nested"), remote = project("/repo", "server");
  const cache = Object.fromEntries([p, nested, remote].map(p => [p.id, { worktrees: [{ path: p.root, name: "main" }] }]));
  const snap = empty();
  snap.machines.push({ name: "server", layout: "ready" });
  snap.terminals = [
    { address: "t1", cwd: "/repo/src", state: "live", status: "working", program: { agent: true, name: "Codex" } },
    { address: "t2", cwd: "/repo/nested", state: "live", status: "blocked", parent: "t1" },
    { address: "t3", cwd: "/repo-other", state: "live", status: "working" },
    { address: "server/t4", cwd: "/repo", state: "live", status: "working" },
    { address: "t5", cwd: "/repo", state: "exited", status: "done" },
  ];
  snap.agents = [{ address: "t1", status: "working", program: { name: "Codex", agent: true } }];
  const tree = buildTree([p, nested, remote], cache, snap);
  assert.deepEqual(tree.projects.map(p => p.worktrees[0].workers.map(w => w.address)), [["t1"], ["t2"], ["server/t4"]]);
  assert.equal(tree.projects[1].counts.blocked, 1);
});

test("当前 pane 的 cwd 优先于启动目录，离线不会显示仍在运行", () => {
  const p = project("/repo", "server"), snap = empty();
  snap.machines.push({ name: "server", layout: "unavailable" });
  snap.terminals = [{ address: "server/t1", cwd: "/home/user", state: "live", status: "working" }];
  snap.panes = [{ terminal: "server/t1", cwd: "/repo/src" }];
  const tree = buildTree([p], { [p.id]: { worktrees: [{ path: "/repo", name: "main" }] } }, snap);
  assert.equal(tree.projects[0].worktrees[0].workers[0].status, "offline");
  assert.equal(tree.projects[0].counts.working, 0);
});

test("搜索展开匹配分支但不改变持久折叠状态", () => {
  const p = project("/repo"), snap = empty();
  snap.terminals = [{ address: "t1", cwd: "/repo", state: "live", status: "working", program: { name: "Codex" } }];
  const tree = buildTree([p], { [p.id]: { worktrees: [{ path: "/repo", name: "feature" }] } }, snap);
  const folded = { [p.id]: true };
  assert.equal(flattenTree(tree, folded).length, 1);
  assert.deepEqual(flattenTree(tree, folded, "codex").map(r => r.kind), ["project", "worktree", "worker"]);
  assert.equal(folded[p.id], true);
});

test("Git 错误保留上次成功的数据；并发刷新不重复启动", async () => {
  const p = project("/repo");
  let count = 0;
  const controller = new RepositoryController({ execute: async () => { count++; await new Promise(r => setTimeout(r, 5)); throw new Error("Permission denied"); },
    readState: () => ({ projects: [p] }), writeState: () => {}, snapshot: empty, changed: () => {} });
  controller.cache[p.id] = { worktrees: [{ path: "/repo", name: "main" }], at: 0 };
  await Promise.all([controller.refresh(true), controller.refresh(true)]);
  assert.equal(count, 1);
  assert.equal(controller.cache[p.id].worktrees.length, 1);
  assert.equal(controller.cache[p.id].error, "Permission denied");
});

test("Space 初始目录过时不会出现重复入口，多个 tab 分别归属对应 worktree", () => {
  const p = project("/repo"), snap = empty();
  snap.spaces = [{ id: "s1", folder: "/home/user", active: true, tabs: [{ id: "a", active: false }, { id: "b", active: true }] }];
  snap.panes = [{ terminal: "t1", tab: "a", cwd: "/repo/src" }, { terminal: "t2", tab: "b", cwd: "/other-worktree/src" }];
  const tree = buildTree([p], { [p.id]: { worktrees: [{ path: "/repo", name: "main" }, { path: "/other-worktree", name: "feature" }] } }, snap);
  assert.equal(tree.otherSpaces.length, 0);
  assert.deepEqual(tree.projects[0].worktrees.map(w => w.active), [false, true]);
  assert.deepEqual(tree.projects[0].worktrees.map(w => w.spaces[0].tabId), ["a", "b"]);
});

test("普通终端切到新仓库后也会触发项目发现", async () => {
  const snap = empty();
  snap.spaces = [{ folder: "/home/user", tabs: [{ id: "a" }] }];
  snap.panes = [{ tab: "a", cwd: "/new-repo" }];
  let value = stateOf(null);
  const execute = async (_cmd, args) => {
    if (args.includes("rev-parse")) return args[1] === "/new-repo" ? { code: 0, stdout: "/new-repo/.git\n" } : { code: 1, stderr: "not a git repository" };
    return { code: 0, stdout: "worktree /new-repo\0branch refs/heads/main\0\0" };
  };
  const controller = new RepositoryController({ execute, readState: () => value, writeState: next => { value = next; }, snapshot: () => snap, changed: () => {} });
  await controller.refresh();
  assert.equal(value.projects.length, 1);
  assert.equal(value.projects[0].root, "/new-repo");
});

test("bare 条目不会冒充可打开的工作目录", () => {
  assert.deepEqual(parseWorktrees("worktree /bare\0bare\0\0"), []);
});

test("搜索定位具体 Worker，排除同分支的无关会话，精确名称优先于分支前缀", () => {
  const p = project("/repo"), snap = empty();
  const branches = [{ path: "/sandbox", name: "codex/lint" }, { path: "/repo", name: "main" }];
  snap.terminals = ["Codex", "Claude"].map((name, i) => ({
    address: "t" + i, cwd: "/repo", state: "live", status: "working", program: { name, agent: true },
  }));
  const tree = buildTree([p], { [p.id]: { worktrees: branches } }, snap);
  const rows = flattenTree(tree, { [p.id]: true }, "Codex");
  assert.deepEqual(rows.filter(r => r.worker).map(r => r.worker.name), ["Codex"]);
  assert.equal(firstSearchHit(rows, "Codex").key, "t0");
  assert.equal(firstSearchHit(flattenTree(tree, {}, "t1"), "t1").worker.name, "Claude");
});

test("同一机器上的同名项目显示能区分来源的最短父路径", () => {
  const projects = ["/a/tools/demo", "/b/tools/demo", "/code/demo", "/unique"].map(path => project(path));
  const tree = buildTree(projects, {}, empty());
  assert.deepEqual(tree.projects.map(p => p.qualifier), ["a/tools", "b/tools", "code", undefined]);
});
