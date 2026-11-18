// Herdr passes argv directly to the launcher. Quotes group arguments, never invoke a shell.
export function formatCommand(argv) {
  return argv.map(arg => /^[\w./:@%+=,-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(" ");
}

export function parseCommand(text) {
  const argv = [];
  let word = "", quote = "", started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote && c === quote) { quote = ""; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; started = true; continue; }
    if (!quote && /\s/.test(c)) {
      if (started) argv.push(word);
      word = ""; started = false; continue;
    }
    const next = text[i + 1];
    if (c === "\\" && next && quote !== "'" &&
        (next === "\\" || next === '"' || (!quote && (next === "'" || /\s/.test(next))))) {
      word += next; i++;
    } else word += c;
    started = true;
  }
  if (quote) throw new Error("启动命令的引号未闭合");
  if (started) argv.push(word);
  if (!argv[0]?.trim()) throw new Error("请填写启动命令");
  if (argv.some(arg => arg.includes("\0"))) throw new Error("启动命令含无效字符");
  return argv;
}

export function parseProgramFile(source) {
  const config = source === null ? {} : JSON.parse(source);
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      ("programs" in config && (!config.programs || typeof config.programs !== "object" || Array.isArray(config.programs)))) {
    throw new Error("programs.json 格式无效");
  }
  return config;
}

export function agentCatalog(known, config) {
  return known.map(agent => {
    const entry = config.programs?.[agent.key];
    return { ...agent, run: entry?.run?.length ? entry.run : agent.run, enabled: entry?.jherdrEnabled !== false };
  });
}

// Apply edited fields only, retaining other program metadata and top-level settings.
export function saveAgentDraft(source, drafts) {
  const config = parseProgramFile(source);
  const keys = new Set(drafts.filter(d => !d.isNew).map(d => d.key));
  let dirty = false;
  for (const d of drafts) {
    if (d.isNew) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(d.key) || d.key in Object.prototype) throw new Error("自定义 Agent 标识可使用小写字母、数字、点、下划线和短横线");
      if (keys.has(d.key) || Object.hasOwn(config.programs || {}, d.key)) throw new Error("Agent 标识已存在：" + d.key);
      keys.add(d.key);
    }
    const changeRun = d.isNew || d.command !== d.originalCommand;
    if (!changeRun && d.enabled === d.originalEnabled) continue;
    config.programs ??= {};
    const entry = config.programs[d.key] ??= {};
    if (changeRun || !entry.run?.length) {
      try { entry.run = parseCommand(d.command); }
      catch (e) { throw new Error(d.key + " · " + e.message); }
    }
    if (d.isNew) entry.name = d.key;
    if (!d.enabled) entry.jherdrEnabled = false;
    else delete entry.jherdrEnabled;
    dirty = true;
  }
  return dirty ? JSON.stringify(config, null, 2) + "\n" : source;
}
