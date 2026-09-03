# BetterNotes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the BetterNotes Obsidian plugin (Notion-style folder+note units with explorer integration, attachments bar, nesting, Ctrl+N takeover) and deploy it to the SyncedMain vault, replacing the folder-notes plugin.

**Architecture:** A pure-logic core (`src/core/pairing.ts`, unit-tested with vitest) computes all path math (detection, create/convert/flatten plans, rename-sync ops). `src/main.ts` wires vault/workspace events to that core and owns commands + hotkey takeover. `src/explorer/patch.ts` decorates the file-explorer DOM (note styling, hidden inner note, chevron rules) and intercepts title clicks. `src/view/attachments.ts` renders an attachments bar into markdown views.

**Tech Stack:** TypeScript, esbuild (bundle → `main.js`), vitest (unit tests), Obsidian plugin API (target ≥ 1.4.0).

**Spec:** `docs/superpowers/specs/2026-08-15-betternotes-design.md`

## Global Constraints

- Plugin id `betternotes`, `minAppVersion: "1.4.0"`, markdown-only folder notes (`X/X.md` inside `X/`), matching the vault's existing folder-notes convention.
- Attachments stored in the BetterNote folder **root** (user decision 2a). Chevron reveals **all** children (3a). Ctrl+N **full takeover**, default on (1a).
- All vault mutations go through `app.fileManager.renameFile` (link updates) or `app.vault.create/createFolder`; deletes honor the user's trash setting.
- Name collisions resolve by suffixing ` 1`, ` 2`, … (folders: `Untitled 1`; files: `img 1.png`).
- Plugin unload must fully restore stock explorer behavior (classes, listeners, patched `getAvailablePathForAttachments`).
- Internal Obsidian APIs (`hotkeyManager`, `getAvailablePathForAttachments`, explorer `fileItems`) are wrapped in feature-detection/try-catch and degrade with a `Notice`, never a crash.
- Target vault for deployment: `C:\Users\rober\Documents\SyncedMain`. Backup BEFORE any vault change.

---

### Task 1: Scaffold (build + test toolchain green)

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json`, `.gitignore`, `styles.css` (empty placeholder), `src/main.ts` (stub)

**Interfaces:**
- Produces: `npm run build` → `main.js`; `npm test` → vitest run; manifest id `betternotes`.

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "betternotes",
  "version": "1.0.0",
  "description": "Notion-style notes that contain attachments and nested notes",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "node esbuild.config.mjs production",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "builtin-modules": "^4.0.0",
    "esbuild": "^0.21.5",
    "obsidian": "^1.5.7",
    "tslib": "^2.6.2",
    "typescript": "^5.5.2",
    "vitest": "^2.0.5"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "module": "ESNext",
    "target": "ES2020",
    "moduleResolution": "Bundler",
    "lib": ["DOM", "ES2020"],
    "strict": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "importHelpers": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

`esbuild.config.mjs`:
```js
import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
```

`manifest.json`:
```json
{
  "id": "betternotes",
  "name": "BetterNotes",
  "version": "1.0.0",
  "minAppVersion": "1.4.0",
  "description": "Notion-style notes: notes that contain attachments and nested notes. Replaces folder notes.",
  "author": "rober",
  "isDesktopOnly": false
}
```

`.gitignore`:
```
node_modules/
main.js
*.map
```

`styles.css`: create empty (filled in Task 4/9).

`src/main.ts` stub:
```ts
import { Plugin } from "obsidian";

export default class BetterNotesPlugin extends Plugin {
  async onload() {}
}
```

- [ ] **Step 2: Install and verify build + tests run**

Run: `npm install` then `npm run build` then `npx vitest run --passWithNoTests`
Expected: `main.js` produced; vitest exits 0 with "no test files found" tolerated via flag.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold plugin build and test toolchain"
```

---

### Task 2: Pure pairing core (TDD)

**Files:**
- Create: `src/core/pairing.ts`
- Test: `tests/pairing.test.ts`

**Interfaces:**
- Produces (consumed by all later tasks):
  - `basename(path: string): string`, `dirname(path: string): string`, `join(parent: string, name: string): string`
  - `noteNameForFolder(folderPath: string): string` — `"A/B"` → `"A/B/B.md"`
  - `folderForInnerNote(notePath: string): string | null` — `"A/B/B.md"` → `"A/B"`, else `null`
  - `collisionFree(desired: string, exists: (p: string) => boolean): string` — folder-style suffixing
  - `collisionFreeFile(desiredPath: string, exists: (p: string) => boolean): string` — suffix before extension
  - `interface RenameOp { from: string; to: string }`
  - `folderRenameSync(oldPath, newPath, exists): RenameOp | null`
  - `noteRenameSync(oldPath, newPath, exists): RenameOp | null`
  - `interface ConvertPlan { folder: string; createFolder: boolean; noteTo: string }`
  - `convertPlan(notePath, exists): ConvertPlan | null`
  - `interface FlattenPlan { noteTo: string; deleteFolder: boolean }`
  - `flattenPlan(folderPath, childPaths: string[], exists): FlattenPlan | null`
  - `newBetterNotePlan(parentPath, exists): { folder: string; note: string }`
  - `IMAGE_EXTS: Set<string>`

- [ ] **Step 1: Write the failing tests**

