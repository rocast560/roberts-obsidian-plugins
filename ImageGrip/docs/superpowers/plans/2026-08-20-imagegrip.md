# ImageGrip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Obsidian plugin that adds corner-handle drag-resize (persisted as `|width` in the link) and Ctrl+C image-to-clipboard copy for images in Live Preview.

**Architecture:** DOM overlay via event delegation — a plugin-level click listener selects images and renders handle overlays; on drag release, `EditorView.posAtDOM` maps the image back to its markdown embed, which pure tested functions rewrite with the new width. No CodeMirror decorations, no patching of Obsidian internals.

**Tech Stack:** TypeScript, esbuild (CJS bundle to `main.js`), vitest for pure-function tests, Obsidian plugin API.

**Spec:** `docs/superpowers/specs/2026-08-20-imagegrip-design.md`

## Global Constraints

- Plugin id `image-grip`, name `ImageGrip`, repo folder `C:\Users\rober\Desktop\ObsidianCustomPlugins\ImageGrip`.
- Live Preview only. Reading mode gets no handles (it just renders the saved `|width`).
- Persisting a size means editing the markdown link; never store sizes anywhere else.
- Minimum image width: 40px. Corner drag is proportional (width-only; renderer keeps aspect).
- All shell commands in this plan are PowerShell 5.1 — no `&&` chaining; use `;`.
- Vault deploy target: `C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\image-grip`. Writes there work **only via robocopy** (Controlled Folder Access blocks Copy-Item). robocopy exit code 1 = success. Never use `/MIR` (it would delete `data.json`).
- Obsidian closes to tray; a code reload requires `Stop-Process -Name Obsidian -Force` then relaunching the exe. Bump `manifest.json` version on every deploy to verify the new code loaded.
- The markdown edit on resize is a single `replaceRange`; on any failure the DOM is reverted and a Notice shown — never leave markdown half-edited.

---

### Task 1: Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json`, `.gitignore`, `styles.css`, `src/main.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a building plugin skeleton; `npm run build` emits `main.js`; `npm test` runs vitest.

- [ ] **Step 1: Write config files**

`package.json`:

```json
{
  "name": "image-grip",
  "version": "0.1.0",
  "description": "Drag corner handles to resize images in Live Preview; Ctrl+C copies the selected image",
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
  "id": "image-grip",
  "name": "ImageGrip",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "Drag corner handles to resize images in Live Preview; Ctrl+C copies the selected image.",
  "author": "rober",
  "isDesktopOnly": false
}
```

`.gitignore`:

```
node_modules/
main.js
```

`styles.css`: create empty (filled in Task 3).

`src/main.ts` (placeholder so the build passes; replaced in Task 5):

```ts
import { Plugin } from "obsidian";

export default class ImageGripPlugin extends Plugin {
  onload(): void {}
}
```

- [ ] **Step 2: Install and build**

Run: `npm install; npm run build`
Expected: install succeeds; esbuild prints `main.js` output with no errors; `main.js` exists.

- [ ] **Step 3: Commit**

```powershell
git add package.json package-lock.json tsconfig.json esbuild.config.mjs manifest.json .gitignore styles.css src/main.ts
git commit -m "chore: scaffold ImageGrip plugin"
```

---

### Task 2: Link rewriting (pure, TDD)

**Files:**
- Create: `src/linkRewrite.ts`
- Test: `tests/linkRewrite.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 5):
  - `interface EmbedSpan { start: number; end: number; text: string }`
  - `interface WidthEdit { startCh: number; endCh: number; newText: string }`
  - `findEmbedAt(lineText: string, ch: number): EmbedSpan | null`
  - `rewriteWidth(embedText: string, width: number): string`
  - `applyWidth(lineText: string, ch: number, width: number): WidthEdit | null`

- [ ] **Step 1: Write the failing tests**

`tests/linkRewrite.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyWidth, findEmbedAt, rewriteWidth } from "../src/linkRewrite";

