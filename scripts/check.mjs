import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
for (const folder of ["mods/jherdr-projects", "scripts", "test"]) {
  for (const file of readdirSync(folder)) {
    if (/\.(js|mjs)$/.test(file)) execFileSync(process.execPath, ["--check", `${folder}/${file}`], { stdio: "inherit" });
    if (file.endsWith(".json")) JSON.parse(readFileSync(`${folder}/${file}`, "utf8"));
  }
}
console.log("JavaScript 语法与 JSON 检查通过。");