`tests/pairing.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  basename, dirname, join, noteNameForFolder, folderForInnerNote,
  collisionFree, collisionFreeFile, folderRenameSync, noteRenameSync,
  convertPlan, flattenPlan, newBetterNotePlan,
} from "../src/core/pairing";

const none = (_p: string) => false;
const only = (...paths: string[]) => (p: string) => paths.includes(p);

describe("path helpers", () => {
  it("basename/dirname/join", () => {
    expect(basename("A/B/C.md")).toBe("C.md");
    expect(basename("C.md")).toBe("C.md");
    expect(dirname("A/B/C.md")).toBe("A/B");
    expect(dirname("C.md")).toBe("");
    expect(join("", "X")).toBe("X");
    expect(join("A/B", "X")).toBe("A/B/X");
  });
});

describe("betternote identity", () => {
  it("noteNameForFolder", () => {
    expect(noteNameForFolder("Projects")).toBe("Projects/Projects.md");
    expect(noteNameForFolder("A/B")).toBe("A/B/B.md");
  });
  it("folderForInnerNote matches only same-named inner md", () => {
    expect(folderForInnerNote("A/B/B.md")).toBe("A/B");
    expect(folderForInnerNote("B/B.md")).toBe("B");
    expect(folderForInnerNote("A/B/C.md")).toBeNull();
    expect(folderForInnerNote("B.md")).toBeNull();
    expect(folderForInnerNote("A/B/B.png")).toBeNull();
  });
});

describe("collision suffixing", () => {
  it("folders", () => {
    expect(collisionFree("A/Untitled", none)).toBe("A/Untitled");
    expect(collisionFree("A/Untitled", only("A/Untitled"))).toBe("A/Untitled 1");
    expect(collisionFree("A/Untitled", only("A/Untitled", "A/Untitled 1"))).toBe("A/Untitled 2");
  });
  it("files keep extension", () => {
    expect(collisionFreeFile("A/img.png", none)).toBe("A/img.png");
    expect(collisionFreeFile("A/img.png", only("A/img.png"))).toBe("A/img 1.png");
  });
});

describe("folderRenameSync", () => {
  it("renames carried note when folder renamed", () => {
    expect(folderRenameSync("A/B", "A/C", only("A/C/B.md")))
      .toEqual({ from: "A/C/B.md", to: "A/C/C.md" });
  });
  it("null on pure move (same basename)", () => {
    expect(folderRenameSync("A/B", "X/B", only("X/B/B.md"))).toBeNull();
  });
  it("null when not a betternote", () => {
    expect(folderRenameSync("A/B", "A/C", none)).toBeNull();
  });
  it("null when target name already taken", () => {
    expect(folderRenameSync("A/B", "A/C", only("A/C/B.md", "A/C/C.md"))).toBeNull();
  });
});

describe("noteRenameSync", () => {
  it("renames folder when inner note renamed in place", () => {
    expect(noteRenameSync("A/B/B.md", "A/B/C.md", none))
      .toEqual({ from: "A/B", to: "A/C" });
  });
  it("root-level betternote", () => {
    expect(noteRenameSync("B/B.md", "B/C.md", none)).toEqual({ from: "B", to: "C" });
  });
  it("null when note moved out of its folder", () => {
    expect(noteRenameSync("A/B/B.md", "A/B.md", none)).toBeNull();
  });
  it("null when source was not inner note", () => {
    expect(noteRenameSync("A/B/C.md", "A/B/D.md", none)).toBeNull();
  });
  it("null when target folder name taken", () => {
    expect(noteRenameSync("A/B/B.md", "A/B/C.md", only("A/C"))).toBeNull();
  });
});

describe("convertPlan", () => {
  it("creates folder and moves note in", () => {
    expect(convertPlan("A/B.md", none))
      .toEqual({ folder: "A/B", createFolder: true, noteTo: "A/B/B.md" });
  });
  it("merges into existing folder without inner note", () => {
    expect(convertPlan("A/B.md", only("A/B")))
      .toEqual({ folder: "A/B", createFolder: false, noteTo: "A/B/B.md" });
  });
  it("suffixes when folder exists WITH inner note", () => {
    expect(convertPlan("A/B.md", only("A/B", "A/B/B.md")))
      .toEqual({ folder: "A/B 1", createFolder: true, noteTo: "A/B 1/B 1.md" });
  });
  it("null for an already-inner note", () => {
    expect(convertPlan("A/B/B.md", none)).toBeNull();
  });
});

describe("flattenPlan", () => {
  it("moves note out and deletes empty folder", () => {
    expect(flattenPlan("A/B", ["A/B/B.md"], none))
      .toEqual({ noteTo: "A/B.md", deleteFolder: true });
  });
  it("keeps folder when it has other children", () => {
    expect(flattenPlan("A/B", ["A/B/B.md", "A/B/img.png"], none))
      .toEqual({ noteTo: "A/B.md", deleteFolder: false });
  });
  it("suffixes when sibling file exists", () => {
    expect(flattenPlan("A/B", ["A/B/B.md"], only("A/B.md")))
      .toEqual({ noteTo: "A/B 1.md", deleteFolder: true });
  });
  it("null when folder is not a betternote", () => {
    expect(flattenPlan("A/B", ["A/B/x.md"], none)).toBeNull();
  });
});

describe("newBetterNotePlan", () => {
  it("Untitled in parent", () => {
    expect(newBetterNotePlan("A", none))
      .toEqual({ folder: "A/Untitled", note: "A/Untitled/Untitled.md" });
  });
  it("root + collision", () => {
    expect(newBetterNotePlan("", only("Untitled")))
      .toEqual({ folder: "Untitled 1", note: "Untitled 1/Untitled 1.md" });
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run`
Expected: FAIL — cannot resolve `../src/core/pairing`.

- [ ] **Step 3: Implement `src/core/pairing.ts`**