describe("rewriteWidth — wiki embeds", () => {
  it("appends width when there is none", () => {
    expect(rewriteWidth("![[a.png]]", 420)).toBe("![[a.png|420]]");
  });
  it("replaces an existing width", () => {
    expect(rewriteWidth("![[a.png|300]]", 420)).toBe("![[a.png|420]]");
  });
  it("collapses WxH to width-only", () => {
    expect(rewriteWidth("![[a.png|300x200]]", 420)).toBe("![[a.png|420]]");
  });
  it("keeps a caption and appends width", () => {
    expect(rewriteWidth("![[a.png|caption]]", 420)).toBe("![[a.png|caption|420]]");
  });
  it("keeps a caption and replaces width", () => {
    expect(rewriteWidth("![[a.png|caption|300]]", 420)).toBe("![[a.png|caption|420]]");
  });
  it("never treats the target itself as a size", () => {
    expect(rewriteWidth("![[300]]", 420)).toBe("![[300|420]]");
  });
});

describe("rewriteWidth — markdown embeds", () => {
  it("appends width to alt text", () => {
    expect(rewriteWidth("![alt](a.png)", 420)).toBe("![alt|420](a.png)");
  });
  it("uses width as alt when alt is empty", () => {
    expect(rewriteWidth("![](a.png)", 420)).toBe("![420](a.png)");
  });
  it("replaces an existing width in alt", () => {
    expect(rewriteWidth("![alt|300](a.png)", 420)).toBe("![alt|420](a.png)");
  });
  it("replaces a bare numeric alt (it is a size)", () => {
    expect(rewriteWidth("![300](a.png)", 420)).toBe("![420](a.png)");
  });
  it("collapses WxH in alt to width-only", () => {
    expect(rewriteWidth("![alt|300x200](a.png)", 420)).toBe("![alt|420](a.png)");
  });
  it("works with remote URLs", () => {
    expect(rewriteWidth("![pic](https://example.com/a.png)", 420)).toBe(
      "![pic|420](https://example.com/a.png)"
    );
  });
});

describe("findEmbedAt", () => {
  it("finds a wiki embed containing ch", () => {
    expect(findEmbedAt("foo ![[a.png]] bar", 8)).toEqual({
      start: 4,
      end: 14,
      text: "![[a.png]]",
    });
  });
  it("is inclusive at both ends of the span", () => {
    expect(findEmbedAt("foo ![[a.png]] bar", 4)).not.toBeNull();
    expect(findEmbedAt("foo ![[a.png]] bar", 14)).not.toBeNull();
  });
  it("returns null outside any embed", () => {
    expect(findEmbedAt("foo ![[a.png]] bar", 2)).toBeNull();
    expect(findEmbedAt("foo ![[a.png]] bar", 16)).toBeNull();
  });
  it("picks the right embed among several", () => {
    const line = "![[a.png]] and ![[b.png]]";
    expect(findEmbedAt(line, 20)?.text).toBe("![[b.png]]");
  });
  it("finds a markdown embed", () => {
    expect(findEmbedAt("x ![alt](a.png) y", 6)?.text).toBe("![alt](a.png)");
  });
  it("does not double-match a wiki embed as markdown", () => {
    const line = "![[a.png]] ![b](b.png)";
    expect(findEmbedAt(line, 3)?.text).toBe("![[a.png]]");
    expect(findEmbedAt(line, 15)?.text).toBe("![b](b.png)");
  });
  it("returns null on a line with no embeds", () => {
    expect(findEmbedAt("no images! just text", 5)).toBeNull();
  });
});

