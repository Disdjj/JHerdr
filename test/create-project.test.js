import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const exec = promisify(execFile);
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "jherdr-project-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, create: async (mode, name, source = "") => JSON.parse((await exec(process.execPath,
    [resolve("scripts/create-project.mjs"), mode, dir, name, source])).stdout) };
}

test("新建项目与两个模板可直接使用，保留特殊字符目录名", async t => {
  const { dir, create } = await setup(t);
  const empty = await create("new", "新项目 $(example)");
  assert.equal(empty, join(dir, "新项目 $(example)"));
  assert.equal((await exec("git", ["-C", empty, "symbolic-ref", "--short", "HEAD"])).stdout.trim(), "main");
  assert.deepEqual(await readdir(empty), [".git"]);
  const web = await create("template", "site", "web");
  assert.match(await readFile(join(web, "index.html"), "utf8"), /<!doctype html>/i);
  const cli = await create("template", "cli", "node");
  assert.match((await exec(process.execPath, [join(cli, "index.js")])).stdout, /你好/);
});

test("拒绝已有目录、非法名称、未知模板和不支持的 URL", async t => {
  const { dir, create } = await setup(t);
  await mkdir(join(dir, "existing"));
  await assert.rejects(create("new", "existing"), /同名/);
  await assert.rejects(create("new", "../elsewhere"), /有效/);
  await assert.rejects(create("template", "target", "unknown"), /模板/);
  await assert.rejects(create("clone", "", "ext::anything"), /地址/);
  assert.deepEqual(await readdir(dir), ["existing"]);
});

test("从 HTTP URL 克隆并推断名称，失败后允许在相同位置重试", async t => {
  const { dir, create } = await setup(t);
  const source = await create("new", "source");
  await writeFile(join(source, "hello"), "克隆测试");
  await exec("git", ["-C", source, "add", "hello"]);
  await exec("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const bare = join(dir, "server.git");
  await exec("git", ["clone", "--bare", source, bare]);
  await exec("git", ["--git-dir", bare, "update-server-info"]);
  let available = false;
  const http = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const file = resolve(bare, "." + path.slice("/demo.git".length));
    try {
      if (!available || !path.startsWith("/demo.git/") || !file.startsWith(bare + sep)) throw Error();
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const url = "http://127.0.0.1:" + http.address().port + "/demo.git";
  await assert.rejects(create("clone", "", url));
  available = true;
  const clone = await create("clone", "", url);
  assert.equal(clone, join(dir, "demo"));
  assert.equal(await readFile(join(clone, "hello"), "utf8"), "克隆测试");
  assert.equal((await exec("git", ["-C", clone, "remote", "get-url", "origin"])).stdout.trim(), url);
});