```ts
// Pure path math for BetterNotes. No Obsidian imports — unit-testable.
export type Exists = (path: string) => boolean;

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function join(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

export function noteNameForFolder(folderPath: string): string {
  return `${folderPath}/${basename(folderPath)}.md`;
}

export function folderForInnerNote(notePath: string): string | null {
  if (!notePath.endsWith(".md")) return null;
  const dir = dirname(notePath);
  if (dir === "") return null;
  return basename(notePath) === `${basename(dir)}.md` ? dir : null;
}

export function collisionFree(desired: string, exists: Exists): string {
  if (!exists(desired)) return desired;
  for (let n = 1; ; n++) {
    const candidate = `${desired} ${n}`;
    if (!exists(candidate)) return candidate;
  }
}

export function collisionFreeFile(desiredPath: string, exists: Exists): string {
  if (!exists(desiredPath)) return desiredPath;
  const dot = desiredPath.lastIndexOf(".");
  const stem = dot === -1 ? desiredPath : desiredPath.slice(0, dot);
  const ext = dot === -1 ? "" : desiredPath.slice(dot);
  for (let n = 1; ; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

export interface RenameOp { from: string; to: string }

/** After a folder rename oldPath -> newPath, the op keeping its inner note in sync. */
export function folderRenameSync(oldPath: string, newPath: string, exists: Exists): RenameOp | null {
  const oldName = basename(oldPath);
  const newName = basename(newPath);
  if (oldName === newName) return null; // pure move — pairing survives untouched
  const carried = `${newPath}/${oldName}.md`;
  if (!exists(carried)) return null; // wasn't a betternote
  const target = `${newPath}/${newName}.md`;
  if (exists(target)) return null; // collision — leave unpaired rather than clobber
  return { from: carried, to: target };
}

/** After a note rename oldPath -> newPath, the op keeping its folder in sync. */
export function noteRenameSync(oldPath: string, newPath: string, exists: Exists): RenameOp | null {
  const oldFolder = folderForInnerNote(oldPath);
  if (oldFolder === null) return null;
  if (!newPath.endsWith(".md")) return null;
  if (dirname(newPath) !== oldFolder) return null; // moved out — unpair
  const newBase = basename(newPath).slice(0, -3);
  const target = join(dirname(oldFolder), newBase);
  if (exists(target)) return null;
  return { from: oldFolder, to: target };
}

export interface ConvertPlan { folder: string; createFolder: boolean; noteTo: string }

export function convertPlan(notePath: string, exists: Exists): ConvertPlan | null {
  if (!notePath.endsWith(".md")) return null;
  if (folderForInnerNote(notePath) !== null) return null;
  const dir = dirname(notePath);
  const base = basename(notePath).slice(0, -3);
  const natural = join(dir, base);
  if (exists(natural) && !exists(noteNameForFolder(natural))) {
    return { folder: natural, createFolder: false, noteTo: noteNameForFolder(natural) };
  }
  const folder = collisionFree(natural, exists);
  return { folder, createFolder: true, noteTo: noteNameForFolder(folder) };
}

export interface FlattenPlan { noteTo: string; deleteFolder: boolean }

export function flattenPlan(folderPath: string, childPaths: string[], exists: Exists): FlattenPlan | null {
  const inner = noteNameForFolder(folderPath);
  if (!childPaths.includes(inner)) return null;
  const desired = join(dirname(folderPath), `${basename(folderPath)}.md`);
  return {
    noteTo: collisionFreeFile(desired, exists),
    deleteFolder: childPaths.length === 1,
  };
}

export function newBetterNotePlan(parentPath: string, exists: Exists): { folder: string; note: string } {
  const folder = collisionFree(join(parentPath, "Untitled"), exists);
  return { folder, note: noteNameForFolder(folder) };
}

export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `npx vitest run`
Expected: PASS, all suites green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: pure pairing core with unit tests"
```

---

### Task 3: Plugin skeleton + settings

**Files:**
- Create: `src/settings.ts`
- Modify: `src/main.ts` (replace stub)

**Interfaces:**
- Produces: `BetterNotesPlugin` with `settings`, `saveSettings()`, `exists(p)`, `isBetterNote(af)`, `isInnerNote(af)`, `applyHotkeyTakeover()`; `BetterNotesSettings { takeoverCtrlN, showChildren, attachmentsBar, attachmentsBarCollapsed }` (defaults: true, true, true, false).
- Consumes: pairing helpers from Task 2. References `ExplorerPatch` (Task 4) and `AttachmentsBar` (Task 9) — create them in this task as minimal placeholder classes with `enable()/disable()/scheduleDecorate()/applyGlobalToggle()` and `enable()/disable()/refreshAll()/refreshSoon()` no-op methods so the build stays green; Tasks 4 and 9 fill them in.

- [ ] **Step 1: Write `src/settings.ts`**

```ts
import { App, PluginSettingTab, Setting } from "obsidian";
import type BetterNotesPlugin from "./main";

export interface BetterNotesSettings {
  takeoverCtrlN: boolean;
  showChildren: boolean;
  attachmentsBar: boolean;
  attachmentsBarCollapsed: boolean;
}

export const DEFAULT_SETTINGS: BetterNotesSettings = {
  takeoverCtrlN: true,
  showChildren: true,
  attachmentsBar: true,
  attachmentsBarCollapsed: false,
};

export class BetterNotesSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BetterNotesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Take over Ctrl+N")
      .setDesc("Ctrl+N creates a BetterNote; the core 'Create new note' hotkey is unbound. Turn off to restore the default binding.")
      .addToggle((t) => t.setValue(this.plugin.settings.takeoverCtrlN).onChange(async (v) => {
        this.plugin.settings.takeoverCtrlN = v;
        await this.plugin.saveSettings();
        this.plugin.applyHotkeyTakeover();
      }));

    new Setting(containerEl)
      .setName("Show BetterNote children")
      .setDesc("Show the chevron and the files/notes underneath BetterNotes in the file explorer.")
      .addToggle((t) => t.setValue(this.plugin.settings.showChildren).onChange(async (v) => {
        this.plugin.settings.showChildren = v;
        await this.plugin.saveSettings();
        this.plugin.explorer.applyGlobalToggle();
      }));

    new Setting(containerEl)
      .setName("Attachments bar")
      .setDesc("Show attachments stored inside a BetterNote at the bottom of its note.")
      .addToggle((t) => t.setValue(this.plugin.settings.attachmentsBar).onChange(async (v) => {
        this.plugin.settings.attachmentsBar = v;
        await this.plugin.saveSettings();
        this.plugin.attachments.refreshAll();
      }));

    new Setting(containerEl)
      .setName("Collapse attachments bar by default")
      .setDesc("Start with the attachments bar collapsed to just its header.")
      .addToggle((t) => t.setValue(this.plugin.settings.attachmentsBarCollapsed).onChange(async (v) => {
        this.plugin.settings.attachmentsBarCollapsed = v;
        await this.plugin.saveSettings();
        this.plugin.attachments.refreshAll();
      }));
  }
}
```

