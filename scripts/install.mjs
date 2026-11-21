#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, copyFile, rename, rm, access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { buildLayout, recoveryLayout, LAYOUT, MOD } from "./layout.mjs";
import { restoreLayouts, readBaseLayout } from "./layout-state.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const app = resolve(option("--app-home") || process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app"));
const recordPath = join(app, "data", "jherdr", "install.json");
const exists = path => access(path).then(() => true, () => false);
const json = async path => JSON.parse(await readFile(path, "utf8"));
const atomic = async (path, content) => { await mkdir(dirname(path), { recursive: true }); const tmp = path + `.tmp-${process.pid}`; await writeFile(tmp, content); await rename(tmp, path); };
const command = (...argv) => execFileSync("herdr-app", argv, { encoding: "utf8" });

async function updateZedShortcut(previous, uninstall = false) {
  const path = join(app, "keys.json"), section = "layout:" + LAYOUT, action = MOD + ".open-zed";
  const keys = await exists(path) ? await json(path) : {};
  const binding = keys[section]?.["cmd-o"];
  if (uninstall) {
    if (!previous?.ownsZedShortcut || binding !== action) return false;
    delete keys[section]["cmd-o"];
    if (!Object.keys(keys[section]).length) delete keys[section];
  } else {
    if (binding !== undefined) {
      if (binding !== action) console.log("已保留自定义的 ⌘O 绑定。");
      return binding === action && Boolean(previous?.ownsZedShortcut);
    }
    keys[section] ??= {};
    keys[section]["cmd-o"] = action;
  }
  await atomic(path, JSON.stringify(keys, null, 2) + "\n");
  return !uninstall;
}

async function main() {
  if (args.includes("--only-layout") || args.includes("--delete-other-layouts")) throw new Error("已移除批量清理开关：Herdr 默认布局必须保留，安装只管理 JHerdr 自己的文件。");
  const previous = await exists(recordPath) ? await json(recordPath) : null;
  if (args.includes("--restore-layouts")) {
    if (!args.includes("--dry-run")) console.log(`已恢复布局：${(await restoreLayouts(app)).join(", ") || "无需恢复"}`);
    return;
  }
  if (args.includes("--uninstall")) {
    if (!previous) { console.log("JHerdr 尚未安装。"); return; }
    if (!args.includes("--dry-run")) {
      await restoreLayouts(app);
      let returnLayout = previous.base;
      if (!await exists(join(app, "layouts", `${returnLayout}.json`))) {
        returnLayout = "main";
        if (!await exists(join(app, "layouts", "main.json"))) await atomic(join(app, "layouts", "main.json"), JSON.stringify(recoveryLayout(), null, 2) + "\n");
      }
      if (app === resolve(process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app"))) {
        const current = JSON.parse(command("status"));
        if (current.layout === LAYOUT) command("do", "layout.switch", JSON.stringify({ name: returnLayout }));
      }
      // Only this install's exact paths; no project, terminal or worktree is touched.
      await updateZedShortcut(previous, true);
      for (const relative of previous.files) await rm(join(app, relative), { force: true });
      await rm(recordPath, { force: true });
    }
    console.log("移除 JHerdr 扩展文件；项目数据和所有会话保留。");
    return;
  }
  const source = option("--base") || previous?.base || "main";
  if (!/^[\w-]+$/.test(source) || source === LAYOUT) throw new Error("请选择 main、shepherdr 或另一个独立布局作为基线。");
  let base;
  try { base = await readBaseLayout(app, source); }
  catch (error) {
    if (error.code !== "ENOENT" || !previous || option("--base")) throw error;
    // Once old layouts have been deliberately deleted, JHerdr is its own update baseline.
    base = await json(join(app, "layouts", `${LAYOUT}.json`));
  }
  const layout = buildLayout(base);
  const modules = [MOD, "jherdr-changes"];
  const modFiles = [];
  for (const mod of modules) {
    const files = await readdir(join(root, "mods", mod));
    for (const file of files.filter(f => /\.(js|mjs|json|svg)$/.test(f))) modFiles.push(`mods/${mod}/${file}`);
  }
  const helpers = ["create-project.mjs", "github-avatar.mjs"];
  const files = [...helpers.map(f => "data/jherdr/bin/" + f), ...modFiles, `layouts/${LAYOUT}.json`, "layouts/jherdr-preview.svg"];
  for (const file of files) if (await exists(join(app, file)) && !previous?.files.includes(file)) throw new Error(`目标文件不属于本安装，已停止：${file}`);
  console.log(`基线：${source}；安装：${app}；文件：${files.length}`);
  if (args.includes("--dry-run")) { console.log("预览完成，没有写入文件。"); return; }
  if (!args.includes("--skip-check")) {
    for (const mod of modules) process.stdout.write(command("check", join(root, "mods", mod)));
  }
  // Migrate previous installations away from automatic deletion before any hot reload.
  await restoreLayouts(app);
  if (previous) {
    const backup = join(app, "data", "jherdr", "backups", new Date().toISOString().replace(/[:.]/g, "-"));
    for (const file of previous.files) if (await exists(join(app, file))) {
      await mkdir(dirname(join(backup, file)), { recursive: true });
      await copyFile(join(app, file), join(backup, file));
    }
  }
  // Dependencies first, entry point last, so a hot reload never sees missing imports.
  for (const file of helpers) await atomic(join(app, "data/jherdr/bin", file), await readFile(join(root, "scripts", file)));
  for (const file of [...modFiles.filter(f => !f.endsWith("/main.js")), ...modFiles.filter(f => f.endsWith("/main.js"))]) {
    await atomic(join(app, file), await readFile(join(root, file)));
  }
  for (const file of previous?.files || []) if (!files.includes(file)) await rm(join(app, file), { force: true });
  await atomic(join(app, "layouts", "jherdr-preview.svg"), await readFile(join(root, "design", "layout-preview.svg")));
  await atomic(join(app, "layouts", LAYOUT + ".json"), JSON.stringify(layout, null, 2) + "\n");
  const ownsZedShortcut = await updateZedShortcut(previous);
  await atomic(recordPath, JSON.stringify({ version: 1, source: root, base: source, files, ownsZedShortcut }, null, 2) + "\n");
  if (args.includes("--activate")) {
    if (app !== resolve(process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app"))) throw new Error("不能激活另一个 app-home 的布局；文件已安装。");
    command("do", "layout.switch", JSON.stringify({ name: LAYOUT }));
    console.log("已切换到 JHerdr。Herdr 默认布局保留。");
  } else console.log("安装完成。运行 herdr-app do layout.switch '{\"name\":\"jherdr\"}' 启用。");
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
