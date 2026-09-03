# Explorer Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FolderPalette replaces the vault's `bruh.css` snippet as the owner of the file explorer's look, then adds collapse arrows, colored tree lines, and one indent for files, folders and BetterNotes at the same depth.

**Architecture:** All layout is static CSS in FolderPalette's `styles.css` (selectors prefixed with `body` to win ties with the Minimal theme); the two new settings only toggle body classes (`fp-arrows-off`, `fp-tree-lines`) that gate CSS blocks. BetterNotes reads two published variables (`--fp-glyph-size`, `--fp-glyph-gap`) so its note icon has the same footprint as FolderPalette's glyphs. Every deploy is verified against a live-DOM snapshot taken over the Chrome DevTools Protocol.

**Tech Stack:** TypeScript + esbuild + vitest (both plugins); Obsidian 1.13.7 desktop; Node 24 (global `fetch`/`WebSocket`) for the CDP scripts; PowerShell 5.1 for process control and robocopy.

**Spec:** `docs/superpowers/specs/2026-08-26-explorer-layout-design.md`

## Global Constraints

- Vault: `C:\Users\rober\Documents\SyncedMain`. Plugin dirs: `.obsidian\plugins\folder-palette`, `.obsidian\plugins\betternotes`. Snippet: `.obsidian\snippets\bruh.css`.
- Writes into `Documents` only work via `robocopy` (Controlled Folder Access). Plugin deploys copy exactly `main.js manifest.json styles.css`; never `/MIR` into a plugin dir (it would delete `data.json`). robocopy exit code 1 = success.
- Bump `manifest.json` (and `package.json`) version on every deploy; the CDP dump reports the loaded version, which is how a reload is verified.
- Obsidian hides in the tray: reload = `Stop-Process -Name Obsidian -Force` then `Start-Process`. Launch with `--remote-debugging-port=9222` and scrub `PSMUX_SESSION`, `PSMUX_TARGET_SESSION`, `TMUX`, `TMUX_PANE` from the environment first.
- Every ported/added explorer selector starts with `body ` (or `body.<class> `).
- Commits: no `Co-Authored-By` trailer.
- Scratchpad for all scripts and dumps: `C:\Users\rober\AppData\Local\Temp\claude\C--Users-rober-Desktop-ObsidianCustomPlugins\8be84531-79ec-41ad-bae8-96c8da0c7e18\scratchpad` (referred to as `$S` below).
- Files containing backslashes or non-ASCII characters are written with the Write tool, not Bash heredocs (this machine's Bash mangles them).

---

## File structure

| File | Responsibility |
|---|---|
| `$S/cdp.js` | Evaluate a JS file inside Obsidian's renderer over CDP, print the JSON result (copied from the ImageGrip session). |
| `$S/cdpshot.js` | Save a PNG screenshot of Obsidian's window over CDP. |
| `$S/cdpclick.js` | Dispatch a real mouse click at viewport coordinates over CDP. |
| `$S/explorerdump.js` | Renderer-side: snapshot every explorer row (rects, computed styles, chevron, glyph, children container) plus global facts. |
| `$S/dumpdiff.js` | Node: diff two dumps by row; exit 1 on any difference. |
| `$S/aligncheck.js` | Node: per-parent alignment and chevron/glyph overlap check on a dump. |
| `$S/toggle.js` | Renderer-side: expand or collapse one folder path (bake the path in before running). |
| `$S/restart-obsidian.ps1` | Kill Obsidian, scrub psmux vars, relaunch with the debug port, wait for it. |
| `FolderPalette/docs/legacy-bruh.css` | Verbatim copy of the snippet, for reference. |
| `FolderPalette/styles.css` | Existing settings chrome + new "Explorer look" (port), "Explorer geometry", "Collapse arrows", "Tree lines" sections. |
| `FolderPalette/src/settings.ts` | `showCollapseArrows`, `treeLines` fields + normalization. |
| `FolderPalette/src/main.ts` | Body-class application, two setters. |
| `FolderPalette/src/settingsTab.ts` | "Explorer" heading with the two toggles. |
| `FolderPalette/tests/settings.test.ts` | Coverage for the two new fields. |
| `BetterNotes/styles.css` | Icon footprint from FolderPalette variables; chevron always on for BetterNotes with children. |
| `$S/appearance.json` | Staged copy of the vault's `appearance.json` with the snippet disabled. |

---

### Task 0: Live-DOM snapshot harness and `before.json`

**Files:**
- Create: `$S/cdp.js`, `$S/cdpshot.js`, `$S/cdpclick.js`, `$S/explorerdump.js`, `$S/dumpdiff.js`, `$S/aligncheck.js`, `$S/toggle.js`, `$S/restart-obsidian.ps1`
- Output: `$S/before.json`, `$S/before.png`

**Interfaces:**
- Produces: `node cdp.js <file.js>` (prints JSON), `node dumpdiff.js a.json b.json` (exit 0 = identical), `node aligncheck.js dump.json` (exit 0 = aligned), `node cdpshot.js out.png`, `node cdpclick.js x y`, `powershell -File restart-obsidian.ps1`.
- Dump shape used by later tasks: `{ versions: {folderPalette, betternotes}, snippetLoaded, fpStyleLoaded, bodyClasses, topSelectorCount, rootChildrenCount, candidates: [{path, bn, plain, file}], rows: [{path, kind, depth, visible, collapsed, self:{rect, padding, ...}, content:{rect}, chevron:{display, rect}|null, icon:{rect}|null, before:{display,width,marginLeft,marginRight}, after:{content,width}, children:{marginLeft,paddingLeft,borderLeft}|null, folderColor}] }`.

- [ ] **Step 1: Copy the CDP harness into this session's scratchpad**

```bash
S="C:/Users/rober/AppData/Local/Temp/claude/C--Users-rober-Desktop-ObsidianCustomPlugins/8be84531-79ec-41ad-bae8-96c8da0c7e18/scratchpad"
cp "C:/Users/rober/AppData/Local/Temp/claude/C--Users-rober-Desktop-ObsidianCustomPlugins/57d8b83f-fb3d-4f3c-a7d9-373276eb3c91/scratchpad/cdp.js" "$S/cdp.js"
```

- [ ] **Step 2: Write `cdpshot.js` and `cdpclick.js`**

`$S/cdpshot.js`:

```js
// Usage: node cdpshot.js out.png  -- screenshot of Obsidian's page over CDP
const fs = require("fs");
(async () => {
  const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(process.argv[2], Buffer.from(r.result.data, "base64"));
  console.log("saved", process.argv[2]);
  ws.close();
})().catch((e) => { console.error(e); process.exit(1); });
```

`$S/cdpclick.js`:

```js
// Usage: node cdpclick.js x y  -- real left click at CSS-pixel viewport coords
(async () => {
  const [x, y] = process.argv.slice(2).map(Number);
  const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  console.log("clicked", x, y);
  ws.close();
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Write `explorerdump.js` (runs inside the renderer)**

```js
// explorerdump.js -- evaluated inside Obsidian via cdp.js. Snapshot of the file explorer.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  if (document.querySelector(".nav-files-container .nav-folder-title") && app.plugins.plugins["folder-palette"]) break;
  await wait(500);
}
await wait(1500); // let BetterNotes' rAF decoration land
const px = (v) => Math.round(v * 100) / 100;
const rectOf = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: px(r.left), top: px(r.top), width: px(r.width), height: px(r.height) }; };
const cs = (el, pseudo) => getComputedStyle(el, pseudo || null);
const container = document.querySelector(".nav-files-container");
const rows = [];
for (const item of container.querySelectorAll(".tree-item")) {
  const self = item.querySelector(":scope > .tree-item-self");
  if (!self) continue;
  const isRoot = item.classList.contains("mod-root");
  const kind = isRoot ? "root" : item.classList.contains("nav-file") ? "file" : item.classList.contains("betternote") ? "betternote" : "folder";
  let depth = 0;
  for (let p = item.parentElement; p && p !== container; p = p.parentElement) if (p.classList.contains("nav-folder-children")) depth++;
  const visible = self.offsetParent !== null;
  const s = cs(self), b = cs(self, "::before"), a = cs(self, "::after");
  const chevron = self.querySelector(":scope > .collapse-icon");
  const icon = self.querySelector(":scope > .betternote-icon");
  const content = self.querySelector(":scope > .tree-item-inner");
  const children = item.querySelector(":scope > .tree-item-children");
  const c = children ? cs(children) : null;
  rows.push({
    path: self.getAttribute("data-path"), kind, depth, visible,
    collapsed: item.classList.contains("is-collapsed"),
    self: {
      rect: visible ? rectOf(self) : null, display: s.display, alignItems: s.alignItems,
      padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(" "),
      marginLeft: s.marginLeft, marginBottom: s.marginBottom, color: s.color, fontWeight: s.fontWeight,
      fontSize: s.fontSize, borderLeft: s.borderLeftWidth + " " + s.borderLeftColor,
      outline: s.outlineWidth + " " + s.outlineColor, background: s.backgroundColor,
    },
    content: content ? { rect: visible ? rectOf(content) : null, paddingLeft: cs(content).paddingLeft, display: cs(content).display } : null,
    chevron: chevron ? { display: cs(chevron).display, visibility: cs(chevron).visibility, rect: visible ? rectOf(chevron) : null, collapsed: chevron.classList.contains("is-collapsed") } : null,
    icon: icon ? { rect: visible ? rectOf(icon) : null, width: cs(icon).width, marginRight: cs(icon).marginRight, display: cs(icon).display } : null,
    before: { display: b.display, width: b.width, marginLeft: b.marginLeft, marginRight: b.marginRight, mask: (b.maskImage || b.webkitMaskImage || "").slice(0, 40) },
    after: { content: a.content, width: a.width, display: a.display, background: a.backgroundColor },
    children: c ? { marginLeft: c.marginLeft, paddingLeft: c.paddingLeft, borderLeft: c.borderLeftWidth + " " + c.borderLeftStyle + " " + c.borderLeftColor, display: c.display } : null,
    folderColor: s.getPropertyValue("--folder-color").trim() || null,
  });
}
const isBn = (f) => f.children.some((k) => k.name === f.name + ".md");
const candidates = [];
const walk = (folder) => {
  const folders = folder.children.filter((k) => k.children);
  const files = folder.children.filter((k) => !k.children && k.extension === "md" && k.name !== folder.name + ".md");
  const bns = folders.filter(isBn);
  const plain = folders.filter((f) => !isBn(f) && f.name !== "Attachments");
  if (bns.length && plain.length && files.length) candidates.push({ path: folder.path, bn: bns[0].path, plain: plain[0].path, file: files[0].path });
  for (const f of folders) walk(f);
};
walk(app.vault.getRoot());
const card = container.querySelector(".nav-files-container > div > .nav-folder");
return {
  versions: {
    folderPalette: app.plugins.plugins["folder-palette"]?.manifest.version ?? null,
    betternotes: app.plugins.plugins["betternotes"]?.manifest.version ?? null,
  },
  snippetLoaded: Array.from(document.head.querySelectorAll("style")).some((st) => st.textContent.includes("HIDE the default collapse arrow")),
  fpStyleLoaded: !!document.getElementById("folder-palette-styles"),
  bodyClasses: Array.from(document.body.classList).filter((c) => c.startsWith("fp-")),
  topSelectorCount: document.querySelectorAll(".nav-files-container > div > .nav-folder").length,
  rootChildrenCount: document.querySelectorAll(".nav-files-container .nav-folder.mod-root > .nav-folder-children > .tree-item").length,
  containerPadding: cs(container).padding,
  cardBorder: card ? cs(card).borderLeftWidth + " " + cs(card).borderLeftColor : null,
  candidates: candidates.slice(0, 10),
  rowCount: rows.length,
  rows,
};
```

- [ ] **Step 4: Write `dumpdiff.js` and `aligncheck.js` (Node)**

`$S/dumpdiff.js`:

```js
// Usage: node dumpdiff.js before.json after.json [ignoreKey,ignoreKey]
const fs = require("fs");
const [a, b] = process.argv.slice(2, 4).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
const ignore = new Set(["self.rect.top", "content.rect.top", "chevron.rect.top", "icon.rect.top", ...(process.argv[4] || "").split(",").filter(Boolean)]);
const flat = (obj, prefix = "", out = {}) => {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + "." + k : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flat(v, key, out); else out[key] = JSON.stringify(v);
  }
  return out;
};
const byPath = (d) => Object.fromEntries(d.rows.map((r) => [r.kind + ":" + r.path, r]));
const A = byPath(a), B = byPath(b);
const diffs = [];
for (const key of new Set([...Object.keys(A), ...Object.keys(B)])) {
  if (!A[key] || !B[key]) { diffs.push(`${key}: ${A[key] ? "removed" : "added"}`); continue; }
  const fa = flat(A[key]), fb = flat(B[key]);
  for (const f of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
    if (ignore.has(f)) continue;
    if (fa[f] !== fb[f]) diffs.push(`${key} ${f}: ${fa[f]} -> ${fb[f]}`);
  }
}
for (const k of ["snippetLoaded", "fpStyleLoaded", "bodyClasses", "topSelectorCount", "rootChildrenCount", "containerPadding", "cardBorder", "versions"]) {
  if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.log(`global ${k}: ${JSON.stringify(a[k])} -> ${JSON.stringify(b[k])}`);
}
console.log(`rows: ${a.rowCount} -> ${b.rowCount}; row diffs: ${diffs.length}`);
for (const d of diffs.slice(0, 100)) console.log("  " + d);
process.exit(diffs.length ? 1 : 0);
```

`$S/aligncheck.js`:

```js
// Usage: node aligncheck.js dump.json [--skip-kind betternote]
const d = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const skip = process.argv[3] === "--skip-kind" ? process.argv[4] : null;
const groups = new Map();
for (const r of d.rows) {
  if (!r.visible || r.kind === "root" || r.kind === skip || !r.content?.rect) continue;
  const parent = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "/";
  if (!groups.has(parent)) groups.set(parent, []);
  groups.get(parent).push(r);
}
let fails = 0;
for (const [parent, rows] of groups) {
  const distinct = [...new Set(rows.map((r) => r.content.rect.left))];
  const kinds = [...new Set(rows.map((r) => r.kind))];
  const ok = distinct.length === 1;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"} ${parent} kinds=${kinds.join(",")} lefts=${distinct.join(",")}`);
  if (!ok) for (const r of rows) console.log(`     ${r.kind.padEnd(10)} ${r.content.rect.left}  ${r.path}`);
  for (const r of rows) {
    if (!r.chevron || r.chevron.display === "none" || !r.chevron.rect) continue;
    const padLeft = parseFloat(r.self.padding.split(" ")[3]);
    const glyphLeft = r.icon?.rect ? r.icon.rect.left : r.self.rect.left + padLeft + parseFloat(r.before.marginLeft);
    const chevronRight = r.chevron.rect.left + r.chevron.rect.width;
    if (chevronRight > glyphLeft + 0.5) { fails++; console.log(`  FAIL chevron overlaps glyph: ${r.path} chevronRight=${chevronRight} glyphLeft=${glyphLeft}`); }
  }
}
console.log(fails ? `${fails} failure(s)` : "all groups aligned");
process.exit(fails ? 1 : 0);
```

- [ ] **Step 5: Write `toggle.js` and `restart-obsidian.ps1`**

`$S/toggle.js` (replace the `PATHS` array before each run; runs inside the renderer):

```js
// toggle.js -- expand (COLLAPSE=false) or collapse (COLLAPSE=true) each folder path in PATHS, in order.
const PATHS = ["REPLACE/ME"];
const COLLAPSE = false;
const view = app.workspace.getLeavesOfType("file-explorer")[0].view;
const out = [];
for (const p of PATHS) {
  const item = view.fileItems[p];
  if (!item) { out.push({ p, error: "no fileItem" }); continue; }
  const was = item.el.classList.contains("is-collapsed");
  if (was !== COLLAPSE) {
    if (typeof item.setCollapsed === "function") await item.setCollapsed(COLLAPSE, false);
    else item.selfEl.click();
  }
  await new Promise((r) => setTimeout(r, 300));
  out.push({ p, wasCollapsed: was, nowCollapsed: item.el.classList.contains("is-collapsed") });
}
return out;
```

`$S/restart-obsidian.ps1`:

```powershell
Stop-Process -Name Obsidian -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
foreach ($n in "PSMUX_SESSION", "PSMUX_TARGET_SESSION", "TMUX", "TMUX_PANE") { Remove-Item "Env:\$n" -ErrorAction SilentlyContinue }
Start-Process "$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe" -ArgumentList "--remote-debugging-port=9222"
$deadline = (Get-Date).AddSeconds(90)
$ok = $false
do {
  Start-Sleep -Seconds 2
  try { $null = Invoke-RestMethod "http://127.0.0.1:9222/json" -TimeoutSec 2; $ok = $true } catch { $ok = $false }
} until ($ok -or (Get-Date) -gt $deadline)
if ($ok) { "obsidian up with debug port" } else { "TIMEOUT waiting for debug port"; exit 1 }
```

- [ ] **Step 6: Restart Obsidian with the debug port and take `before.json` + `before.png`**

```powershell
powershell -ExecutionPolicy Bypass -File "$S\restart-obsidian.ps1"
```

```bash
cd "$S" && node cdp.js explorerdump.js > before.json && node -e 'const d=require("./before.json");console.log(JSON.stringify({versions:d.versions,snippetLoaded:d.snippetLoaded,fpStyleLoaded:d.fpStyleLoaded,topSelectorCount:d.topSelectorCount,rootChildrenCount:d.rootChildrenCount,containerPadding:d.containerPadding,cardBorder:d.cardBorder,rowCount:d.rowCount,candidates:d.candidates},null,1))' && node cdpshot.js before.png
```

Expected: `versions.folderPalette` = `0.1.0`, `betternotes` = `1.2.0`, `snippetLoaded: true`, `fpStyleLoaded: true`. Record `topSelectorCount` and `rootChildrenCount`:
- `topSelectorCount > 0` and `rootChildrenCount == 0`: DOM is `.mod-root > .nav-folder` as the shared selector assumes. No selector change needed.
- `topSelectorCount == 0`: the shared top-level selector never matched (colors and cards never applied). Then Task 1 Step 4 (selector fix) is mandatory.
- `rootChildrenCount > 0`: top-level items live under `.mod-root > .nav-folder-children`; Task 4 Step 5 root-exclusion rules are mandatory.

Read `before.png` and describe the sidebar in one sentence (the reference look).

- [ ] **Step 7: Print the pre-change geometry for one candidate group**

```bash
cd "$S" && node -e 'const d=require("./before.json");const c=d.candidates[0];if(!c){console.log("no candidate parent with bn+plain+file");process.exit(0)};const want=new Set([c.bn,c.plain,c.file]);for(const r of d.rows){if(want.has(r.path))console.log(r.kind.padEnd(10),"visible="+r.visible,"pad="+r.self.padding,"before.ml="+r.before.marginLeft,"content.left="+(r.content.rect?r.content.rect.left:"-"),r.path)}'
```

If the three rows are not `visible`, bake `PATHS` in `toggle.js` to the ancestor chain of `candidates[0].path` (e.g. `["University", "University/Current Courses"]`), run `node cdp.js toggle.js`, re-run the dump into `before-expanded.json`, and print the same three rows from it. Note the original collapsed state; restore it with `COLLAPSE = true` at the end of Task 4.

---

### Task 1: Faithful port of `bruh.css` into FolderPalette, snippet disabled

**Files:**
- Create: `FolderPalette/docs/legacy-bruh.css`
- Modify: `FolderPalette/styles.css` (append), `FolderPalette/manifest.json`, `FolderPalette/package.json`
- Possibly modify (Step 4, only if `topSelectorCount == 0`): `FolderPalette/src/css.ts:23-25`, `FolderPalette/tests/css.test.ts:4-5`
- Create: `$S/appearance.json`; deploy it to `SyncedMain/.obsidian/appearance.json`

**Interfaces:**
- Produces: variables `--fp-icon-file`, `--fp-icon-folder`, `--fp-icon-folder-open`, `--fp-outline-color`, `--fp-selected-outline-color` on `body`; the "Explorer look" CSS section that Task 2 edits in place.

- [ ] **Step 1: Copy the snippet into the repo for reference**

```bash
cp "C:/Users/rober/Documents/SyncedMain/.obsidian/snippets/bruh.css" "C:/Users/rober/Desktop/ObsidianCustomPlugins/FolderPalette/docs/legacy-bruh.css"
```

- [ ] **Step 2: Append the "Explorer look" section to `FolderPalette/styles.css`**

Append exactly this (the three data URIs are verbatim from `docs/legacy-bruh.css:17-19`; use the Write/Edit tool, not a heredoc):

```css