- [ ] **Step 2: Write `src/main.ts`** (full replacement; placeholder classes inline-referenced)

```ts
import { Menu, Notice, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import * as pairing from "./core/pairing";
import { BetterNotesSettings, BetterNotesSettingTab, DEFAULT_SETTINGS } from "./settings";
import { ExplorerPatch } from "./explorer/patch";
import { AttachmentsBar } from "./view/attachments";

export default class BetterNotesPlugin extends Plugin {
  settings: BetterNotesSettings = DEFAULT_SETTINGS;
  explorer!: ExplorerPatch;
  attachments!: AttachmentsBar;
  private syncing = false;
  private origAttachmentPathFn: ((...args: unknown[]) => Promise<string>) | null = null;

  exists = (p: string): boolean => this.app.vault.getAbstractFileByPath(p) !== null;

  async onload() {
    await this.loadSettings();
    this.explorer = new ExplorerPatch(this);
    this.attachments = new AttachmentsBar(this);
    this.addSettingTab(new BetterNotesSettingTab(this.app, this));

    this.addCommand({
      id: "new-betternote",
      name: "New BetterNote",
      hotkeys: [{ modifiers: ["Mod"], key: "n" }],
      callback: () => this.createBetterNote(),
    });
    this.addCommand({
      id: "toggle-children",
      name: "Toggle BetterNote children visibility",
      callback: async () => {
        this.settings.showChildren = !this.settings.showChildren;
        await this.saveSettings();
        this.explorer.applyGlobalToggle();
      },
    });
    this.addCommand({
      id: "convert-note",
      name: "Convert current note to BetterNote",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "md" || this.isInnerNote(f)) return false;
        if (!checking) void this.convertNote(f);
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.onFileMenu(menu, file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.onRename(file, oldPath)));

    this.app.workspace.onLayoutReady(() => {
      this.explorer.enable();
      this.attachments.enable();
      this.patchAttachmentPath();
      this.applyHotkeyTakeover();
    });
  }

  onunload() {
    this.explorer.disable();
    this.attachments.disable();
    this.unpatchAttachmentPath();
    if (this.settings.takeoverCtrlN) this.restoreCoreNewNoteHotkey();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- identity -----------------------------------------------------------

  isBetterNote(af: TAbstractFile | null): af is TFolder {
    return af instanceof TFolder &&
      this.app.vault.getAbstractFileByPath(pairing.noteNameForFolder(af.path)) instanceof TFile;
  }

  isInnerNote(af: TAbstractFile | null): af is TFile {
    return af instanceof TFile && af.extension === "md" &&
      pairing.folderForInnerNote(af.path) !== null;
  }

  innerNoteOf(folder: TFolder): TFile | null {
    const af = this.app.vault.getAbstractFileByPath(pairing.noteNameForFolder(folder.path));
    return af instanceof TFile ? af : null;
  }

  // ---- creation / conversion ---------------------------------------------

  async createBetterNote(parent?: TFolder) {
    const parentFolder = parent ??
      this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
    const parentPath = parentFolder.path === "/" ? "" : parentFolder.path;
    const plan = pairing.newBetterNotePlan(parentPath, this.exists);
    this.syncing = true;
    try {
      await this.app.vault.createFolder(plan.folder);
      const note = await this.app.vault.create(plan.note, "");
      await this.app.workspace.getLeaf(false).openFile(note);
    } finally {
      this.syncing = false;
    }
    this.explorer.scheduleDecorate();
    // Focus the title for immediate renaming (F2 behavior); rename-sync renames the folder.
    window.setTimeout(() => {
      (this.app as any).commands?.executeCommandById?.("workspace:edit-file-title");
    }, 100);
  }

  async makeBetterNote(folder: TFolder) {
    const notePath = pairing.noteNameForFolder(folder.path);
    if (this.exists(notePath)) return;
    const note = await this.app.vault.create(notePath, "");
    await this.app.workspace.getLeaf(false).openFile(note);
    this.explorer.scheduleDecorate();
  }

  async convertNote(file: TFile) {
    const plan = pairing.convertPlan(file.path, this.exists);
    if (!plan) return;
    this.syncing = true;
    try {
      if (plan.createFolder) await this.app.vault.createFolder(plan.folder);
      await this.app.fileManager.renameFile(file, plan.noteTo);
    } catch (e) {
      console.error("BetterNotes: convert failed", e);
      new Notice("BetterNotes: convert failed — see console.");
    } finally {
      this.syncing = false;
    }
    this.explorer.scheduleDecorate();
  }

  async flatten(folder: TFolder) {
    const plan = pairing.flattenPlan(folder.path, folder.children.map((c) => c.path), this.exists);
    if (!plan) return;
    const note = this.innerNoteOf(folder);
    if (!note) return;
    this.syncing = true;
    try {
      await this.app.fileManager.renameFile(note, plan.noteTo);
      if (plan.deleteFolder) {
        const fm = this.app.fileManager as any;
        if (typeof fm.trashFile === "function") await fm.trashFile(folder);
        else await this.app.vault.trash(folder, true);
      }
    } catch (e) {
      console.error("BetterNotes: flatten failed", e);
      new Notice("BetterNotes: flatten failed — see console.");
    } finally {
      this.syncing = false;
    }
    this.explorer.scheduleDecorate();
  }

  // ---- sync ---------------------------------------------------------------

  private async onRename(file: TAbstractFile, oldPath: string) {
    this.explorer.scheduleDecorate();
    this.attachments.refreshSoon();
    if (this.syncing) return;
    let op: pairing.RenameOp | null = null;
    if (file instanceof TFolder) op = pairing.folderRenameSync(oldPath, file.path, this.exists);
    else if (file instanceof TFile && file.extension === "md") op = pairing.noteRenameSync(oldPath, file.path, this.exists);
    if (!op) return;
    const target = this.app.vault.getAbstractFileByPath(op.from);
    if (!target) return;
    this.syncing = true;
    try {
      await this.app.fileManager.renameFile(target, op.to);
    } catch (e) {
      console.error("BetterNotes: rename sync failed", e);
    } finally {
      this.syncing = false;
    }
    this.explorer.scheduleDecorate();
  }

  // ---- menus --------------------------------------------------------------

  private onFileMenu(menu: Menu, file: TAbstractFile) {
    if (file instanceof TFolder) {
      menu.addItem((i) => i.setTitle("New BetterNote inside").setIcon("file-plus-2")
        .onClick(() => void this.createBetterNote(file)));
      if (this.isBetterNote(file)) {
        menu.addItem((i) => i.setTitle("Flatten to plain note").setIcon("file-minus-2")
          .onClick(() => void this.flatten(file)));
      } else {
        menu.addItem((i) => i.setTitle("Turn into BetterNote").setIcon("file-symlink")
          .onClick(() => void this.makeBetterNote(file)));
      }
    } else if (file instanceof TFile && file.extension === "md" && !this.isInnerNote(file)) {
      menu.addItem((i) => i.setTitle("Convert to BetterNote").setIcon("file-symlink")
        .onClick(() => void this.convertNote(file)));
    }
  }

  // ---- Ctrl+N takeover ----------------------------------------------------

  applyHotkeyTakeover() {
    const hm = (this.app as any).hotkeyManager;
    if (!hm || typeof hm.setHotkeys !== "function") {
      if (this.settings.takeoverCtrlN) {
        new Notice("BetterNotes: couldn't rebind Ctrl+N automatically — unbind 'Create new note' in Settings → Hotkeys.");
      }
      return;
    }
    try {
      if (this.settings.takeoverCtrlN) hm.setHotkeys("file-explorer:new-file", []);
      else hm.removeHotkeys("file-explorer:new-file");
      hm.bake?.();
      hm.save?.();
    } catch (e) {
      console.error("BetterNotes: hotkey takeover failed", e);
    }
  }

  private restoreCoreNewNoteHotkey() {
    try {
      const hm = (this.app as any).hotkeyManager;
      hm?.removeHotkeys?.("file-explorer:new-file");
      hm?.bake?.();
      hm?.save?.();
    } catch (e) {
      console.error("BetterNotes: hotkey restore failed", e);
    }
  }

  // ---- attachment path override -------------------------------------------

  private patchAttachmentPath() {
    const vault = this.app.vault as any;
    if (typeof vault.getAvailablePathForAttachments !== "function") return;
    this.origAttachmentPathFn = vault.getAvailablePathForAttachments;
    const plugin = this;
    vault.getAvailablePathForAttachments = async function (
      fileName: string, extension: string, file: TAbstractFile | null, ...rest: unknown[]
    ): Promise<string> {
      if (file instanceof TFile && plugin.isInnerNote(file) && file.parent) {
        const parentPath = file.parent.path === "/" ? "" : file.parent.path;
        const desired = pairing.join(parentPath, `${fileName}.${extension}`);
        return pairing.collisionFreeFile(desired, plugin.exists);
      }
      return plugin.origAttachmentPathFn!.call(this, fileName, extension, file, ...rest);
    };
  }

  private unpatchAttachmentPath() {
    if (this.origAttachmentPathFn) {
      (this.app.vault as any).getAvailablePathForAttachments = this.origAttachmentPathFn;
      this.origAttachmentPathFn = null;
    }
  }
}
```

