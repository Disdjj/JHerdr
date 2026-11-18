import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Direct hc launches take literal argv. Use the same run entries as Herdr's menus.
const defaults = JSON.parse(readFileSync(new URL("../config/programs.json", import.meta.url), "utf8")).programs;
const app = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const path = join(app, "programs.json");
const overrides = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).programs : {};
const [requested, ...args] = process.argv.slice(2);
const key = requested === "agy" ? "antigravity" : requested;
const command = overrides?.[key]?.run ?? defaults[key]?.run;
if (overrides?.[key]?.jherdrEnabled === false) {
  console.error("该 Agent 已在 JHerdr 设置中停用：" + key);
  process.exitCode = 2;
} else if (!Array.isArray(command) || !command.length || !command.every(arg => typeof arg === "string")) {
  console.error("请选择 Agent，例如 npm run agent -- agy");
  process.exitCode = 2;
} else {
  const cwd = process.env.INIT_CWD || process.cwd();
  const result = spawnSync("hc", ["run", "--bg", "--cwd", cwd, "--", ...command, ...args], { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
