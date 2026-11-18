import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildLayout } from "../scripts/layout.mjs";
const exec = promisify(execFile);
const base = { id: "root", children: [{ id: "sidebar", children: [{ id: "sidebar-lists", children: [{ id: "agents" }] }] }, { id: "work", marker: "keep" }] };

test("布局只替换侧栏列表，保留工作区结构", () => {
  const copy = structuredClone(base), next = buildLayout(base);
  assert.deepEqual(base, copy);
  assert.deepEqual(next.children[1], base.children[1]);
  assert.equal(next.children[0].children[0].children[0].content.mod, "jherdr-projects");
  assert.throws(() => buildLayout({ id: "root" }), /sidebar/);
});

test("Zed 固定在原标签栏右侧，重新生成布局不会重复插入", () => {
  const layout = structuredClone(base);
  const tabs = { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, content: { mod: "tabs" } };
  layout.children[1].children = [tabs];
  const result = buildLayout(layout);
  const bar = result.children[1].children[0];
  assert.deepEqual(bar.size, tabs.size);
  assert.deepEqual(bar.children[0].content, tabs.content);
  assert.equal(bar.children[0].window_drag, true);
  assert.deepEqual(bar.children[1].content, { mod: "jherdr-projects", props: { zedToolbar: true } });
  assert.deepEqual(buildLayout(result), result);
});

test("隔离安装：原布局不变，重装备份，卸载保留个人状态", async t => {
  const dir = await mkdtemp(join(tmpdir(), "jherdr-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "layouts"));
  const original = JSON.stringify(base);
  await writeFile(join(dir, "layouts/main.json"), original);
  const keysPath = join(dir, "keys.json");
  const keys = { global: { "cmd-o": "test.global" }, "layout:jherdr": { "alt-x": "test.other" } };
  await writeFile(keysPath, JSON.stringify(keys));
  const command = (...args) => exec(process.execPath, [resolve("scripts/install.mjs"), "--app-home", dir, "--skip-check", ...args]);
  await command("--dry-run");
  await assert.rejects(access(join(dir, "layouts/jherdr.json")));
  await command();
  await writeFile(join(dir, "shared.json"), '{"personal":"keep"}');
  await command();
  assert.equal(await readFile(join(dir, "layouts/main.json"), "utf8"), original);
  assert.deepEqual(JSON.parse(await readFile(keysPath, "utf8")), {
    ...keys, "layout:jherdr": { "alt-x": "test.other", "cmd-o": "jherdr-projects.open-zed" },
  });
  await command("--uninstall");
  assert.deepEqual(JSON.parse(await readFile(keysPath, "utf8")), keys);
  await assert.rejects(access(join(dir, "layouts/jherdr.json")));
  assert.equal(await readFile(join(dir, "shared.json"), "utf8"), '{"personal":"keep"}');
  keys["layout:jherdr"]["cmd-o"] = "test.custom";
  await writeFile(keysPath, JSON.stringify(keys));
  await command();
  await command("--uninstall");
  assert.deepEqual(JSON.parse(await readFile(keysPath, "utf8")), keys);
});

test("安装拒绝覆盖不属于本扩展的同名文件", async t => {
  const dir = await mkdtemp(join(tmpdir(), "jherdr-collision-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "layouts"));
  await writeFile(join(dir, "layouts/main.json"), JSON.stringify(base));
  await writeFile(join(dir, "layouts/jherdr.json"), "personal");
  await assert.rejects(exec(process.execPath, [resolve("scripts/install.mjs"), "--app-home", dir, "--skip-check"]), /不属于本安装/);
  assert.equal(await readFile(join(dir, "layouts/jherdr.json"), "utf8"), "personal");
});

test("升级关闭旧清理规则并保留全部默认布局", async t => {
  const dir = await mkdtemp(join(tmpdir(), "jherdr-defaults-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "layouts"));
  await mkdir(join(dir, "data/jherdr"), { recursive: true });
  await writeFile(join(dir, "data/jherdr/layout-policy.json"), JSON.stringify({ only: true, permanently: true }));
  for (const name of ["main", "terminals", "win98"]) await writeFile(join(dir, "layouts", name + ".json"), JSON.stringify(base));
  const command = (...args) => exec(process.execPath, [resolve("scripts/install.mjs"), "--app-home", dir, "--skip-check", ...args]);
  await command();
  await command();
  assert.deepEqual(JSON.parse(await readFile(join(dir, "data/jherdr/layout-policy.json"), "utf8")), { only: false, permanently: false });
  for (const name of ["main", "terminals", "win98"]) assert.deepEqual(JSON.parse(await readFile(join(dir, "layouts", name + ".json"), "utf8")), base);
  for (const flag of ["--only-layout", "--delete-other-layouts"]) await assert.rejects(command(flag), /默认布局必须保留/);
  await command("--uninstall");
  for (const name of ["main", "terminals", "win98"]) await access(join(dir, "layouts", name + ".json"));
});