- [ ] **Step 3: Create placeholder `src/explorer/patch.ts` and `src/view/attachments.ts`**

`src/explorer/patch.ts` (placeholder, replaced in Task 4):
```ts
import type BetterNotesPlugin from "../main";

export class ExplorerPatch {
  constructor(protected plugin: BetterNotesPlugin) {}
  enable() {}
  disable() {}
  scheduleDecorate() {}
  applyGlobalToggle() {}
}
```

`src/view/attachments.ts` (placeholder, replaced in Task 9):
```ts
import type BetterNotesPlugin from "../main";

export class AttachmentsBar {
  constructor(protected plugin: BetterNotesPlugin) {}
  enable() {}
  disable() {}
  refreshAll() {}
  refreshSoon() {}
}
```

- [ ] **Step 4: Build + tests**

Run: `npm run build && npx vitest run`
Expected: build succeeds, tests still pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: plugin skeleton — settings, commands, sync, menus, hotkey takeover, attachment path override"
```

---

### Task 4: Explorer patch + explorer styles

**Files:**
- Modify: `src/explorer/patch.ts` (replace placeholder), `styles.css`

**Interfaces:**
- Consumes: `plugin.isBetterNote`, `plugin.isInnerNote`, `plugin.settings.showChildren`, `pairing.noteNameForFolder`.
- Produces: `ExplorerPatch.enable()`, `.disable()`, `.scheduleDecorate()`, `.applyGlobalToggle()` (same signatures as placeholder). CSS classes: `betternote`, `betternote-no-children`, `betternote-hidden-note`, `betternote-icon`, body class `betternotes-hide-children`.

- [ ] **Step 1: Replace `src/explorer/patch.ts`**

```ts
import { TFile, TFolder, setIcon } from "obsidian";
import type BetterNotesPlugin from "../main";
import { noteNameForFolder } from "../core/pairing";

