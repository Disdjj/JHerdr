import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCommand, formatCommand, agentCatalog, saveAgentDraft } from "../mods/jherdr-projects/agent-config.js";

test("命令和带空格、引号及空参数的 argv 往返一致", () => {
  const argv = ["/path with space/agy", "--settings", '{"quotes":"a b"}', "it's fine", "", "C:\\Program Files\\some.exe", "$(echo 1)"];
  assert.deepEqual(parseCommand(formatCommand(argv)), argv);
  assert.deepEqual(parseCommand('agy -i "请问我一个问题"'), ["agy", "-i", "请问我一个问题"]);
  assert.throws(() => parseCommand('agy "unfinished'), /引号/);
  assert.throws(() => parseCommand("  "), /填写/);
});

test("保存开关与命令时保留其他配置，取消停用可还原已编辑的命令", () => {
  const before = '{"shells":["nu"],"programs":{"codex":{"tile":"red","run":["codex","--no-daemon"]},"custom":{"name":"Other"}}}';
  const known = [{ key: "codex", run: ["codex"], installed: true }];
  const row = { key: "codex", enabled: false, originalEnabled: true, command: 'codex --no-daemon --model "two words"', originalCommand: "codex --no-daemon" };
  const after = saveAgentDraft(before, [row]);
  const config = JSON.parse(after);
  assert.deepEqual(config.programs.custom, { name: "Other" });
  assert.equal(config.programs.codex.tile, "red");
  assert.deepEqual(config.shells, ["nu"]);
  const [agent] = agentCatalog(known, config);
  assert.equal(agent.enabled, false);
  assert.deepEqual(agent.run, ["codex", "--no-daemon", "--model", "two words"]);
  const again = JSON.parse(saveAgentDraft(after, [{ ...row, enabled: true, originalEnabled: false, originalCommand: row.command }]));
  assert.equal(agentCatalog(known, again)[0].enabled, true);
  assert.deepEqual(again.programs.codex.run, agent.run);
  assert.equal(saveAgentDraft(before, []), before);
  const builtin = { key: "cursor", command: "cursor-agent", originalCommand: "cursor-agent", enabled: false, originalEnabled: true };
  assert.deepEqual(JSON.parse(saveAgentDraft(null, [builtin])).programs.cursor, { run: ["cursor-agent"], jherdrEnabled: false });
});

test("自定义 Agent 校验名称冲突、引号和无效配置", () => {
  const add = { isNew: true, key: "test-agent", command: "example --auto", enabled: true };
  assert.deepEqual(JSON.parse(saveAgentDraft(null, [add])).programs["test-agent"].run, ["example", "--auto"]);
  assert.throws(() => saveAgentDraft(null, [add, add]), /已存在/);
  assert.throws(() => saveAgentDraft(null, [{...add, key: "__proto__"}]), /标识/);
  assert.throws(() => saveAgentDraft('{"programs":[]}', [add]), /无效/);
});

test("CLI 使用自定义参数并拒绝启动已停用 Agent", t => {
  const dir = mkdtempSync(join(tmpdir(), "jherdr-launch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/hc"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  writeFileSync(join(dir, "programs.json"), JSON.stringify({programs:{pi:{jherdrEnabled:false}, my:{run:["example","a b"]}}}));
  const options = { encoding: "utf8", env: { ...process.env, HERDR_APP_HOME: dir, PATH: join(dir, "bin"), INIT_CWD: dir } };
  const script = resolve("scripts/run-agent.mjs");
  const blocked = spawnSync(process.execPath, [script, "pi"], options);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /停用/);
  assert.deepEqual(execFileSync(process.execPath, [script, "my"], options).trimEnd().split("\n").slice(-2), ["example", "a b"]);
});
