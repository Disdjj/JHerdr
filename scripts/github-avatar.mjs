// Installed in data/jherdr/bin. All machines share the viewer's local avatar cache.
import { mkdir, stat, writeFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const formats = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"]]);
async function avatar(owner) {
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner || "")) throw Error("无效的 GitHub 用户名");
  const dir = fileURLToPath(new URL("../avatars/", import.meta.url));
  await mkdir(dir, { recursive: true });
  let cached;
  for (const ext of formats.values()) {
    const file = owner + "." + ext;
    const info = await stat(join(dir, file)).catch(() => null);
    if (info?.size && (!cached || info.mtimeMs > cached.time)) cached = { file, time: info.mtimeMs };
  }
  if (cached && Date.now() - cached.time < 86400000) return cached.file;
  try {
    const res = await fetch("https://avatars.githubusercontent.com/" + owner + "?s=64", { signal: AbortSignal.timeout(6000) });
    const ext = formats.get(res.headers.get("content-type")?.split(";")[0]);
    if (!res.ok || !ext) throw Error("GitHub 头像暂不可用");
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length || data.length > 1024 * 1024) throw Error("无效的头像文件");
    const file = owner + "." + ext, temp = join(dir, file + "." + randomUUID());
    try { await writeFile(temp, data, { flag: "wx" }); await rename(temp, join(dir, file)); }
    finally { await rm(temp, { force: true }); }
    return file;
  } catch (error) {
    if (cached) return cached.file;
    throw error;
  }
}
try { console.log("data/jherdr/avatars/" + await avatar(process.argv[2])); }
catch { process.exitCode = 1; }