export class ExplorerPatch {
  private raf = 0;
  private clickHandler = (evt: MouseEvent) => this.onClick(evt);

  constructor(private plugin: BetterNotesPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  enable() {
    document.body.addEventListener("click", this.clickHandler, true);
    this.plugin.registerEvent(this.app.vault.on("create", () => this.scheduleDecorate()));
    this.plugin.registerEvent(this.app.vault.on("delete", () => this.scheduleDecorate()));
    this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleDecorate()));
    this.applyGlobalToggle();
    this.scheduleDecorate();
  }

  disable() {
    document.body.removeEventListener("click", this.clickHandler, true);
    document.body.removeClass("betternotes-hide-children");
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const view of this.explorerViews()) {
      const items = view.fileItems ?? {};
      for (const path in items) this.undecorateItem(items[path]);
    }
  }

  applyGlobalToggle() {
    document.body.toggleClass("betternotes-hide-children", !this.plugin.settings.showChildren);
  }

  scheduleDecorate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.decorate();
    });
  }

  private explorerViews(): any[] {
    return this.app.workspace.getLeavesOfType("file-explorer").map((l) => l.view as any);
  }

  private decorate() {
    for (const view of this.explorerViews()) {
      const items = view.fileItems;
      if (!items) continue;
      for (const path in items) {
        const item = items[path];
        const af = item?.file;
        if (af instanceof TFolder) {
          if (this.plugin.isBetterNote(af)) this.decorateFolder(item, af);
          else this.undecorateItem(item);
        } else if (af instanceof TFile) {
          this.rootElOf(item)?.toggleClass("betternote-hidden-note", this.plugin.isInnerNote(af));
        }
      }
    }
  }

  private rootElOf(item: any): HTMLElement | null {
    return (item?.el as HTMLElement) ?? (item?.selfEl as HTMLElement | undefined)?.parentElement ?? null;
  }

  private decorateFolder(item: any, folder: TFolder) {
    const rootEl = this.rootElOf(item);
    const selfEl = item?.selfEl as HTMLElement | undefined;
    if (!rootEl || !selfEl) return;
    rootEl.addClass("betternote");
    const inner = noteNameForFolder(folder.path);
    const others = folder.children.filter((c) => c.path !== inner);
    rootEl.toggleClass("betternote-no-children", others.length === 0);
    if (!selfEl.querySelector(".betternote-icon")) {
      const icon = document.createElement("div");
      icon.className = "betternote-icon";
      setIcon(icon, "file-text");
      const content = selfEl.querySelector(".nav-folder-title-content");
      selfEl.insertBefore(icon, content);
    }
  }

  private undecorateItem(item: any) {
    const rootEl = this.rootElOf(item);
    rootEl?.removeClass("betternote", "betternote-no-children", "betternote-hidden-note");
    (item?.selfEl as HTMLElement | undefined)?.querySelector(".betternote-icon")?.remove();
  }

  private onClick(evt: MouseEvent) {
    const target = evt.target as HTMLElement | null;
    if (!target) return;
    const content = target.closest(".nav-folder-title-content");
    if (!content) return;
    const titleEl = content.closest(".nav-folder-title") as HTMLElement | null;
    const path = titleEl?.getAttribute("data-path");
    if (!path) return;
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof TFolder) || !this.plugin.isBetterNote(folder)) return;
    const note = this.plugin.innerNoteOf(folder);
    if (!note) return;
    evt.preventDefault();
    evt.stopPropagation();
    void this.app.workspace.getLeaf(evt.ctrlKey || evt.metaKey ? "tab" : false).openFile(note);
  }
}
```

- [ ] **Step 2: Write explorer styles into `styles.css`**

```css
/* ==== BetterNotes: file explorer ==== */

/* the inner note row is the betternote itself — never show it separately */
.betternote-hidden-note {
  display: none !important;
}

/* betternote rows read as notes, not folders */
.betternote > .nav-folder-title .nav-folder-title-content {
  text-decoration: none;
  font-weight: inherit;
}

.betternote-icon {
  display: inline-flex;
  align-items: center;
  margin-right: var(--size-2-2);
  color: var(--text-muted);
}

.betternote-icon svg {
  width: 16px;
  height: 16px;
}

/* no chevron when there is nothing underneath (besides the note itself) */
.betternote.betternote-no-children > .nav-folder-title .nav-folder-collapse-indicator {
  visibility: hidden;
}

/* global "hide children" mode — betternotes read as flat notes */
body.betternotes-hide-children .betternote > .nav-folder-children {
  display: none !important;
}

body.betternotes-hide-children .betternote > .nav-folder-title .nav-folder-collapse-indicator {
  visibility: hidden;
}
```

- [ ] **Step 3: Build + tests**

Run: `npm run build && npx vitest run`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: file explorer decoration, click interception, children toggle"
```

---

### Task 5: Attachments bar

**Files:**
- Modify: `src/view/attachments.ts` (replace placeholder), `styles.css` (append)

**Interfaces:**
- Consumes: `plugin.isInnerNote`, `plugin.settings.attachmentsBar/attachmentsBarCollapsed`, `pairing.IMAGE_EXTS`.
- Produces: `AttachmentsBar.enable()/disable()/refreshAll()/refreshSoon()` (same signatures as placeholder).

- [ ] **Step 1: Replace `src/view/attachments.ts`**