/* =====================================================================
   Explorer look — ported from the vault's bruh.css snippet (2026-08-26).
   Every selector is body-prefixed so it beats the theme's equal-specificity
   rules whatever the stylesheet load order. Per-folder colors are NOT here:
   they are injected at runtime into #folder-palette-styles.
   ===================================================================== */

body {
  --fp-icon-file: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-text"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><line x1="10" y1="9" x2="8" y2="9"></line></svg>');
  --fp-icon-folder: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path></svg>');
  --fp-icon-folder-open: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-folder-open"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v1"></path></svg>');
  --fp-outline-color: #383838;
  --fp-selected-outline-color: #8D8D8D;
}

/* top-level folder cards */
body .nav-files-container > div > .nav-folder {
  border: none;
  border-left: 5px solid var(--folder-color);
  border-radius: var(--radius-s);
  outline: 1px solid var(--fp-outline-color);
  background-color: var(--background-primary);
}

body .nav-files-container > div > .nav-folder.is-active,
body .nav-files-container > div > .nav-folder.is-active:focus-within {
  outline: 1px solid var(--fp-selected-outline-color);
  box-shadow: 0 0 0 1px var(--fp-selected-outline-color);
}

body .nav-files-container > div > .nav-folder + .nav-folder {
  margin-top: 0px;
}

