import { changedFiles, diffRows } from "./model.js";

const readOptions = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
function output(result) {
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || "Git command failed").trim());
  return result.stdout;
}

export async function readChanges(exec, location, current) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], location);
  if (!current()) return;
  const root = output(top).replace(/\r?\n$/, "");
  const git = args => exec("git", [...readOptions, ...args], { cwd: root, on: location.on });
  const status = output(await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]));
  if (!current()) return;
  const hasHead = (await git(["rev-parse", "--verify", "HEAD"])).code === 0;
  const stats = [];
  if (status) {
    for (const range of hasHead ? [["HEAD"]] : [["--cached"], []]) {
      if (!current()) return;
      stats.push(output(await git(["diff", ...range, "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--no-renames"])));
    }
  }
  return { root, hasHead, ...changedFiles(status, stats) };
}

async function preview(exec, readText, s, file) {
  if (file.fresh || (!s.hasHead && file.kind === "A")) {
    const text = await readText(s.root + "/" + file.path, { on: s.location.on });
    if (text == null || text.includes("\0")) return { rows: diffRows(["No text preview available"]) };
    const add = text.split("\n").length - Number(!text || text.endsWith("\n"));
    const lines = text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1499);
    return { add, rows: diffRows([`@@ -0,0 +1,${add} @@`, ...(add ? lines.map(line => "+" + line) : [])]) };
  }
  const diff = output(await exec("git", [...readOptions, "diff", ...(s.hasHead ? ["HEAD"] : []),
    "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path], { cwd: s.root, on: s.location.on }));
  const start = diff.search(/^@@ /m);
  return { rows: diffRows(start < 0 ? ["No text diff available"] : diff.slice(start).replace(/\n$/, "").split("\n")) };
}

export class ChangesController {
  constructor(exec, readText) {
    this.exec = exec;
    this.readText = readText;
    this.writes = new Set();
  }

  // Each visit owns its own pending reads, including a return from A to B to A.
  select(location) {
    if (this.state && location?.cwd === this.state.location?.cwd && location?.on === this.state.location?.on) return false;
    this.state = { location, root: null, files: [], rows: [], path: null, collapsed: false, loading: false };
    return true;
  }

  async refresh(s) {
    if (s !== this.state || !s.location || s.loading) return;
    s.loading = true;
    try {
      const snapshot = await readChanges(this.exec, s.location, () => s === this.state);
      if (s !== this.state) return;
      Object.assign(s, snapshot, { error: null });
      if (!s.files.some(f => f.path === s.path)) s.path = s.collapsed ? null : s.files[0]?.path;
      await this.load(s);
    } catch (e) {
      if (s === this.state) Object.assign(s, { error: String(e.message || e), root: null, files: [], rows: [], limited: false });
    } finally { s.loading = false; }
  }

  async load(s) {
    const file = s.files.find(f => f.path === s.path);
    const request = s.previewRequest = {};
    if (!file) { s.rows = []; s.width = 300; return; }
    let result;
    try { result = await preview(this.exec, this.readText, s, file); }
    catch { result = { rows: diffRows(["Cannot preview this file"]) }; }
    if (this.state !== s || s.previewRequest !== request) return;
    if (result.add !== undefined) file.add = result.add;
    s.rows = result.rows;
    s.width = Math.max(300, ...s.rows.map(row => row.text.length * 7 + 72));
  }

  writeKey(s) { return JSON.stringify([s.location?.on, s.root]); }
  canCommit(s, location) {
    return s === this.state && s.root && s.files.length && !s.loading && !this.writes.has(this.writeKey(s))
      && location?.cwd === s.location.cwd && location.on === s.location.on;
  }

  async commit(s, location, message) {
    if (!message.trim() || !this.canCommit(s, location)) return false;
    const target = { cwd: s.root, on: s.location.on }, key = this.writeKey(s);
    this.writes.add(key);
    try {
      output(await this.exec("git", ["add", "-A"], target));
      output(await this.exec("git", ["commit", "-m", message.trim()], target));
      return true;
    } finally { this.writes.delete(key); }
  }
}