```ts
import { MarkdownView, TFile, setIcon } from "obsidian";
import type BetterNotesPlugin from "../main";
import { IMAGE_EXTS } from "../core/pairing";

const BAR_CLASS = "betternotes-attachments";

const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "3gp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "webm", "avi"]);

function iconFor(ext: string): string {
  const e = ext.toLowerCase();
  if (AUDIO_EXTS.has(e)) return "file-audio";
  if (VIDEO_EXTS.has(e)) return "file-video";
  if (e === "pdf") return "file-text";
  return "file";
}

export class AttachmentsBar {
  private timer = 0;

  constructor(private plugin: BetterNotesPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  enable() {
    this.plugin.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshAll()));
    this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.refreshAll()));
    this.plugin.registerEvent(this.app.vault.on("create", () => this.refreshSoon()));
    this.plugin.registerEvent(this.app.vault.on("delete", () => this.refreshSoon()));
    this.refreshAll();
  }

  disable() {
    window.clearTimeout(this.timer);
    document.querySelectorAll(`.${BAR_CLASS}`).forEach((el) => el.remove());
  }

  refreshSoon() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refreshAll(), 150);
  }

  refreshAll() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) this.attach(leaf.view);
    }
  }

  private attach(view: MarkdownView) {
    view.containerEl.querySelectorAll(`.${BAR_CLASS}`).forEach((el) => el.remove());
    if (!this.plugin.settings.attachmentsBar) return;
    const file = view.file;
    if (!file || !this.plugin.isInnerNote(file) || !file.parent) return;

    const atts = file.parent.children
      .filter((c): c is TFile => c instanceof TFile && c.extension !== "md")
      .sort((a, b) => a.name.localeCompare(b.name));
    if (atts.length === 0) return;

    const content = view.containerEl.querySelector(".view-content");
    if (!content) return;

    const bar = document.createElement("div");
    bar.className = BAR_CLASS;
    if (this.plugin.settings.attachmentsBarCollapsed) bar.classList.add("is-collapsed");

    const header = document.createElement("div");
    header.className = `${BAR_CLASS}-header`;
    const clip = document.createElement("span");
    setIcon(clip, "paperclip");
    header.appendChild(clip);
    const label = document.createElement("span");
    label.textContent = `Attachments (${atts.length})`;
    header.appendChild(label);
    const chevron = document.createElement("span");
    chevron.className = `${BAR_CLASS}-chevron`;
    setIcon(chevron, "chevron-down");
    header.appendChild(chevron);
    header.addEventListener("click", () => {
      const collapsed = bar.classList.toggle("is-collapsed");
      this.plugin.settings.attachmentsBarCollapsed = collapsed;
      void this.plugin.saveSettings();
    });
    bar.appendChild(header);

    const grid = document.createElement("div");
    grid.className = `${BAR_CLASS}-grid`;
    for (const att of atts) {
      const item = document.createElement("div");
      item.className = "betternotes-attachment";
      if (IMAGE_EXTS.has(att.extension.toLowerCase())) {
        const img = document.createElement("img");
        img.src = this.app.vault.getResourcePath(att);
        img.alt = att.name;
        item.appendChild(img);
      } else {
        const box = document.createElement("div");
        box.className = "betternotes-attachment-iconbox";
        setIcon(box, iconFor(att.extension));
        item.appendChild(box);
      }
      const name = document.createElement("div");
      name.className = "betternotes-attachment-name";
      name.textContent = att.name;
      name.title = att.name;
      item.appendChild(name);
      item.addEventListener("click", () => {
        void this.app.workspace.getLeaf("tab").openFile(att);
      });
      item.addEventListener("mouseover", (event) => {
        this.app.workspace.trigger("hover-link", {
          event, source: "betternotes", hoverParent: view,
          targetEl: item, linktext: att.path,
        });
      });
      grid.appendChild(item);
    }
    bar.appendChild(grid);
    content.appendChild(bar);
  }
}
```

- [ ] **Step 2: Append attachments-bar styles to `styles.css`**

```css
/* ==== BetterNotes: attachments bar ==== */

.betternotes-attachments {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  border-top: 1px solid var(--background-modifier-border);
  background: var(--background-primary);
  max-height: 40%;
  overflow-y: auto;
}

.betternotes-attachments-header {
  display: flex;
  align-items: center;
  gap: var(--size-2-2);
  padding: var(--size-2-2) var(--size-4-2);
  cursor: pointer;
  color: var(--text-muted);
  font-size: var(--font-ui-small);
  user-select: none;
}

.betternotes-attachments-chevron {
  margin-left: auto;
  display: inline-flex;
  transition: transform 120ms ease-in-out;
}

.betternotes-attachments.is-collapsed .betternotes-attachments-chevron {
  transform: rotate(-90deg);
}

.betternotes-attachments-grid {
  display: flex;
  flex-wrap: wrap;
  gap: var(--size-4-2);
  padding: 0 var(--size-4-2) var(--size-4-2);
}

.betternotes-attachments.is-collapsed .betternotes-attachments-grid {
  display: none;
}

.betternotes-attachment {
  width: 96px;
  cursor: pointer;
  text-align: center;
}

.betternotes-attachment img {
  width: 96px;
  height: 72px;
  object-fit: cover;
  border-radius: var(--radius-s);
  border: 1px solid var(--background-modifier-border);
}

.betternotes-attachment-iconbox {
  width: 96px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--background-secondary);
  border-radius: var(--radius-s);
  border: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
}

.betternotes-attachment-name {
  font-size: var(--font-ui-smaller);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.betternotes-attachment:hover .betternotes-attachment-name {
  color: var(--text-normal);
}
```

- [ ] **Step 3: Build + tests**