/* rows */
body .nav-folder-title {
  color: var(--folder-color);
  font-weight: var(--font-bold);
  display: flex;
  align-items: center;
}

body .nav-file-title {
  border: none;
  border-radius: var(--radius-s);
  outline: none;
  padding: var(--size-2-2) var(--size-4-2);
  margin-bottom: 2px;
  background-color: transparent;
  display: flex;
  align-items: center;
  color: var(--text-normal);
}

/* folder / file glyphs (masked SVG, colored by currentColor) */
body .nav-folder-title::before,
body .nav-file-title::before {
  content: '';
  display: inline-block;
  width: 1em;
  height: 1em;
  flex-shrink: 0;
  margin-right: 6px;
  margin-left: -1em;
  background-color: currentColor;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  mask-size: contain;
  vertical-align: text-bottom;
}

body .nav-folder.is-collapsed > .nav-folder-title::before {
  -webkit-mask-image: var(--fp-icon-folder);
  mask-image: var(--fp-icon-folder);
}

body .nav-folder:not(.is-collapsed) > .nav-folder-title::before {
  -webkit-mask-image: var(--fp-icon-folder-open);
  mask-image: var(--fp-icon-folder-open);
}

body .nav-file-title::before {
  -webkit-mask-image: var(--fp-icon-file);
  mask-image: var(--fp-icon-file);
}

