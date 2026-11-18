import { mkdir, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const git = promisify(execFile);
const templates = {
  web: { "index.html": '<!doctype html>\n<html lang="zh-CN">\n<meta charset="utf-8">\n<title>我的网站</title>\n<h1>你好，世界！</h1>\n</html>\n' },
  node: { "package.json": JSON.stringify({ private: true, type: "module", scripts: { start: "node index.js" } }, null, 2) + "\n",
    "index.js": 'console.log("你好，世界！");\n' },
};

async function create([mode, parent, name, source]) {
  if (!isAbsolute(parent || "")) throw new Error("请选择保存位置");
  if (!["clone", "new", "template"].includes(mode)) throw new Error("未知的项目操作");
  if (mode === "clone") {
    if (!/^(?:https?:\/\/|ssh:\/\/)[^\s]+$/i.test(source) && !/^[\w.-]+@[\w.-]+:[^\s]+$/.test(source)) {
      throw new Error("请输入 HTTPS 或 SSH 仓库地址");
    }
    if (!name) name = source.replace(/[?#].*$/, "").replace(/\/+$/, "").split(/[/:]/).pop().replace(/\.git$/i, "");
  }
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\x00-\x1f]/.test(name) ||
      /[. ]$/.test(name) || /^(?:\.git|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error("请输入有效的项目文件夹名称");
  }
  if (mode === "template" && !Object.hasOwn(templates, source)) throw new Error("请选择项目模板");
  const target = join(parent, name);
  await mkdir(parent, { recursive: true });
  try { await mkdir(target); }
  catch (e) { if (e.code === "EEXIST") throw new Error("该位置已有同名文件或目录，请更换名称"); throw e; }

  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (mode === "clone") {
      await git("git", ["clone", "--", source, target], {
        env: { ...env, GIT_ALLOW_PROTOCOL: "http:https:ssh" }, timeout: 540000,
      });
    } else {
      await git("git", ["init", "-b", "main", "--", target], { env });
      if (mode === "template") {
        for (const [file, text] of Object.entries(templates[source])) await writeFile(join(target, file), text, { flag: "wx" });
      }
    }
  } catch (e) {
    let detail = (e.stderr || (e.code === "ENOENT" ? "找不到 Git" : e.killed ? "操作超时" : e.message)).trim();
    if (mode === "clone") detail = detail.replaceAll(source, "仓库地址").replace(/(https?:\/\/)[^\s/]+@/gi, "$1");
    try { await rmdir(target); }
    catch (cleanup) { if (cleanup.code !== "ENOENT") detail += "\n已保留部分创建的目录：" + target; }
    throw new Error(detail);
  }
  process.stdout.write(JSON.stringify(target));
}

create(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
