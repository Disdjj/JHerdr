import test from "node:test";
import assert from "node:assert/strict";
import { ChangesController } from "../mods/jherdr-changes/controller.js";
import { changedFiles, changesLocation } from "../mods/jherdr-changes/model.js";
import { buildLayout } from "../scripts/layout.mjs";

const local = cwd => ({ cwd, on: null });
const ok = stdout => ({ code: 0, stdout, stderr: "" });

test("焦点绑定当前标签和机器，切换中的旧 pane 不提供提交目录", () => {
  const space = { id: "s", machine: "server", tabs: [{ id: "b", active: true }] };
  const f = { space: "s", tab: "b", pane: "p", cwd: "/B", terminal: "server/t1" };
  const pane = { pane: "p", tab: "b", cwd: "/B" };
  assert.deepEqual(changesLocation(space, f, [pane]), { cwd: "/B", on: "server" });
  assert.equal(changesLocation(space, f, [{ ...pane, tab: "a" }]), null);
  assert.equal(changesLocation(space, { ...f, space: "previous" }, [pane]), null);
  assert.equal(changesLocation({ ...space, folder: "/old" }, { ...f, cwd: null }, [{ ...pane, cwd: null }]), null);
  assert.deepEqual(changesLocation(space, { ...f, pane: null, terminal: "t1" }, []), local("/B"));
});

test("旧仓库的读取挂起时新仓库仍可刷新，往返同一仓库也丢弃旧结果", async () => {
  let finish;
  const pending = new Promise(r => { finish = r; });
  let delay = false;
  const exec = async (_cmd, args, { cwd }) => {
    if (args.includes("--show-toplevel")) return ok(cwd + "\n");
    if (args.includes("status")) {
      if (delay && cwd === "/A") return pending;
      return ok(cwd === "/A" ? "?? A.txt\0" : "");
    }
    return ok("");
  };
  const c = new ChangesController(exec, async () => "A\n");
  c.select(local("/A"));
  const first = c.state;
  await c.refresh(first);
  assert.equal(first.files[0].path, "A.txt");
  delay = true;
  const stale = c.refresh(first);
  await Promise.resolve();
  c.select(local("/B"));
  assert.deepEqual(c.state.files, []);
  assert.equal(c.state.root, null);
  await c.refresh(c.state);
  assert.equal(c.state.root, "/B");
  assert.equal(await c.commit(first, local("/B"), "wrong"), false);
  c.select(local("/A"));
  delay = false;
  await c.refresh(c.state);
  finish(ok("?? OLD.txt\0"));
  await stale;
  assert.deepEqual(c.state.files.map(f => f.path), ["A.txt"]);
  assert.equal(c.state.rows[1].text, "A");
});

test("提交按已显示的工作树执行，切换不能改写其中一半的目标", async () => {
  const calls = [];
  let finish;
  const adding = new Promise(r => { finish = r; });
  const c = new ChangesController(async (_cmd, args, options) => {
    calls.push([args, options]);
    return args[0] === "add" ? adding : ok("");
  });
  const linked = { cwd: "/linked/src", on: "server" };
  c.select(linked);
  const s = c.state;
  Object.assign(s, { root: "/linked", files: [{ path: "one" }] });
  assert.equal(await c.commit(s, { ...linked, on: null }, "wrong machine"), false);
  assert.equal(await c.commit(s, local("/other"), "wrong folder"), false);
  const commit = c.commit(s, linked, "only in linked");
  assert.equal(await c.commit(s, linked, "twice"), false);
  c.select(local("/other"));
  finish(ok(""));
  assert.equal(await commit, true);
  assert.deepEqual(calls, [
    [["add", "-A"], { cwd: "/linked", on: "server" }],
    [["commit", "-m", "only in linked"], { cwd: "/linked", on: "server" }],
  ]);
});

test("Git 文件名中的制表符和换行保持原样", () => {
  const path = "a\tb\nc.txt";
  assert.deepEqual(changedFiles(" M " + path + "\0", ["2\t3\t" + path + "\0"]).files,
    [{ path, kind: "M", fresh: false, add: 2, del: 3 }]);
});

test("布局仅接管原本指向官方 Changes 的侧栏位置", () => {
  const make = mod => ({ id: "root", children: [
    { id: "sidebar", children: [{ id: "sidebar-lists" }] },
    { id: "changes", type: "block", content: { mod } },
  ] });
  assert.equal(buildLayout(make("changes")).children[1].content.mod, "jherdr-changes");
  assert.equal(buildLayout(make("personal")).children[1].content.mod, "personal");
});