body .nav-folder .nav-file-title::before {
  color: var(--folder-color);
}

/* container + vault-root title */
body .workspace-leaf-content[data-type="file-explorer"] .nav-files-container {
  padding: var(--size-4-2);
  background-color: var(--background-primary);
  border-radius: var(--radius-m);
}

body .nav-files-container > div > .nav-folder-title:not(.nav-file-title),
body .nav-files-container > div > .nav-folder:first-child .nav-folder-title:not(.nav-file-title) {
  color: var(--text-normal);
  font-weight: var(--font-bold);
  margin-top: var(--size-4-4);
  margin-bottom: var(--size-4-2);
  padding: 0;
  border: none;
  outline: none;
  background-color: transparent;
  display: block;
}

body .nav-folder-children {
  padding-left: var(--size-4-4);
}

body .nav-file,
body .nav-folder {
  background-color: transparent;
}

body .nav-file-title.is-active,
body .nav-folder-title.is-active {
  background-color: var(--background-modifier-hover);
  border-radius: var(--radius-s);
}

body .nav-file-title-content,
body .nav-folder-title-content {
  display: flex;
  align-items: center;
}
```

Deliberately not ported (see spec section 1): `--folder-color-1..10`, the twelve per-folder lines, `.tree-item-self { margin-left: 0 }`, `.tree-item-inner { padding-left: 0 }`, `.nav-folder-title.nav-file-title::before`, `--ltr-icons`.

**Amendments found in execution (2026-08-26):**
- `transform: scale(1); transform-origin: left;` on the card MUST be ported. It is not a layout no-op: Obsidian's virtual tree computes each nested row's inline `margin-inline-start` / `padding-inline-start` from offsets measured through the `offsetParent` chain, and the transform makes the card the offsetParent so its 5px border is excluded. Without it every nested row's box widened by 4px (text unchanged). Keep it, with the comment in `styles.css`.
- `.tree-item .collapse-icon { display: none }` IS ported verbatim (body-prefixed) in this task so the identical-diff gate is honest; Task 4 Step 7 replaces that rule with the `body.fp-arrows-off` gated one instead of adding a new rule.
- The live DOM has no `.nav-folder.mod-root`: `.nav-files-container > div` is an unclassed wrapper whose direct children are the top-level items (`topSelectorCount: 5`, `rootChildrenCount: 0`), so the shared selector is right and no root-exclusion rules are needed.

- [ ] **Step 3: Bump the version to 0.2.0**

In `FolderPalette/manifest.json` change `"version": "0.1.0"` to `"version": "0.2.0"`; same in `FolderPalette/package.json`.

- [ ] **Step 4 (only if `before.json.topSelectorCount == 0`): fix the shared top-level selector**

In `FolderPalette/src/css.ts` replace the body of `folderSelector` with:

```ts
  return `body .nav-files-container .nav-folder.mod-root > .nav-folder-children > .nav-folder:has(> .nav-folder-title[data-path="${escapeAttr(path)}"])`;
```

In `FolderPalette/tests/css.test.ts` change the `SEL` helper to the same shape:

```ts
const SEL = (p: string) =>
  `body .nav-files-container .nav-folder.mod-root > .nav-folder-children > .nav-folder:has(> .nav-folder-title[data-path="${p}"])`;
