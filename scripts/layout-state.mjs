// Compatibility only: disable the retired cleanup policy and restore any surviving archive.
// No startup hook and no automatic removal of other layouts.
import { readFile, writeFile, mkdir, readdir, copyFile, access, rename } from "node:fs/promises";
import { join } from "node:path";
const exists = path => access(path).then(() => true, () => false);
const archivePath = app => join(app, "data", "jherdr", "archived-layouts");

export async function restoreLayouts(app) {
  const data = join(app, "data", "jherdr");
  await mkdir(data, { recursive: true });
  const tmp = join(data, `layout-policy.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify({ only: false, permanently: false }) + "\n");
  await rename(tmp, join(data, "layout-policy.json"));
  const archive = archivePath(app), restored = [];
  if (!await exists(archive)) return restored;
  for (const name of await readdir(archive)) {
    if (!name.endsWith(".json")) continue;
    const target = join(app, "layouts", name);
    if (!await exists(target)) { await copyFile(join(archive, name), target); restored.push(name); }
  }
  return restored;
}

export async function readBaseLayout(app, name) {
  const active = join(app, "layouts", `${name}.json`);
  return JSON.parse(await readFile(await exists(active) ? active : join(archivePath(app), `${name}.json`), "utf8"));
}
