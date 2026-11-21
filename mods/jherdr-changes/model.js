// Capture the terminal and its machine together. During a transition the window
// can already name a new tab while a previously focused pane is disappearing.
export function changesLocation(space, focus, panes) {
  if (!space || !focus || focus.space !== space.id) return null;
  const tab = space.tabs.find(t => t.active);
  if (!tab || tab.id !== focus.tab) return null;
  if (focus.pane === null) {
    if (!focus.terminal || !focus.cwd) return null;
    const [first, second] = focus.terminal.split("/");
    return { cwd: focus.cwd, on: second ? first : null };
  }
  const pane = panes.find(p => p.pane === focus.pane && p.tab === tab.id);
  if (!pane) return null;
  const cwd = focus.shown ? focus.cwd : pane.cwd || focus.cwd;
  return cwd ? { cwd, on: space.machine ?? null } : null;
}

export function changedFiles(status, stats) {
  const byPath = new Map();
  for (const output of stats) {
    for (const entry of output.split("\0")) {
      const [added, removed, ...rest] = entry.split("\t");
      if (!rest.length) continue;
      const path = rest.join("\t"), counts = byPath.get(path) || { add: 0, del: 0 };
      counts.add += Number(added) || 0;
      counts.del += Number(removed) || 0;
      byPath.set(path, counts);
    }
  }
  const entries = status.split("\0").filter(Boolean);
  const files = entries.slice(0, 1000).map(entry => {
    const xy = entry.slice(0, 2), path = entry.slice(3);
    const fresh = xy === "??";
    const kind = xy.includes("U") || xy === "AA" || xy === "DD" ? "U"
      : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
    return { path, kind, fresh, ...(byPath.get(path) || { add: 0, del: 0 }) };
  });
  return { files, limited: entries.length > files.length };
}

export function diffRows(lines) {
  let before = 0, after = 0;
  return lines.slice(0, 1500).map(line => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { before = Number(match[1]); after = Number(match[2]); }
    let number;
    if (line.startsWith("-")) number = before++;
    if (line.startsWith("+")) number = after++;
    if (line.startsWith(" ")) { before++; number = after++; }
    const text = (number === undefined ? line : line.slice(1)).slice(0, 4000).replace(/\t/g, "    ");
    return { number, kind: line[0], text };
  });
}