```

And in the CSS appended in Step 2 replace every `body .nav-files-container > div > .nav-folder` with `body .nav-files-container .nav-folder.mod-root > .nav-folder-children > .nav-folder`, and `body .nav-files-container > div > .nav-folder-title:not(.nav-file-title)` with `body .nav-files-container .nav-folder.mod-root > .nav-folder-title`. Skip this step entirely if `topSelectorCount > 0`.

- [ ] **Step 5: Tests + build**

```bash
cd "C:/Users/rober/Desktop/ObsidianCustomPlugins/FolderPalette" && npm test 2>&1 | tail -8 && npm run build 2>&1 | tail -3
```

Expected: all vitest files pass (38 tests, or 38 with the updated SEL if Step 4 ran); esbuild writes `main.js`.

- [ ] **Step 6: Commit the port**

```bash
cd "C:/Users/rober/Desktop/ObsidianCustomPlugins/FolderPalette" && git add styles.css docs/legacy-bruh.css manifest.json package.json src/css.ts tests/css.test.ts && git commit -m "feat: absorb the bruh.css explorer look into styles.css, v0.2.0"
```

- [ ] **Step 7: Stage `appearance.json` with the snippet disabled**

Write `$S/appearance.json` (hand-written JSON; never round-trip through `ConvertTo-Json`):

```json
{
  "accentColor": "#ff6c52",
  "theme": "obsidian",
  "cssTheme": "Minimal",
  "enabledCssSnippets": [],
  "interfaceFontFamily": "Bahnschrift",
  "textFontFamily": "Bahnschrift",
  "nativeMenus": true,
  "showRibbon": true,
  "showViewHeader": true,
  "translucency": false
}
```

Before deploying, re-read the live file and confirm nothing but `enabledCssSnippets` differs:

```bash
diff <(node -e 'const a=require("C:/Users/rober/Documents/SyncedMain/.obsidian/appearance.json");delete a.enabledCssSnippets;console.log(JSON.stringify(a,null,1))') <(node -e 'const a=require(process.argv[1]);delete a.enabledCssSnippets;console.log(JSON.stringify(a,null,1))' "$S/appearance.json") && echo SAME
```

- [ ] **Step 8: Stop Obsidian, deploy plugin + appearance.json, relaunch, dump**

```powershell
Stop-Process -Name Obsidian -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3
robocopy "C:\Users\rober\Desktop\ObsidianCustomPlugins\FolderPalette" "C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\folder-palette" main.js manifest.json styles.css /NJH /NJS
robocopy "$S" "C:\Users\rober\Documents\SyncedMain\.obsidian" appearance.json /NJH /NJS
powershell -ExecutionPolicy Bypass -File "$S\restart-obsidian.ps1"
```

Expected: both robocopy exit codes 1; "obsidian up with debug port".

```bash
cd "$S" && node cdp.js explorerdump.js > after-port.json && node dumpdiff.js before.json after-port.json; node cdpshot.js after-port.png
```

Expected: `global snippetLoaded: true -> false`, `global versions: ... 0.1.0 -> 0.2.0`, and **`row diffs: 0`**. If rows differ, stop and diagnose (compare the differing property against `docs/legacy-bruh.css`; the usual suspects are the two dropped `.tree-item-*` resets — add them back body-prefixed if the diff names `self.marginLeft` or `content.paddingLeft`). Do not proceed to Task 2 with a non-empty diff. Read `after-port.png` and confirm it matches the `before.png` description.

---

### Task 2: Unified row geometry

**Files:**
- Modify: `FolderPalette/styles.css` (the "Explorer look" section from Task 1), `FolderPalette/manifest.json`, `FolderPalette/package.json`

**Interfaces:**
- Produces: variables `--fp-row-indent`, `--fp-glyph-size`, `--fp-glyph-gap`, `--fp-children-margin`, `--fp-children-indent` on `body`. Task 3 (BetterNotes) reads `--fp-glyph-size` and `--fp-glyph-gap`; Task 4 reads `--fp-children-indent`.

- [ ] **Step 1: Add the geometry variables to the `body {}` block**

In the `body { --fp-icon-file: ... }` block appended in Task 1, add after `--fp-selected-outline-color: #8D8D8D;`:

```css
  /* row geometry — one indent for files, folders and BetterNotes at a depth */
  --fp-row-indent: 20px;      /* row padding-left; core puts the chevron at -20px, so it spans 0..16px */
  --fp-glyph-size: 1em;       /* read by BetterNotes for its note icon */
  --fp-glyph-gap: 6px;        /* read by BetterNotes for its note icon */
  --fp-children-margin: 7px;  /* children container margin: a 2px line at 7..9px centers on the chevron (8px) */
  --fp-children-indent: 12px; /* children container padding */
```

- [ ] **Step 2: Replace the row padding, glyph offset and children indent rules**

In the same section:

(a) Leave the ported `body .nav-file-title { ... }` rule as is and add, right after it, one scoped rule that wins for both row kinds (core gives folder rows `6px 8px 6px 24px`, the port gives file rows `8px 8px`):

```css
/* one box for every explorer row: files, folders, BetterNotes */
body .nav-files-container .nav-file-title,
body .nav-files-container .nav-folder-title {
  padding: var(--size-2-2) var(--size-4-2) var(--size-2-2) var(--fp-row-indent);
}
```

(b) In the glyph rule `body .nav-folder-title::before, body .nav-file-title::before { ... }` change `width: 1em; height: 1em;` to `width: var(--fp-glyph-size); height: var(--fp-glyph-size);`, `margin-right: 6px;` to `margin-right: var(--fp-glyph-gap);`, and `margin-left: -1em;` to `margin-left: 0;`.

(c) Replace

```css
body .nav-folder-children {
  padding-left: var(--size-4-4);
}
```

with

```css
body .nav-files-container .nav-folder-children {
  margin-inline-start: var(--fp-children-margin);
  padding-inline-start: var(--fp-children-indent);
}
```

The vault-root title rule (`... > .nav-folder-title:not(.nav-file-title) { padding: 0; ... }`) has higher specificity than the new folder-row padding rule and stays as is.

- [ ] **Step 3: Bump to 0.2.1, build, deploy, dump**

Set `"version": "0.2.1"` in `manifest.json` and `package.json`.

```bash
cd "C:/Users/rober/Desktop/ObsidianCustomPlugins/FolderPalette" && npm test 2>&1 | tail -4 && npm run build 2>&1 | tail -2
```

```powershell
Stop-Process -Name Obsidian -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3
robocopy "C:\Users\rober\Desktop\ObsidianCustomPlugins\FolderPalette" "C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\folder-palette" main.js manifest.json styles.css /NJH /NJS
powershell -ExecutionPolicy Bypass -File "$S\restart-obsidian.ps1"
```