Run: `npm run build && npx vitest run`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: attachments bar with thumbnails, open and hover preview"
```

---

### Task 6: Test vault + README + manual checklist

**Files:**
- Create: `test-vault/.obsidian/community-plugins.json`, `test-vault/.obsidian/app.json`, test content files, `README.md`, `docs/manual-test-checklist.md`
- Note: add a `deploy:test` npm script that copies `manifest.json`, `main.js`, `styles.css` into `test-vault/.obsidian/plugins/betternotes/`.

**Interfaces:**
- Consumes: built `main.js` from earlier tasks.
- Produces: an openable vault at `test-vault/` with the plugin enabled and sample content: a betternote `Projects/Projects.md` with `mockup.png` (any small generated PNG) and nested `Projects/Website Redesign/Website Redesign.md`, plus a plain note `Daily Log.md` and plain folder `Old Stuff/`.

- [ ] **Step 1: Create test vault structure**

```
test-vault/
├── .obsidian/
│   ├── app.json                  → {}
│   ├── community-plugins.json    → ["betternotes"]
│   └── plugins/betternotes/      → (filled by deploy:test)
├── Projects/
│   ├── Projects.md               → "# Projects\n\nPlanning notes."
│   ├── mockup.png                → tiny valid PNG (generate via PowerShell System.Drawing or copy any small png)
│   └── Website Redesign/
│       └── Website Redesign.md   → "# Website Redesign"
├── Daily Log.md                  → "# Daily Log"
└── Old Stuff/
    └── archive.md                → "# Archive"
```

Add to `package.json` scripts:
```json
"deploy:test": "node -e \"const fs=require('fs');fs.mkdirSync('test-vault/.obsidian/plugins/betternotes',{recursive:true});for(const f of['main.js','manifest.json','styles.css'])fs.copyFileSync(f,'test-vault/.obsidian/plugins/betternotes/'+f);\""
```

- [ ] **Step 2: Write `README.md`**

Cover: what a BetterNote is (folder + same-named note), the explorer behavior, Ctrl+N takeover and how to turn it off, attachments-in-folder + bar, convert/flatten/nesting context menus, settings table from the spec, build instructions (`npm install && npm run build`), manual install path.

- [ ] **Step 3: Write `docs/manual-test-checklist.md`**

```markdown
# Manual test checklist (run in test-vault, then spot-check in SyncedMain)

- [ ] Explorer: `Projects` shows note icon, no separate `Projects.md` row
- [ ] Click `Projects` name → note opens; chevron → children expand/collapse
- [ ] `Website Redesign` nested betternote renders and opens the same way
- [ ] Betternote with no extra children shows no chevron
- [ ] Command "Toggle BetterNote children visibility" hides/shows all children + chevrons
- [ ] Ctrl+N creates `Untitled/Untitled.md`, opens it, title focused; typing a name renames folder too
- [ ] Rename note via F2/inline title → folder follows; rename folder in explorer → note follows
- [ ] Drag betternote folder into another betternote → nests, pairing intact
- [ ] Paste image into a betternote → lands in its folder root; attachments bar appears with thumbnail
- [ ] Click attachment → opens in new tab; hover → preview popup (for previewable types)
- [ ] Collapse/expand attachments bar; state persists across notes
- [ ] Right-click plain note → Convert to BetterNote works (incl. merge-into-existing-folder case)
- [ ] Right-click betternote → Flatten works; empty folder removed, links intact
- [ ] Right-click plain folder → Turn into BetterNote creates inner note
- [ ] Disable plugin → explorer back to stock (folder rows, note visible, no bar), Ctrl+N restored
```

- [ ] **Step 4: Build, deploy to test vault, run checklist manually in Obsidian**

Run: `npm run build && npm run deploy:test`
Then open `test-vault` in Obsidian and walk the checklist. Fix anything broken before proceeding.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: test vault, README, manual test checklist"
```

---

### Task 7: Backup SyncedMain vault

**Files:**
- Create (outside repo): `C:\Users\rober\Documents\SyncedMain-backup-<yyyyMMdd-HHmm>.zip`

**Interfaces:**
- Produces: verified zip containing the full vault including `.obsidian/plugins/folder-notes/` (plugin + its `data.json` = "current state of the folder note plugin").

- [ ] **Step 1: Create the backup zip (bsdtar includes hidden dirs; Compress-Archive does not reliably)**

```powershell
$ts = Get-Date -Format "yyyyMMdd-HHmm"
tar -a -c -f "C:\Users\rober\Documents\SyncedMain-backup-$ts.zip" -C "C:\Users\rober\Documents" SyncedMain
```

- [ ] **Step 2: Verify the backup**

```powershell
tar -t -f "C:\Users\rober\Documents\SyncedMain-backup-<ts>.zip" | Select-String "folder-notes/data.json"
```
Expected: the folder-notes data.json (and plugin files) listed. Also compare file counts roughly against the live vault (522 files at plan time).

---

### Task 8: Deploy to SyncedMain, replacing folder-notes

**Files:**
- Create: `C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\betternotes\{main.js,manifest.json,styles.css}`
- Modify: `C:\Users\rober\Documents\SyncedMain\.obsidian\community-plugins.json` (remove `"folder-notes"`, add `"betternotes"`)

**Interfaces:**
- Consumes: verified backup from Task 7 (hard prerequisite), built artifacts from Task 6.

- [ ] **Step 1: Production build**

Run: `npm run build`
Expected: fresh `main.js`.

- [ ] **Step 2: Copy plugin into vault**

```powershell
New-Item -ItemType Directory -Force "C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\betternotes"
Copy-Item main.js,manifest.json,styles.css "C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\betternotes\"
```

- [ ] **Step 3: Swap enabled plugins**

Edit `community-plugins.json`: replace `"folder-notes"` with `"betternotes"` in the JSON array (keep every other entry untouched). The folder-notes plugin FILES stay on disk (and in the backup) — only disabled — so reverting is trivial.

- [ ] **Step 4: Handle running Obsidian**

```powershell
Get-Process obsidian -ErrorAction SilentlyContinue
```
If running: notify the user to restart Obsidian (Ctrl+R or quit/reopen) so the swap takes effect, and warn them not to toggle plugins in settings before restarting (that would rewrite community-plugins.json from memory).

- [ ] **Step 5: Final commit + report**

```bash
git add -A && git commit -m "chore: deployment notes"
```
Report to user: backup path, what was deployed, restart instruction, how to revert (restore zip or re-enable folder-notes / disable betternotes in settings).