describe("applyWidth", () => {
  it("produces the edit range and new text", () => {
    expect(applyWidth("foo ![[a.png]] bar", 8, 420)).toEqual({
      startCh: 4,
      endCh: 14,
      newText: "![[a.png|420]]",
    });
  });
  it("returns null when ch is not in an embed", () => {
    expect(applyWidth("foo ![[a.png]] bar", 1, 420)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/linkRewrite.test.ts`
Expected: FAIL — cannot resolve `../src/linkRewrite`.

- [ ] **Step 3: Implement**

`src/linkRewrite.ts`:

```ts
export interface EmbedSpan {
  start: number;
  end: number;
  text: string;
}

export interface WidthEdit {
  startCh: number;
  endCh: number;
  newText: string;
}

const WIKI_EMBED = /!\[\[[^\]]+\]\]/g;
const MD_EMBED = /!\[[^\]]*\]\([^)]+\)/g;
const SIZE_SEGMENT = /^\d+(x\d+)?$/;

function findEmbeds(lineText: string): EmbedSpan[] {
  const spans: EmbedSpan[] = [];
  for (const re of [WIKI_EMBED, MD_EMBED]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lineText)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      // wiki matches are collected first; skip a markdown match overlapping one
      if (!spans.some((s) => start < s.end && end > s.start)) {
        spans.push({ start, end, text: m[0] });
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

export function findEmbedAt(lineText: string, ch: number): EmbedSpan | null {
  return findEmbeds(lineText).find((s) => ch >= s.start && ch <= s.end) ?? null;
}

function applySizeToSegments(
  segments: string[],
  width: number,
  firstIsTarget: boolean
): string[] {
  const lastIndex = segments.length - 1;
  const minSizeIndex = firstIsTarget ? 1 : 0;
  if (lastIndex >= minSizeIndex && SIZE_SEGMENT.test(segments[lastIndex])) {
    return [...segments.slice(0, -1), String(width)];
  }
  return [...segments, String(width)];
}

export function rewriteWidth(embedText: string, width: number): string {
  const wiki = embedText.match(/^!\[\[([^\]]+)\]\]$/);
  if (wiki) {
    const segments = applySizeToSegments(wiki[1].split("|"), width, true);
    return `![[${segments.join("|")}]]`;
  }
  const md = embedText.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (md) {
    const altSegments = md[1] === "" ? [] : md[1].split("|");
    const segments = applySizeToSegments(altSegments, width, false);
    return `![${segments.join("|")}](${md[2]})`;
  }
  return embedText;
}

export function applyWidth(
  lineText: string,
  ch: number,
  width: number
): WidthEdit | null {
  const embed = findEmbedAt(lineText, ch);
  if (!embed) return null;
  return {
    startCh: embed.start,
    endCh: embed.end,
    newText: rewriteWidth(embed.text, width),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/linkRewrite.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```powershell
git add src/linkRewrite.ts tests/linkRewrite.test.ts
git commit -m "feat: embed parsing and width rewriting"
```

---

### Task 3: Selection + drag (SelectionController) and styles

**Files:**
- Create: `src/resize.ts`
- Modify: `styles.css`
- Test: `tests/resize.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (used by Task 5):
  - `type Corner = "nw" | "ne" | "sw" | "se"`
  - `computeDragWidth(startWidth: number, dx: number, corner: Corner, minWidth?: number): number`
  - `type ResizeEndCallback = (img: HTMLImageElement, width: number, prevWidth: number | null) => void`
  - `class SelectionController { constructor(onResizeEnd: ResizeEndCallback); get selectedImage(): HTMLImageElement | null; select(img: HTMLImageElement): void; deselect(): void; revert(img: HTMLImageElement, prevWidth: number | null): void; destroy(): void }`

DOM/drag behavior is verified manually in Task 6 (vitest here runs in node, no DOM); only the pure drag math gets unit tests.

- [ ] **Step 1: Write the failing tests for the drag math**

`tests/resize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeDragWidth } from "../src/resize";

describe("computeDragWidth", () => {
  it("east corners grow with positive dx", () => {
    expect(computeDragWidth(200, 50, "se")).toBe(250);
    expect(computeDragWidth(200, 50, "ne")).toBe(250);
  });
  it("west corners grow with negative dx", () => {
    expect(computeDragWidth(200, -50, "sw")).toBe(250);
    expect(computeDragWidth(200, -50, "nw")).toBe(250);
  });
  it("shrinks in the opposite direction", () => {
    expect(computeDragWidth(200, -50, "se")).toBe(150);
  });
  it("clamps to the minimum width", () => {
    expect(computeDragWidth(200, -500, "se")).toBe(40);
  });
  it("rounds to whole pixels", () => {
    expect(computeDragWidth(200.4, 0, "se")).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/resize.test.ts`
Expected: FAIL — cannot resolve `../src/resize`.

- [ ] **Step 3: Implement `src/resize.ts`**

```ts
export type Corner = "nw" | "ne" | "sw" | "se";

export function computeDragWidth(
  startWidth: number,
  dx: number,
  corner: Corner,
  minWidth = 40
): number {
  const delta = corner === "ne" || corner === "se" ? dx : -dx;
  return Math.max(minWidth, Math.round(startWidth + delta));
}

export type ResizeEndCallback = (
  img: HTMLImageElement,
  width: number,
  prevWidth: number | null
) => void;

export class SelectionController {
  private img: HTMLImageElement | null = null;
  private container: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private dragging = false;

  constructor(private onResizeEnd: ResizeEndCallback) {}

  get selectedImage(): HTMLImageElement | null {
    return this.img;
  }

  select(img: HTMLImageElement): void {
    if (this.img === img) return;
    this.deselect();
    const container =
      (img.closest(".image-embed") as HTMLElement | null) ?? img.parentElement;
    if (!container) return;
    this.img = img;
    this.container = container;
    container.classList.add("imagegrip-selected");
    const overlay = document.createElement("div");
    overlay.className = "imagegrip-overlay";
    for (const corner of ["nw", "ne", "sw", "se"] as Corner[]) {
      const handle = document.createElement("div");
      handle.className = "imagegrip-handle";
      handle.dataset.corner = corner;
      handle.addEventListener("pointerdown", (evt) => this.startDrag(evt, corner));
      overlay.appendChild(handle);
    }
    container.appendChild(overlay);
    this.overlay = overlay;
  }

  deselect(): void {
    this.dragging = false;
    this.overlay?.remove();
    this.container?.classList.remove("imagegrip-selected");
    this.img = null;
    this.container = null;
    this.overlay = null;
  }

  revert(img: HTMLImageElement, prevWidth: number | null): void {
    if (prevWidth !== null) {
      img.style.width = `${prevWidth}px`;
    } else {
      img.style.removeProperty("width");
      img.style.removeProperty("height");
    }
  }

  destroy(): void {
    this.deselect();
  }

  private startDrag(evt: PointerEvent, corner: Corner): void {
    const img = this.img;
    if (!img) return;
    evt.preventDefault();
    evt.stopPropagation();
    this.dragging = true;
    const handle = evt.currentTarget as HTMLElement;
    handle.setPointerCapture(evt.pointerId);
    const startX = evt.clientX;
    const startWidth = img.getBoundingClientRect().width;
    const prevStyleWidth = img.style.width
      ? Math.round(parseFloat(img.style.width))
      : null;
    let lastWidth = Math.round(startWidth);

    const cleanup = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
    };
    const onMove = (moveEvt: PointerEvent) => {
      lastWidth = computeDragWidth(startWidth, moveEvt.clientX - startX, corner);
      img.style.width = `${lastWidth}px`;
      img.style.height = "auto";
    };
    const onUp = () => {
      cleanup();
      if (!this.dragging) return;
      this.dragging = false;
      this.onResizeEnd(img, lastWidth, prevStyleWidth);
    };
    const onCancel = () => {
      cleanup();
      this.dragging = false;
      this.revert(img, prevStyleWidth);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
  }
}
```

- [ ] **Step 4: Write `styles.css`**

Replace the empty file with:

```css
.imagegrip-selected {
  position: relative;
  display: inline-block;
}

.imagegrip-selected img {
  outline: 2px solid var(--interactive-accent);
  outline-offset: -1px;
}

.imagegrip-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.imagegrip-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  background: var(--interactive-accent);
  border: 1px solid var(--background-primary);
  border-radius: 2px;
  pointer-events: auto;
  touch-action: none;
}

.imagegrip-handle[data-corner="nw"] { top: -5px; left: -5px; cursor: nwse-resize; }
.imagegrip-handle[data-corner="ne"] { top: -5px; right: -5px; cursor: nesw-resize; }
.imagegrip-handle[data-corner="sw"] { bottom: -5px; left: -5px; cursor: nesw-resize; }
.imagegrip-handle[data-corner="se"] { bottom: -5px; right: -5px; cursor: nwse-resize; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/resize.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/resize.ts tests/resize.test.ts styles.css
git commit -m "feat: selection controller with corner-handle drag"
```

---

### Task 4: Clipboard copy

**Files:**
- Create: `src/copy.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (used by Task 5): `copyImage(img: HTMLImageElement): Promise<void>` — resolves on success, rejects with an `Error` on tainted canvas / encode / clipboard failure. Caller handles Notices.

No unit test — the function is a thin composition of canvas and clipboard APIs unavailable in node vitest; verified manually in Task 6.

- [ ] **Step 1: Implement `src/copy.ts`**

```ts
export async function copyImage(img: HTMLImageElement): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png")
  );
  if (!blob) throw new Error("could not encode image");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
```

(`canvas.toBlob` on a CORS-tainted canvas throws `SecurityError`; because the function is async, that surfaces as a rejection the caller catches.)

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: build succeeds (copy.ts is not yet imported; esbuild only bundles main.ts, so also run `npx tsc --noEmit` — expected: no errors).

- [ ] **Step 3: Commit**

```powershell
git add src/copy.ts
git commit -m "feat: image-to-clipboard copy"
```

---

### Task 5: Wire everything in main.ts

**Files:**
- Modify: `src/main.ts` (replace the Task 1 placeholder entirely)

**Interfaces:**
- Consumes: `SelectionController`, `ResizeEndCallback`, `applyWidth`, `copyImage` — exact signatures from Tasks 2–4.
- Produces: the complete plugin.

- [ ] **Step 1: Replace `src/main.ts`**

```ts
import { MarkdownView, Notice, Plugin } from "obsidian";
import { SelectionController } from "./resize";
import { applyWidth } from "./linkRewrite";
import { copyImage } from "./copy";

/** The undocumented CodeMirror 6 EditorView on Obsidian's Editor. */
interface CmView {
  posAtDOM(node: Node): number;
}

export default class ImageGripPlugin extends Plugin {
  private selection!: SelectionController;

  onload(): void {
    this.selection = new SelectionController((img, width, prevWidth) =>
      this.commitResize(img, width, prevWidth)
    );

    this.registerDomEvent(document, "click", (evt) => this.handleClick(evt), true);
    this.registerDomEvent(
      document,
      "keydown",
      (evt) => {
        if (evt.key === "Escape" && this.selection.selectedImage) {
          this.selection.deselect();
        }
      },
      true
    );
    this.registerDomEvent(document, "copy", (evt) => this.handleCopy(evt), true);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.selection.deselect())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.selection.deselect())
    );
  }

  onunload(): void {
    this.selection.destroy();
  }

  private handleClick(evt: MouseEvent): void {
    const target = evt.target as HTMLElement;
    if (target.closest(".imagegrip-overlay")) return;
    if (
      target instanceof HTMLImageElement &&
      target.closest(".markdown-source-view.is-live-preview .cm-content")
    ) {
      evt.preventDefault();
      evt.stopPropagation();
      this.selection.select(target);
      return;
    }
    this.selection.deselect();
  }

  private handleCopy(evt: ClipboardEvent): void {
    const img = this.selection.selectedImage;
    if (!img) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.editor.somethingSelected()) return;
    evt.preventDefault();
    evt.stopPropagation();
    copyImage(img).then(
      () => new Notice("Image copied"),
      (err) =>
        new Notice(
          `ImageGrip: could not copy image (${err instanceof Error ? err.message : err})`
        )
    );
  }

  private commitResize(
    img: HTMLImageElement,
    width: number,
    prevWidth: number | null
  ): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor;
    const cm = (editor as unknown as { cm?: CmView } | undefined)?.cm;
    if (!view || !editor || !cm) {
      this.failResize(img, prevWidth, "no active editor");
      return;
    }

    let offset: number;
    try {
      offset = cm.posAtDOM(img);
    } catch {
      this.failResize(img, prevWidth, "could not locate the image in the note");
      return;
    }

    const pos = editor.offsetToPos(offset);
    const edit = applyWidth(editor.getLine(pos.line), pos.ch, width);
    if (!edit) {
      this.failResize(img, prevWidth, "could not find the image link");
      return;
    }

    const src = img.src;
    editor.replaceRange(
      edit.newText,
      { line: pos.line, ch: edit.startCh },
      { line: pos.line, ch: edit.endCh }
    );
    this.selection.deselect();
    // Live Preview re-renders the embed; re-select the fresh img element.
    window.setTimeout(() => {
      const match = Array.from(view.contentEl.querySelectorAll("img")).find(
        (el) => el.src === src
      );
      if (match) this.selection.select(match);
    }, 100);
  }

  private failResize(
    img: HTMLImageElement,
    prevWidth: number | null,
    reason: string
  ): void {
    this.selection.revert(img, prevWidth);
    this.selection.deselect();
    new Notice(`ImageGrip: resize not saved — ${reason}`);
  }
}
```

- [ ] **Step 2: Typecheck, test, build**

Run: `npx tsc --noEmit; npm test; npm run build`
Expected: no type errors; all vitest suites pass; `main.js` builds.

- [ ] **Step 3: Commit**

```powershell
git add src/main.ts
git commit -m "feat: wire selection, resize persistence, and copy into the plugin"
```

---

### Task 6: Deploy, manual verification, README

**Files:**
- Create: `README.md`
- Modify: `manifest.json`, `package.json` (version bump only if re-deploying after fixes)

**Interfaces:**
- Consumes: built `main.js`, `manifest.json`, `styles.css`.
- Produces: plugin installed and verified in the SyncedMain vault.

- [ ] **Step 1: Write `README.md`**

```markdown
# ImageGrip

Obsidian plugin for the SyncedMain vault. In **Live Preview**:

- **Click** an image to select it (accent outline + corner handles).
- **Drag a corner handle** to resize proportionally (min 40px). On release the
  width is written into the link — `![[photo.png|420]]` or `![alt|420](photo.png)` —
  so the size persists and syncs.
- **Ctrl+C** with an image selected copies the actual PNG to the system clipboard.
  (If the editor has a text selection, normal text copy wins.)
- **Escape** or clicking elsewhere deselects.

Reading mode just renders the saved size; no handles there.

## Build & deploy

    npm install
    npm run build
    robocopy . "C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\image-grip" main.js manifest.json styles.css

robocopy exit code 1 means success. Never use /MIR. Bump the version in
manifest.json each deploy, then fully restart Obsidian (it hides in the tray):

    Stop-Process -Name Obsidian -Force
    Start-Process "$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe"

## Known limits

- Live Preview only (by design).
- Markdown-embed paths containing `)` and wiki targets containing `]` are not parsed.
- Remote images whose host blocks CORS can't be copied (tainted canvas) — you get
  an explanatory notice instead.
```

- [ ] **Step 2: Deploy to the vault**

```powershell
robocopy . "C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\image-grip" main.js manifest.json styles.css
```

Expected: exit code 1 (files copied). Then enable the plugin: check whether `image-grip` is listed in `C:\Users\rober\Documents\SyncedMain\.obsidian\community-plugins.json`; if not, that file must be updated to include `"image-grip"` (robocopy a locally-edited copy of the whole file is not possible for a single file — instead ask the user to enable "ImageGrip" in Obsidian's Community plugins settings, which is one toggle).

- [ ] **Step 3: Restart Obsidian**

```powershell
Stop-Process -Name Obsidian -Force
Start-Process "$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe"
```

Expected: Obsidian relaunches; ImageGrip 0.1.0 shows in Settings → Community plugins.

- [ ] **Step 4: Manual verification checklist (user drives, or via screenshots)**

In a test note containing:

```markdown
![[some-local-image.png]]
![alt](some-local-image.png)
![remote](https://example.com/some-image.png)
```

Verify:
1. Click each image in Live Preview → outline + 4 corner handles appear.
2. Drag SE handle right → image grows live; release → link gains `|<width>`; aspect preserved.
3. Drag NW handle → same behavior mirrored; width can't go below 40px.
4. Resize again → existing width replaced, not duplicated.
5. `![](x.png)` (empty alt) resize → produces `![420](x.png)` and Obsidian renders it at 420px. (If Obsidian does not treat a bare numeric alt as a size, change `applySizeToSegments` call for markdown embeds to always pipe-prefix: expected fallback `![|420](x.png)`.)
6. Ctrl+C with local image selected → "Image copied" notice; paste into Paint/Discord → image appears.
7. Ctrl+C with text selected in editor and an image also selected → text copies normally.
8. Remote CORS-blocked image + Ctrl+C → explanatory notice, no crash.
9. Escape and click-elsewhere deselect; switching notes deselects.
10. Reading mode: resized images render at saved width, no handles.

- [ ] **Step 5: Commit and final version**

```powershell
git add README.md
git commit -m "docs: README with usage and deploy instructions"
```

If fixes were needed during verification: fix, re-run `npm test; npm run build`, bump the patch version in `manifest.json` + `package.json`, redeploy (Steps 2–3), re-verify the affected item, and commit.