```bash
cd "$S" && node cdp.js explorerdump.js > after-geometry.json && node aligncheck.js after-geometry.json --skip-kind betternote; node cdpshot.js after-geometry.png
```

If the candidate trio is inside collapsed folders, expand the ancestor chain with `toggle.js` first (same as Task 0 Step 7) and dump again.

Expected: `versions.folderPalette` = `0.2.1`; every visible group prints `PASS` with one `lefts` value (files and folders equal); no "chevron overlaps glyph" lines. BetterNote rows are skipped here; they align in Task 3. Read `after-geometry.png`: glyphs sit right of an empty gutter, text is flush across kinds.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/rober/Desktop/ObsidianCustomPlugins/FolderPalette" && git add styles.css manifest.json package.json && git commit -m "feat: one row geometry for files and folders, glyph out of the chevron gutter, v0.2.1"
```

---

### Task 3: BetterNotes icon footprint + always-on chevron

**Files:**
- Modify: `BetterNotes/styles.css:26-43`, `BetterNotes/manifest.json`, `BetterNotes/package.json`, `BetterNotes/README.md:44`

**Interfaces:**
- Consumes: `--fp-glyph-size`, `--fp-glyph-gap` from Task 2 (with fallbacks, so BetterNotes still works without FolderPalette).

- [ ] **Step 1: Replace the icon rules and add the chevron rule**

Replace `BetterNotes/styles.css` lines 26-43 (from the `/* inherit the surrounding folder's accent ... */` comment through the `.betternote.betternote-no-children ... visibility: hidden; }` rule) with:

```css
/* the note icon takes the same box as FolderPalette's folder/file glyphs so a
   BetterNote's title lines up with sibling folders and files; the fallbacks
   keep it sane when FolderPalette is not installed. Inherits the surrounding
   folder's accent when --folder-color is defined. */
.betternote-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  width: var(--fp-glyph-size, 16px);
  height: var(--fp-glyph-size, 16px);
  margin-right: var(--fp-glyph-gap, var(--size-2-2));
  color: var(--folder-color, var(--text-muted));
}

.betternote-icon svg {
  width: 100%;
  height: 100%;
}

/* a BetterNote with children always shows its chevron, even if the explorer
   styling plugin hides chevrons elsewhere (FolderPalette's "arrows off") */
body .betternote:not(.betternote-no-children) > .nav-folder-title > .nav-folder-collapse-indicator {
  display: flex;
}

/* no chevron when there is nothing underneath (besides the note itself) */
.betternote.betternote-no-children > .nav-folder-title .nav-folder-collapse-indicator {
  visibility: hidden;
}
```

- [ ] **Step 2: Bump to 1.3.0 and update the README sentence**

`BetterNotes/manifest.json` and `package.json`: `"version": "1.3.0"`.

In `BetterNotes/README.md` line 44, replace the sentence `The chevron only toggles the children underneath, and if there are no children the chevron disappears entirely, so an empty BetterNote is indistinguishable from a plain note.` with:

`The chevron toggles the children underneath (down when open, right when closed) and never opens the note; it stays visible even if your explorer theme hides chevrons on plain folders, and if there are no children it disappears entirely, so an empty BetterNote is indistinguishable from a plain note. The note icon sizes itself from FolderPalette's --fp-glyph-size / --fp-glyph-gap variables when that plugin is present, so a BetterNote's title lines up exactly with sibling folders and files.`

- [ ] **Step 3: Build, sync the test vault copy, deploy, dump**

```bash
cd "C:/Users/rober/Desktop/ObsidianCustomPlugins/BetterNotes" && npm test 2>&1 | tail -4 && npm run build 2>&1 | tail -2 && npm run deploy:test
```

```powershell
Stop-Process -Name Obsidian -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3
robocopy "C:\Users\rober\Desktop\ObsidianCustomPlugins\BetterNotes" "C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\betternotes" main.js manifest.json styles.css /NJH /NJS
powershell -ExecutionPolicy Bypass -File "$S\restart-obsidian.ps1"
```

```bash
cd "$S" && node cdp.js explorerdump.js > after-bn.json && node aligncheck.js after-bn.json; node cdpshot.js after-bn.png
```

Expected: `versions.betternotes` = `1.3.0`; every group `PASS` including groups whose `kinds` list contains `betternote`; BetterNote rows with children show `chevron.display: "flex"`. Read `after-bn.png`.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/rober/Desktop/ObsidianCustomPlugins/BetterNotes" && git add styles.css manifest.json package.json README.md test-vault/.obsidian/plugins/betternotes && git commit -m "feat: note icon sized from FolderPalette glyph variables, chevron always on with children, v1.3.0"
```

---

**Amendment found in execution (Task 3, shipped as BetterNotes 1.3.1):** Obsidian 1.13.7 no longer puts `nav-folder-collapse-indicator` on the chevron (the element is `tree-item-icon collapse-icon`; zero mentions in app.js), so every BetterNotes chevron rule had been dead since that Obsidian update, masked by the snippet hiding all chevrons. All three rules now target `.collapse-icon`. Verified live: childless BetterNotes report `visibility: hidden`, those with children `display: flex`.

### Task 4: Collapse-arrows and tree-lines settings

**Files:**
- Modify: `FolderPalette/src/settings.ts`, `FolderPalette/tests/settings.test.ts`, `FolderPalette/src/main.ts`, `FolderPalette/src/settingsTab.ts:48-57`, `FolderPalette/styles.css`, `FolderPalette/manifest.json`, `FolderPalette/package.json`

**Interfaces:**
- Produces: `FolderPaletteSettings.showCollapseArrows: boolean`, `FolderPaletteSettings.treeLines: boolean` (both default `true`); `FolderPalettePlugin.setShowCollapseArrows(on: boolean): Promise<void>`, `FolderPalettePlugin.setTreeLines(on: boolean): Promise<void>`; body classes `fp-arrows-off` (present when arrows are off) and `fp-tree-lines` (present when tree lines are on).

- [ ] **Step 1: Write the failing settings tests**

In `FolderPalette/tests/settings.test.ts`, change the "keeps valid fields" case to include the new fields and add two cases:

```ts
  it("keeps valid fields", () => {
    expect(
      normalizeSettings({
        paletteId: "nord",
        colorFiles: false,
        showCollapseArrows: false,
        treeLines: false,
        folderColors: { Archive: "#E5877E", "Cyber Security": "#eaa87b" },
      })
    ).toEqual({
      paletteId: "nord",
      colorFiles: false,
      showCollapseArrows: false,
      treeLines: false,
      folderColors: { Archive: "#E5877E", "Cyber Security": "#eaa87b" },
    });
  });
  it("defaults the explorer toggles on when missing (pre-0.2 data.json)", () => {
    const out = normalizeSettings({ paletteId: "nord", colorFiles: true, folderColors: {} });
    expect(out.showCollapseArrows).toBe(true);
    expect(out.treeLines).toBe(true);
  });
  it("ignores non-boolean explorer toggles", () => {
    const out = normalizeSettings({ showCollapseArrows: "no", treeLines: 0 });
    expect(out.showCollapseArrows).toBe(true);
    expect(out.treeLines).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to see them fail**

```bash
cd "C:/Users/rober/Desktop/ObsidianCustomPlugins/FolderPalette" && npx vitest run tests/settings.test.ts 2>&1 | tail -15
```

Expected: "keeps valid fields" fails (missing `showCollapseArrows`/`treeLines` in the result); the two new cases fail with `undefined` instead of `true`.

- [ ] **Step 3: Implement the settings fields**

`FolderPalette/src/settings.ts` becomes:

```ts
import type { ColorMap } from "./assign";
import { isHex } from "./hex";

export interface FolderPaletteSettings {
  /** Palette selected in the settings UI (used for swatches + "apply to all"). */
  paletteId: string;
  /** Top-level folder path → "#rrggbb". */
  folderColors: ColorMap;
  /** Also color note titles inside each colored folder. */
  colorFiles: boolean;
  /** Show the native collapse chevron on folder rows in the file explorer. */
  showCollapseArrows: boolean;
  /** Draw a colored line from each folder down through its children, with an elbow into each child. */
  treeLines: boolean;
}

export const DEFAULT_SETTINGS: FolderPaletteSettings = {
  paletteId: "muted-rainbow",
  folderColors: {},
  colorFiles: true,
  showCollapseArrows: true,
  treeLines: true,
};

/** Coerce whatever loadData() returned into a valid settings object. */
export function normalizeSettings(raw: unknown): FolderPaletteSettings {
  const out: FolderPaletteSettings = { ...DEFAULT_SETTINGS, folderColors: {} };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;

  if (typeof r.paletteId === "string" && r.paletteId.length > 0) out.paletteId = r.paletteId;
  if (typeof r.colorFiles === "boolean") out.colorFiles = r.colorFiles;
  if (typeof r.showCollapseArrows === "boolean") out.showCollapseArrows = r.showCollapseArrows;
  if (typeof r.treeLines === "boolean") out.treeLines = r.treeLines;

  const fc = r.folderColors;
  if (fc && typeof fc === "object" && !Array.isArray(fc)) {
    for (const [path, color] of Object.entries(fc as Record<string, unknown>)) {
      if (path.length > 0 && isHex(color)) out.folderColors[path] = color;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to see them pass**

```bash
cd "C:/Users/rober/Desktop/ObsidianCustomPlugins/FolderPalette" && npm test 2>&1 | tail -6
```

Expected: all pass (40 tests).

- [ ] **Step 5: Body classes and setters in `main.ts`**

In `FolderPalette/src/main.ts`:

(a) In `onload`, after `this.applyStyles();` (line 23) add `this.applyBodyClasses();`.

(b) In `onunload` add, before `this.styleEl?.remove();`:

```ts
    document.body.removeClass("fp-arrows-off", "fp-tree-lines");
```

(c) After `setColorFiles` add:

```ts
  async setShowCollapseArrows(on: boolean): Promise<void> {
    this.settings.showCollapseArrows = on;
    await this.persist();
  }

  async setTreeLines(on: boolean): Promise<void> {
    this.settings.treeLines = on;
    await this.persist();
  }
```

(d) In `persist`, after `this.applyStyles();` add `this.applyBodyClasses();`.

(e) After `applyStyles()` add:

```ts
  /** The two explorer toggles are plain body classes; styles.css does the rest. */
  private applyBodyClasses(): void {
    document.body.toggleClass("fp-arrows-off", !this.settings.showCollapseArrows);
    document.body.toggleClass("fp-tree-lines", this.settings.treeLines);
  }
```

- [ ] **Step 6: Toggles in the settings tab**

In `FolderPalette/src/settingsTab.ts`, directly after the "Color files inside folders" `Setting` (ends line 55) and before `new Setting(containerEl).setName("Folders").setHeading();`, insert:

```ts
    new Setting(containerEl).setName("Explorer").setHeading();

    new Setting(containerEl)
      .setName("Show collapse arrows")
      .setDesc("The chevron on folder rows: down when open, right when closed. Click it to fold the folder's children.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showCollapseArrows)
          .onChange((on) => void this.plugin.setShowCollapseArrows(on))
      );

    new Setting(containerEl)
      .setName("Tree lines")
      .setDesc("A line in the folder's color running from each folder down through its children, with an elbow into every child.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.treeLines)
          .onChange((on) => void this.plugin.setTreeLines(on))
      );
```

- [ ] **Step 7: The two CSS blocks**

Append to `FolderPalette/styles.css`:

```css

/* ==== Explorer: collapse arrows (setting "Show collapse arrows") ==== */
body.fp-arrows-off .nav-files-container .collapse-icon {
  display: none;
}

/* ==== Explorer: tree lines (setting "Tree lines") ====
   --folder-color is set on the top-level folder by the injected stylesheet
   and inherits down the subtree, so var() must be resolved on the line's own
   element (not cached in an intermediate variable on the container). */
body.fp-tree-lines .nav-files-container .nav-folder-children {
  border-inline-start: 2px solid var(--folder-color, var(--nav-indentation-guide-color));
}

/* elbow from the vertical line into each child row */
body.fp-tree-lines .nav-files-container .nav-folder-children > .tree-item > .tree-item-self::after {
  content: "";
  position: absolute;               /* .tree-item-self is position: relative in core */
  left: calc(-1 * (var(--fp-children-indent) + 2px));   /* starts on the vertical line */
  top: 50%;
  width: calc(var(--fp-children-indent) + 2px);         /* ends at the row's left edge */
  height: 2px;
  transform: translateY(-50%);
  background: var(--folder-color, var(--nav-indentation-guide-color));
  pointer-events: none;
}
```

If `before.json.rootChildrenCount > 0` (top-level items live under the root's `.nav-folder-children`), also append:

```css
/* the vault root is not a folder anyone drew a line from */
body .nav-files-container .nav-folder.mod-root > .nav-folder-children {
  margin-inline-start: 0;
  padding-inline-start: 0;
  border-inline-start: none;
}
body.fp-tree-lines .nav-files-container .nav-folder.mod-root > .nav-folder-children > .tree-item > .tree-item-self::after {
  content: none;
}
```

- [ ] **Step 8: Typecheck, build, bump to 0.2.2, deploy, dump**

Set `"version": "0.2.2"` in `manifest.json` and `package.json`.

```bash
cd "C:/Users/rober/Desktop/ObsidianCustomPlugins/FolderPalette" && npm run typecheck 2>&1 | tail -3 && npm test 2>&1 | tail -4 && npm run build 2>&1 | tail -2
```

```powershell
Stop-Process -Name Obsidian -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3
robocopy "C:\Users\rober\Desktop\ObsidianCustomPlugins\FolderPalette" "C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\folder-palette" main.js manifest.json styles.css /NJH /NJS
powershell -ExecutionPolicy Bypass -File "$S\restart-obsidian.ps1"
```

```bash
cd "$S" && node cdp.js explorerdump.js > after-toggles.json && node -e 'const d=require("./after-toggles.json");console.log(JSON.stringify({v:d.versions,body:d.bodyClasses},null,0));const vis=d.rows.filter(r=>r.visible&&r.kind!=="root");console.log("chevrons shown:",vis.filter(r=>r.chevron&&r.chevron.display!=="none").length,"/",vis.filter(r=>r.chevron).length);console.log("elbows:",vis.filter(r=>r.depth>0&&r.after.width!=="auto"&&r.after.width!=="0px").length,"/",vis.filter(r=>r.depth>0).length);for(const r of vis.filter(r=>r.children&&r.depth===0).slice(0,6))console.log(r.path,"folderColor="+r.folderColor,"childrenBorder="+r.children.borderLeft)' && node aligncheck.js after-toggles.json; node cdpshot.js after-toggles.png
```

Expected: `bodyClasses: ["fp-tree-lines"]` (no `fp-arrows-off`); every visible folder row reports a chevron with `display: "flex"`; every visible depth>0 row has a non-zero `after.width` (14px); each colored top-level folder's `childrenBorder` is `2px solid <its palette color as rgb()>`; `aligncheck` still passes. Read `after-toggles.png`: arrows in the gutter, colored lines with elbows.

- [ ] **Step 9: Real click on a chevron flips `is-collapsed`**

Pick a visible plain folder row `R` with a chevron from `after-toggles.json` and click its chevron's center:

```bash
cd "$S" && node -e 'const d=require("./after-toggles.json");const r=d.rows.find(r=>r.visible&&r.kind==="folder"&&r.chevron&&r.chevron.rect);console.log(r.path, r.collapsed, Math.round(r.chevron.rect.left+r.chevron.rect.width/2), Math.round(r.chevron.rect.top+r.chevron.rect.height/2))'
```

Then `node cdpclick.js <x> <y>`, dump to `after-click.json`, and confirm that row's `collapsed` flipped; click again and confirm it flipped back (leaves the user's fold state untouched).

- [ ] **Step 10: Restore any folders `toggle.js` expanded in Task 0/2, then commit**

If `toggle.js` was used with `COLLAPSE = false` on paths that were originally collapsed, set `COLLAPSE = true` with the same `PATHS` and run `node cdp.js toggle.js`.

```bash
cd "C:/Users/rober/Desktop/ObsidianCustomPlugins/FolderPalette" && git add src/settings.ts src/main.ts src/settingsTab.ts tests/settings.test.ts styles.css manifest.json package.json && git commit -m "feat: collapse-arrows and tree-lines settings, v0.2.2"
```

---

### Task 5: Docs, memory, sign-off

**Files:**
- Modify: `FolderPalette/README.md`, `FolderPalette/manifest.json` (description), `FolderPalette/package.json` (description)
- Modify: memory `folderpalette-plugin.md`, `explorer-layout-ownership.md`, `MEMORY.md`
- Delete (after Rob's sign-off only): `SyncedMain/.obsidian/snippets/bruh.css`

- [ ] **Step 1: README and manifest description**

`FolderPalette/manifest.json` and `package.json` description: `Explorer look for the file explorer: folder colors, icons, collapse arrows and tree lines.`

In `FolderPalette/README.md`:

(a) Replace the first paragraph with:

```
Obsidian plugin for the SyncedMain vault. Owns the look of the file explorer:
top-level folder colors from preset palettes, folder/file icons, the
top-level folder "cards", one indent for files, folders and BetterNotes at
the same depth, collapse arrows, and colored tree lines. It replaced the
hand-written `bruh.css` snippet on 2026-08-26 (kept as
`docs/legacy-bruh.css` for reference).
```

(b) Under "Use", after the *Color files inside folders* bullet add:

```
  - *Show collapse arrows*: the chevron on folder rows (down = open, right =
    closed); click it to fold. BetterNotes keep theirs regardless.
  - *Tree lines*: a 2px line in the folder's color from each folder down
    through its children, with an elbow into every child.
```

(c) Replace the whole "How it works with bruh.css" section with:

```
## How the CSS is layered

`styles.css` carries the static explorer look (body-prefixed so it wins ties
with the theme). Per-folder colors are injected at runtime into
`<style id="folder-palette-styles">` as `--folder-color` on each top-level
folder; that variable inherits down the subtree, which is how nested rows,
file glyphs and tree lines pick the color up. The two explorer toggles are
body classes, `fp-arrows-off` and `fp-tree-lines`. Variables other plugins may
read: `--fp-glyph-size`, `--fp-glyph-gap` (BetterNotes sizes its note icon
from them), `--fp-row-indent`, `--fp-children-margin`, `--fp-children-indent`.
```

(d) In "Limits", replace the first bullet with `- Top-level folders only (nested folders inherit their parent's color through `.nav-folder-title { color: var(--folder-color) }`).` and add `- Tree lines run the full height of a folder's children; no "L" corner at the last child.`

- [ ] **Step 2: Commit the docs**

```bash
cd "C:/Users/rober/Desktop/ObsidianCustomPlugins/FolderPalette" && git add README.md manifest.json package.json && git commit -m "docs: README and description for the explorer look, arrows and tree lines"
```

- [ ] **Step 3: Update memory**

Rewrite `folderpalette-plugin.md` so it says FolderPalette 0.2.2 owns the explorer look, the snippet is disabled (deleted once Rob signs off), and lists the body classes and `--fp-*` variables; rewrite `explorer-layout-ownership.md` so the "owner" is FolderPalette `styles.css` and the bruh.css facts are historical; refresh both index lines in `MEMORY.md`.

- [ ] **Step 4: Report to Rob and wait for sign-off before deleting the snippet**

Summarize: versions deployed, what the CDP checks proved, the four screenshots' paths. Ask Rob to look at the sidebar. Only after an explicit OK:

```powershell
New-Item -ItemType Directory -Force "$S\empty" | Out-Null
robocopy "$S\empty" "C:\Users\rober\Documents\SyncedMain\.obsidian\snippets" /MIR /NJH /NJS
```

(`/MIR` is safe here: `snippets/` contains only `bruh.css`. Expected exit code 2 = extras purged.) Then update the memory note to say the snippet is gone.
