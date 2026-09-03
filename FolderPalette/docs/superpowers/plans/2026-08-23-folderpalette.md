# FolderPalette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Obsidian plugin that colors the vault's top-level folders in the file explorer from preset palettes (≥10 colors each, the existing Muted Rainbow first), chosen per folder from a settings UI.

**Architecture:** Pure modules (`palettes`, `hex`, `css`, `assign`, `settings`) generate a stylesheet string from saved settings; `main.ts` injects it into one `<style>` element and re-generates on every change. UI lives in `settingsTab.ts` (per-folder swatch rows), `colorModal.ts` (folder context menu), and `paletteModal.ts` (command). The generated CSS uses the same `:has()` selector as the user's `bruh.css` snippet, prefixed with `body` to win ties.

**Tech Stack:** TypeScript 5, esbuild (CJS bundle → `main.js`), vitest (node, pure modules only), Obsidian API ^1.5.7.

**Spec:** `docs/superpowers/specs/2026-08-23-folderpalette-design.md`

## Global Constraints

- Plugin id `folder-palette`, name `FolderPalette`, `minAppVersion` `1.4.0`, `isDesktopOnly: false`.
- Only **top-level** folders are colored; folder identity is its path (== name at top level).
- Every palette has **≥ 10** colors, all `#rrggbb`; palette ids unique; `muted-rainbow` is first and its first 9 colors are exactly `#E5877E #EAA87B #E1CF80 #B1E291 #90C3E2 #B2A7E2 #D8B2E2 #E2B2D1 #90DDCB` in that order.
- Generated selector shape (verbatim): `body .nav-files-container > div > .nav-folder:has(> .nav-folder-title[data-path="P"])`.
- Settings file shape: `{ paletteId: string; folderColors: Record<string,string>; colorFiles: boolean }`, defaults `"muted-rainbow"`, `{}`, `true`.
- `bruh.css` is never modified by the plugin or by this plan.
- Commits: no `Co-Authored-By` trailer (user preference).
- Deploy = robocopy only (Controlled Folder Access blocks `cp`); never `/MIR`.

---

### Task 1: Scaffold the plugin project

**Files:**
- Create: `package.json`, `manifest.json`, `tsconfig.json`, `esbuild.config.mjs`, `src/main.ts` (stub), `styles.css` (empty)
- Already present: `.gitignore` (`node_modules/`, `main.js`), `docs/superpowers/specs/…`

**Interfaces:**
- Produces: a project where `npm test`, `npm run build` and `npx tsc --noEmit` all run.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "folder-palette",
  "version": "0.1.0",
  "description": "Color top-level folders in the file explorer from preset palettes",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "node esbuild.config.mjs production",
    "typecheck": "tsc --noEmit",
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

- [ ] **Step 2: Write manifest.json**

```json
{
  "id": "folder-palette",
  "name": "FolderPalette",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "Color top-level folders in the file explorer from preset palettes.",
  "author": "rober",
  "isDesktopOnly": false
}
```

- [ ] **Step 3: Write tsconfig.json**

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
    "importHelpers": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 4: Write esbuild.config.mjs**

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

- [ ] **Step 5: Write the stub `src/main.ts` and empty `styles.css`**

```ts
import { Plugin } from "obsidian";

export default class FolderPalettePlugin extends Plugin {
  onload(): void {}
  onunload(): void {}
}
```

`styles.css`: create the file empty (it is filled in Task 6).

- [ ] **Step 6: Install and verify the toolchain**

Run: `npm install` then `npm run build` then `npx tsc --noEmit` then `npx vitest run`
Expected: build prints `main.js` size; tsc prints nothing; vitest reports "No test files found" (exit code 1 is fine at this point).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json manifest.json tsconfig.json esbuild.config.mjs src/main.ts styles.css
git commit -m "chore: scaffold FolderPalette plugin"
```

---

### Task 2: Hex validation + palette data

**Files:**
- Create: `src/hex.ts`, `src/palettes.ts`
- Test: `tests/palettes.test.ts`

**Interfaces:**
- Produces:
  - `HEX_RE: RegExp` and `isHex(value: unknown): value is string` (`/^#[0-9a-f]{6}$/i`).
  - `interface PaletteColor { name: string; hex: string }`
  - `interface Palette { id: string; name: string; source: string; colors: PaletteColor[] }`
  - `PALETTES: Palette[]` (11 palettes, `muted-rainbow` first)
  - `getPalette(id: string): Palette` — unknown id → `PALETTES[0]`.

- [ ] **Step 1: Write the failing tests**

`tests/palettes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HEX_RE, isHex } from "../src/hex";
import { PALETTES, getPalette } from "../src/palettes";

const SNIPPET_RAINBOW = [
  "#E5877E", "#EAA87B", "#E1CF80", "#B1E291", "#90C3E2",
  "#B2A7E2", "#D8B2E2", "#E2B2D1", "#90DDCB",
];

describe("isHex", () => {
  it("accepts #rrggbb in either case", () => {
    expect(isHex("#E5877E")).toBe(true);
    expect(isHex("#e5877e")).toBe(true);
  });
  it("rejects short, named, alpha and non-string values", () => {
    expect(isHex("#fff")).toBe(false);
    expect(isHex("red")).toBe(false);
    expect(isHex("#E5877E80")).toBe(false);
    expect(isHex("#12345g")).toBe(false);
    expect(isHex(42)).toBe(false);
    expect(isHex(null)).toBe(false);
  });
});

describe("PALETTES", () => {
  it("has unique ids", () => {
    const ids = PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("every palette has at least 10 colors", () => {
    for (const p of PALETTES) expect(p.colors.length, p.id).toBeGreaterThanOrEqual(10);
  });
  it("every color is a valid #rrggbb with a name", () => {
    for (const p of PALETTES) {
      for (const c of p.colors) {
        expect(c.hex, `${p.id}/${c.name}`).toMatch(HEX_RE);
        expect(c.name.length, `${p.id}/${c.hex}`).toBeGreaterThan(0);
      }
    }
  });
  it("has no duplicate colors inside a palette", () => {
    for (const p of PALETTES) {
      const hexes = p.colors.map((c) => c.hex.toLowerCase());
      expect(new Set(hexes).size, p.id).toBe(hexes.length);
    }
  });
  it("every palette has a name and a source", () => {
    for (const p of PALETTES) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.source.length).toBeGreaterThan(0);
    }
  });
  it("starts with Muted Rainbow whose first 9 colors match bruh.css in order", () => {
    expect(PALETTES[0].id).toBe("muted-rainbow");
    expect(PALETTES[0].colors.slice(0, 9).map((c) => c.hex)).toEqual(SNIPPET_RAINBOW);
  });
});

describe("getPalette", () => {
  it("returns the palette by id", () => {
    expect(getPalette("nord").id).toBe("nord");
  });
  it("falls back to the first palette for unknown ids", () => {
    expect(getPalette("nope")).toBe(PALETTES[0]);
    expect(getPalette("")).toBe(PALETTES[0]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/palettes.test.ts`
Expected: FAIL — cannot resolve `../src/hex` / `../src/palettes`.

- [ ] **Step 3: Write `src/hex.ts`**

```ts
/** Strict 6-digit hex color, e.g. "#E5877E". */
export const HEX_RE = /^#[0-9a-f]{6}$/i;

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}
```

- [ ] **Step 4: Write `src/palettes.ts`**

```ts
export interface PaletteColor {
  name: string;
  hex: string;
}

export interface Palette {
  id: string;
  name: string;
  /** Where the values came from; shown in the settings description. */
  source: string;
  colors: PaletteColor[];
}

const c = (name: string, hex: string): PaletteColor => ({ name, hex });

export const PALETTES: Palette[] = [
  {
    id: "muted-rainbow",
    name: "Muted Rainbow",
    source: "your bruh.css snippet, plus Soft Mint as the 10th color",
    colors: [
      c("Soft Red", "#E5877E"),
      c("Soft Orange", "#EAA87B"),
      c("Soft Yellow", "#E1CF80"),
      c("Soft Green", "#B1E291"),
      c("Soft Blue", "#90C3E2"),
      c("Soft Lavender", "#B2A7E2"),
      c("Soft Purple", "#D8B2E2"),
      c("Soft Pink", "#E2B2D1"),
      c("Soft Teal", "#90DDCB"),
      c("Soft Mint", "#9EDFA9"),
    ],
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    source: "catppuccin.com/palette (dark flavor accents)",
    colors: [
      c("Rosewater", "#f5e0dc"),
      c("Flamingo", "#f2cdcd"),
      c("Pink", "#f5c2e7"),
      c("Mauve", "#cba6f7"),
      c("Red", "#f38ba8"),
      c("Maroon", "#eba0ac"),
      c("Peach", "#fab387"),
      c("Yellow", "#f9e2af"),
      c("Green", "#a6e3a1"),
      c("Teal", "#94e2d5"),
      c("Sky", "#89dceb"),
      c("Sapphire", "#74c7ec"),
      c("Blue", "#89b4fa"),
      c("Lavender", "#b4befe"),
    ],
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    source: "catppuccin.com/palette (light flavor accents)",
    colors: [
      c("Rosewater", "#dc8a78"),
      c("Flamingo", "#dd7878"),
      c("Pink", "#ea76cb"),
      c("Mauve", "#8839ef"),
      c("Red", "#d20f39"),
      c("Maroon", "#e64553"),
      c("Peach", "#fe640b"),
      c("Yellow", "#df8e1d"),
      c("Green", "#40a02b"),
      c("Teal", "#179299"),
      c("Sky", "#04a5e5"),
      c("Sapphire", "#209fb5"),
      c("Blue", "#1e66f5"),
      c("Lavender", "#7287fd"),
    ],
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    source: "folke/tokyonight.nvim (night variant)",
    colors: [
      c("Red", "#f7768e"),
      c("Orange", "#ff9e64"),
      c("Yellow", "#e0af68"),
      c("Green", "#9ece6a"),
      c("Teal", "#73daca"),
      c("Cyan", "#7dcfff"),
      c("Aqua", "#2ac3de"),
      c("Blue", "#7aa2f7"),
      c("Magenta", "#bb9af7"),
      c("Purple", "#9d7cd8"),
    ],
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    source: "morhetz/gruvbox (bright + neutral accents)",
    colors: [
      c("Bright Red", "#fb4934"),
      c("Bright Orange", "#fe8019"),
      c("Bright Yellow", "#fabd2f"),
      c("Bright Green", "#b8bb26"),
      c("Bright Aqua", "#8ec07c"),
      c("Bright Blue", "#83a598"),
      c("Bright Purple", "#d3869b"),
      c("Neutral Red", "#cc241d"),
      c("Neutral Orange", "#d65d0e"),
      c("Neutral Yellow", "#d79921"),
      c("Neutral Green", "#98971a"),
      c("Neutral Aqua", "#689d6a"),
      c("Neutral Blue", "#458588"),
      c("Neutral Purple", "#b16286"),
    ],
  },
  {
    id: "nord",
    name: "Nord",
    source: "nordtheme.com (Aurora + Frost + Snow Storm nord4)",
    colors: [
      c("Aurora Red", "#bf616a"),
      c("Aurora Orange", "#d08770"),
      c("Aurora Yellow", "#ebcb8b"),
      c("Aurora Green", "#a3be8c"),
      c("Aurora Purple", "#b48ead"),
      c("Frost Teal", "#8fbcbb"),
      c("Frost Cyan", "#88c0d0"),
      c("Frost Blue", "#81a1c1"),
      c("Frost Deep Blue", "#5e81ac"),
      c("Snow Storm", "#d8dee9"),
    ],
  },
  {
    id: "tableau-10",
    name: "Tableau 10",
    source: "Tableau 10 default categorical palette",
    colors: [
      c("Blue", "#4E79A7"),
      c("Orange", "#F28E2B"),
      c("Red", "#E15759"),
      c("Teal", "#76B7B2"),
      c("Green", "#59A14F"),
      c("Yellow", "#EDC948"),
      c("Purple", "#B07AA1"),
      c("Pink", "#FF9DA7"),
      c("Brown", "#9C755F"),
      c("Gray", "#BAB0AC"),
    ],
  },
  {
    id: "tol-muted",
    name: "Paul Tol Muted (colorblind-safe)",
    source: "Paul Tol's qualitative 'muted' scheme, personal.sron.nl/~pault",
    colors: [
      c("Rose", "#CC6677"),
      c("Indigo", "#332288"),
      c("Sand", "#DDCC77"),
      c("Green", "#117733"),
      c("Cyan", "#88CCEE"),
      c("Wine", "#882255"),
      c("Teal", "#44AA99"),
      c("Olive", "#999933"),
      c("Purple", "#AA4499"),
      c("Pale Grey", "#DDDDDD"),
    ],
  },
  {
    id: "material-vivid",
    name: "Material Vivid",
    source: "Material Design 2014 color palette, 500 tones",
    colors: [
      c("Red", "#F44336"),
      c("Pink", "#E91E63"),
      c("Purple", "#9C27B0"),
      c("Deep Purple", "#673AB7"),
      c("Indigo", "#3F51B5"),
      c("Blue", "#2196F3"),
      c("Light Blue", "#03A9F4"),
      c("Cyan", "#00BCD4"),
      c("Teal", "#009688"),
      c("Green", "#4CAF50"),
      c("Light Green", "#8BC34A"),
      c("Lime", "#CDDC39"),
      c("Yellow", "#FFEB3B"),
      c("Amber", "#FFC107"),
      c("Orange", "#FF9800"),
      c("Deep Orange", "#FF5722"),
    ],
  },
  {
    id: "material-pastel",
    name: "Material Pastel",
    source: "Material Design 2014 color palette, 200 tones",
    colors: [
      c("Red", "#EF9A9A"),
      c("Pink", "#F48FB1"),
      c("Purple", "#CE93D8"),
      c("Deep Purple", "#B39DDB"),
      c("Indigo", "#9FA8DA"),
      c("Blue", "#90CAF9"),
      c("Light Blue", "#81D4FA"),
      c("Cyan", "#80DEEA"),
      c("Teal", "#80CBC4"),
      c("Green", "#A5D6A7"),
      c("Light Green", "#C5E1A5"),
      c("Lime", "#E6EE9C"),
      c("Yellow", "#FFF59D"),
      c("Amber", "#FFE082"),
      c("Orange", "#FFCC80"),
      c("Deep Orange", "#FFAB91"),
    ],
  },
  {
    id: "flat-ui",
    name: "Flat UI",
    source: "flatuicolors.com (v1 palette, saturated tones)",
    colors: [
      c("Turquoise", "#1ABC9C"),
      c("Emerald", "#2ECC71"),
      c("Peter River", "#3498DB"),
      c("Amethyst", "#9B59B6"),
      c("Sun Flower", "#F1C40F"),
      c("Carrot", "#E67E22"),
      c("Alizarin", "#E74C3C"),
      c("Green Sea", "#16A085"),
      c("Nephritis", "#27AE60"),
      c("Belize Hole", "#2980B9"),
      c("Wisteria", "#8E44AD"),
      c("Orange", "#F39C12"),
      c("Pumpkin", "#D35400"),
      c("Pomegranate", "#C0392B"),
    ],
  },
];

/** Look a palette up by id; unknown ids fall back to the first palette. */
export function getPalette(id: string): Palette {
  return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/palettes.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add src/hex.ts src/palettes.ts tests/palettes.test.ts
git commit -m "feat: palette data with Muted Rainbow and 10 researched presets"
```

---

### Task 3: CSS generation

**Files:**
- Create: `src/css.ts`
- Test: `tests/css.test.ts`

**Interfaces:**
- Consumes: `isHex` from `src/hex.ts`.
- Produces:
  - `interface FolderColorEntry { path: string; color: string }`
  - `interface CssOptions { colorFiles: boolean }`
  - `escapeAttr(value: string): string`
  - `folderSelector(path: string): string`
  - `buildCss(entries: FolderColorEntry[], opts: CssOptions): string`

- [ ] **Step 1: Write the failing tests**

`tests/css.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCss, escapeAttr, folderSelector } from "../src/css";

const SEL = (p: string) =>
  `body .nav-files-container > div > .nav-folder:has(> .nav-folder-title[data-path="${p}"])`;

describe("escapeAttr", () => {
  it("escapes backslashes and double quotes", () => {
    expect(escapeAttr('a"b')).toBe('a\\"b');
    expect(escapeAttr("a\\b")).toBe("a\\\\b");
    expect(escapeAttr('x\\"y')).toBe('x\\\\\\"y');
  });
  it("leaves ordinary names alone", () => {
    expect(escapeAttr("Software Engineering")).toBe("Software Engineering");
  });
});

describe("folderSelector", () => {
  it("matches the bruh.css selector shape with a body prefix", () => {
    expect(folderSelector("Archive")).toBe(SEL("Archive"));
  });
  it("escapes the path inside the attribute", () => {
    expect(folderSelector('We "love" CSS')).toBe(SEL('We \\"love\\" CSS'));
  });
});

describe("buildCss", () => {
  it("emits variable, title and file rules for one folder", () => {
    const css = buildCss([{ path: "Archive", color: "#E5877E" }], { colorFiles: true });
    expect(css.split("\n")).toEqual([
      `${SEL("Archive")} { --folder-color: #E5877E; }`,
      `${SEL("Archive")} > .nav-folder-title { color: var(--folder-color); }`,
      `${SEL("Archive")} .nav-file-title { color: var(--folder-color); }`,
    ]);
  });
  it("omits the file rule when colorFiles is off", () => {
    const css = buildCss([{ path: "Archive", color: "#E5877E" }], { colorFiles: false });
    expect(css.split("\n")).toEqual([
      `${SEL("Archive")} { --folder-color: #E5877E; }`,
      `${SEL("Archive")} > .nav-folder-title { color: var(--folder-color); }`,
    ]);
  });
  it("keeps entry order and handles many folders", () => {
    const css = buildCss(
      [
        { path: "B", color: "#000000" },
        { path: "A", color: "#ffffff" },
      ],
      { colorFiles: false }
    );
    expect(css.indexOf('data-path="B"')).toBeLessThan(css.indexOf('data-path="A"'));
    expect(css.split("\n")).toHaveLength(4);
  });
  it("skips entries whose color is not #rrggbb", () => {
    const css = buildCss(
      [
        { path: "Bad", color: "red" },
        { path: "Short", color: "#fff" },
        { path: "Inject", color: "#000000; } body { display:none" },
        { path: "Good", color: "#123456" },
      ],
      { colorFiles: true }
    );
    expect(css).not.toContain("Bad");
    expect(css).not.toContain("Short");
    expect(css).not.toContain("display:none");
    expect(css).toContain('data-path="Good"');
  });
  it("returns an empty string for no entries", () => {
    expect(buildCss([], { colorFiles: true })).toBe("");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/css.test.ts`
Expected: FAIL — cannot resolve `../src/css`.

- [ ] **Step 3: Write `src/css.ts`**

```ts
import { isHex } from "./hex";

export interface FolderColorEntry {
  path: string;
  color: string;
}

export interface CssOptions {
  /** Also color `.nav-file-title` rows inside the folder. */
  colorFiles: boolean;
}

/** Escape a string for use inside a double-quoted CSS attribute selector. */
export function escapeAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Selects a top-level folder in the file explorer by its data-path. Same
 * shape as the bruh.css snippet, with a leading `body` so these rules win
 * over the snippet's equal-specificity rules regardless of load order.
 */
export function folderSelector(path: string): string {
  return `body .nav-files-container > div > .nav-folder:has(> .nav-folder-title[data-path="${escapeAttr(path)}"])`;
}

/** Build the whole stylesheet. Entries with invalid colors are skipped. */
export function buildCss(entries: FolderColorEntry[], opts: CssOptions): string {
  const rules: string[] = [];
  for (const { path, color } of entries) {
    if (!isHex(color)) continue;
    const sel = folderSelector(path);
    rules.push(`${sel} { --folder-color: ${color}; }`);
    rules.push(`${sel} > .nav-folder-title { color: var(--folder-color); }`);
    if (opts.colorFiles) {
      rules.push(`${sel} .nav-file-title { color: var(--folder-color); }`);
    }
  }
  return rules.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/css.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/css.ts tests/css.test.ts
git commit -m "feat: generate folder-color stylesheet from settings entries"
```

---

### Task 4: Folder ordering and palette assignment

**Files:**
- Create: `src/assign.ts`
- Test: `tests/assign.test.ts`

**Interfaces:**
- Consumes: `Palette` from `src/palettes.ts`.
- Produces:
  - `type ColorMap = Record<string, string>`
  - `sortFolderNames(names: string[]): string[]` — new array, case-insensitive, numeric-aware.
  - `assignPalette(sortedNames: string[], palette: Palette): ColorMap` — `names[i] → colors[i % n].hex`.
  - `renameKey(map: ColorMap, oldKey: string, newKey: string): ColorMap` — new object.
  - `dropKey(map: ColorMap, key: string): ColorMap` — new object.

- [ ] **Step 1: Write the failing tests**

`tests/assign.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assignPalette, dropKey, renameKey, sortFolderNames } from "../src/assign";
import type { Palette } from "../src/palettes";

const palette: Palette = {
  id: "t",
  name: "Test",
  source: "test",
  colors: [
    { name: "a", hex: "#aaaaaa" },
    { name: "b", hex: "#bbbbbb" },
    { name: "c", hex: "#cccccc" },
  ],
};

describe("sortFolderNames", () => {
  it("sorts case-insensitively like the file explorer", () => {
    expect(sortFolderNames(["beta", "Alpha", "gamma"])).toEqual(["Alpha", "beta", "gamma"]);
  });
  it("sorts numbers naturally", () => {
    expect(sortFolderNames(["Week 10", "Week 2", "Week 1"])).toEqual(["Week 1", "Week 2", "Week 10"]);
  });
  it("does not mutate its input", () => {
    const input = ["b", "a"];
    sortFolderNames(input);
    expect(input).toEqual(["b", "a"]);
  });
});

describe("assignPalette", () => {
  it("assigns colors in order", () => {
    expect(assignPalette(["A", "B"], palette)).toEqual({ A: "#aaaaaa", B: "#bbbbbb" });
  });
  it("wraps around when there are more folders than colors", () => {
    expect(assignPalette(["A", "B", "C", "D"], palette)).toEqual({
      A: "#aaaaaa",
      B: "#bbbbbb",
      C: "#cccccc",
      D: "#aaaaaa",
    });
  });
  it("returns an empty map for no folders", () => {
    expect(assignPalette([], palette)).toEqual({});
  });
  it("returns an empty map for a palette with no colors", () => {
    expect(assignPalette(["A"], { ...palette, colors: [] })).toEqual({});
  });
});

describe("renameKey", () => {
  it("moves the color to the new key", () => {
    expect(renameKey({ Old: "#111111", Other: "#222222" }, "Old", "New")).toEqual({
      Other: "#222222",
      New: "#111111",
    });
  });
  it("is a no-op copy when the old key is missing", () => {
    const map = { A: "#111111" };
    const out = renameKey(map, "Missing", "New");
    expect(out).toEqual({ A: "#111111" });
    expect(out).not.toBe(map);
  });
  it("overwrites an existing entry at the new key", () => {
    expect(renameKey({ A: "#111111", B: "#222222" }, "A", "B")).toEqual({ B: "#111111" });
  });
  it("does not mutate its input", () => {
    const map = { A: "#111111" };
    renameKey(map, "A", "B");
    expect(map).toEqual({ A: "#111111" });
  });
});

describe("dropKey", () => {
  it("removes the key and returns a new object", () => {
    const map = { A: "#111111", B: "#222222" };
    const out = dropKey(map, "A");
    expect(out).toEqual({ B: "#222222" });
    expect(map).toEqual({ A: "#111111", B: "#222222" });
  });
  it("copies unchanged when the key is missing", () => {
    expect(dropKey({ A: "#111111" }, "Z")).toEqual({ A: "#111111" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/assign.test.ts`
Expected: FAIL — cannot resolve `../src/assign`.

- [ ] **Step 3: Write `src/assign.ts`**

```ts
import type { Palette } from "./palettes";

/** Top-level folder path → "#rrggbb". */
export type ColorMap = Record<string, string>;

/** Alphabetical, case-insensitive, numeric-aware — the explorer's default order. */
export function sortFolderNames(names: string[]): string[] {
  return [...names].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
  );
}

/** names[i] gets colors[i % n]. Pass names already sorted. */
export function assignPalette(sortedNames: string[], palette: Palette): ColorMap {
  const out: ColorMap = {};
  const n = palette.colors.length;
  if (n === 0) return out;
  sortedNames.forEach((name, i) => {
    out[name] = palette.colors[i % n].hex;
  });
  return out;
}

export function renameKey(map: ColorMap, oldKey: string, newKey: string): ColorMap {
  if (!(oldKey in map)) return { ...map };
  const { [oldKey]: color, ...rest } = map;
  return { ...rest, [newKey]: color };
}

export function dropKey(map: ColorMap, key: string): ColorMap {
  const { [key]: _dropped, ...rest } = map;
  return rest;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/assign.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/assign.ts tests/assign.test.ts
git commit -m "feat: folder ordering and palette assignment helpers"
```

---

### Task 5: Settings shape and normalization

**Files:**
- Create: `src/settings.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: `isHex` from `src/hex.ts`, `ColorMap` from `src/assign.ts`.
- Produces:
  - `interface FolderPaletteSettings { paletteId: string; folderColors: ColorMap; colorFiles: boolean }`
  - `DEFAULT_SETTINGS: FolderPaletteSettings` (`"muted-rainbow"`, `{}`, `true`)
  - `normalizeSettings(raw: unknown): FolderPaletteSettings` — never throws; drops invalid entries.

- [ ] **Step 1: Write the failing tests**

`tests/settings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings";

describe("normalizeSettings", () => {
  it("returns defaults for null/undefined/garbage", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });
  it("never returns the shared default object", () => {
    const out = normalizeSettings(null);
    expect(out).not.toBe(DEFAULT_SETTINGS);
    expect(out.folderColors).not.toBe(DEFAULT_SETTINGS.folderColors);
  });
  it("keeps valid fields", () => {
    expect(
      normalizeSettings({
        paletteId: "nord",
        colorFiles: false,
        folderColors: { Archive: "#E5877E", "Cyber Security": "#eaa87b" },
      })
    ).toEqual({
      paletteId: "nord",
      colorFiles: false,
      folderColors: { Archive: "#E5877E", "Cyber Security": "#eaa87b" },
    });
  });
  it("drops folder entries that are not #rrggbb", () => {
    expect(
      normalizeSettings({
        folderColors: { Good: "#123456", Named: "red", Short: "#fff", Num: 7, "": "#123456" },
      }).folderColors
    ).toEqual({ Good: "#123456" });
  });
  it("falls back per field when a field has the wrong type", () => {
    expect(normalizeSettings({ paletteId: 3, colorFiles: "yes", folderColors: [] })).toEqual(
      DEFAULT_SETTINGS
    );
    expect(normalizeSettings({ paletteId: "" }).paletteId).toBe("muted-rainbow");
  });
  it("ignores unknown fields", () => {
    const out = normalizeSettings({ paletteId: "nord", extra: true }) as unknown as Record<string, unknown>;
    expect(out.extra).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL — cannot resolve `../src/settings`.

- [ ] **Step 3: Write `src/settings.ts`**

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
}

export const DEFAULT_SETTINGS: FolderPaletteSettings = {
  paletteId: "muted-rainbow",
  folderColors: {},
  colorFiles: true,
};

/** Coerce whatever loadData() returned into a valid settings object. */
export function normalizeSettings(raw: unknown): FolderPaletteSettings {
  const out: FolderPaletteSettings = { ...DEFAULT_SETTINGS, folderColors: {} };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;

  if (typeof r.paletteId === "string" && r.paletteId.length > 0) out.paletteId = r.paletteId;
  if (typeof r.colorFiles === "boolean") out.colorFiles = r.colorFiles;

  const fc = r.folderColors;
  if (fc && typeof fc === "object" && !Array.isArray(fc)) {
    for (const [path, color] of Object.entries(fc as Record<string, unknown>)) {
      if (path.length > 0 && isHex(color)) out.folderColors[path] = color;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS — all four test files green (38 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts tests/settings.test.ts
git commit -m "feat: settings shape with defensive normalization"
```

---

### Task 6: Swatch strip helper + static styles

**Files:**
- Create: `src/swatches.ts`
- Modify: `styles.css`

**Interfaces:**
- Consumes: `Palette` from `src/palettes.ts`.
- Produces: `renderSwatchStrip(container: HTMLElement, palette: Palette, selected: string | null, onPick: ((hex: string) => void) | null): Map<string, HTMLElement>` — key is the palette hex exactly as written in the palette; clickable `<button>`s when `onPick` given, inert `<span>`s otherwise; the element whose hex equals `selected` (case-insensitive) gets class `is-selected`.

No unit tests (DOM + Obsidian helpers); verified by the typecheck in Step 3 and the manual checklist in Task 8.

- [ ] **Step 1: Write `src/swatches.ts`**

```ts
import type { Palette } from "./palettes";

/**
 * Render one swatch per palette color into `container`. Returns hex → element
 * so callers can re-mark the selected swatch without rebuilding the strip.
 */
export function renderSwatchStrip(
  container: HTMLElement,
  palette: Palette,
  selected: string | null,
  onPick: ((hex: string) => void) | null
): Map<string, HTMLElement> {
  const swatches = new Map<string, HTMLElement>();
  const sel = selected?.toLowerCase() ?? null;
  for (const color of palette.colors) {
    const label = `${color.name} ${color.hex}`;
    const el = container.createEl(onPick ? "button" : "span", {
      cls: "fp-swatch",
      attr: { "aria-label": label, title: label, type: "button" },
    });
    el.style.setProperty("--fp-color", color.hex);
    if (sel !== null && color.hex.toLowerCase() === sel) el.addClass("is-selected");
    if (onPick) {
      el.addEventListener("click", (evt) => {
        evt.preventDefault();
        onPick(color.hex);
      });
    }
    swatches.set(color.hex, el);
  }
  return swatches;
}

/** Re-mark which swatch is selected. `selected` null clears all marks. */
export function markSelected(swatches: Map<string, HTMLElement>, selected: string | null): void {
  const sel = selected?.toLowerCase() ?? null;
  for (const [hex, el] of swatches) {
    el.toggleClass("is-selected", sel !== null && hex.toLowerCase() === sel);
  }
}
```

- [ ] **Step 2: Write `styles.css`**

```css
/* FolderPalette — settings/modal chrome only. Folder colors themselves are
   injected at runtime into <style id="folder-palette-styles">. */

.fp-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: center;
}

/* Preview strip under the palette dropdown */
.fp-strip-preview {
  margin: -6px 0 14px;
}

/* Per-folder rows: keep the strip compact so it fits next to the picker */
.fp-folder-row .fp-strip {
  max-width: 300px;
}

.fp-folder-row .setting-item-control {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.fp-swatch,
button.fp-swatch {
  box-sizing: border-box;
  width: 18px;
  height: 18px;
  min-width: 0;
  padding: 0;
  margin: 0;
  border-radius: 50%;
  border: 2px solid transparent;
  background-color: var(--fp-color);
  box-shadow: 0 0 0 1px var(--background-modifier-border);
  cursor: default;
  transition: transform 80ms ease-out;
}

button.fp-swatch {
  cursor: pointer;
}

button.fp-swatch:hover {
  transform: scale(1.2);
}

.fp-swatch.is-selected,
button.fp-swatch.is-selected {
  border-color: var(--background-primary);
  box-shadow: 0 0 0 2px var(--text-normal);
}

/* Context-menu modal: bigger targets */
.fp-strip-large .fp-swatch,
.fp-strip-large button.fp-swatch {
  width: 28px;
  height: 28px;
}

/* Palette chooser (command): tiny inline preview */
.fp-strip-mini {
  gap: 3px;
  margin-top: 3px;
}
.fp-strip-mini .fp-swatch {
  width: 10px;
  height: 10px;
  border-width: 1px;
  box-shadow: none;
}

/* Colored dot in front of the folder name */
.fp-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 8px;
  border-radius: 50%;
  vertical-align: middle;
  background-color: var(--fp-color, transparent);
  box-shadow: 0 0 0 1px var(--background-modifier-border);
}

.fp-modal .fp-strip-large {
  margin: 8px 0 16px;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add src/swatches.ts styles.css
git commit -m "feat: swatch strip helper and settings chrome styles"
```

---

### Task 7: Plugin core, settings tab, modals, command, context menu

**Files:**
- Create: `src/settingsTab.ts`, `src/colorModal.ts`, `src/paletteModal.ts`
- Modify: `src/main.ts` (replace the stub)

**Interfaces:**
- Consumes: everything above — `buildCss`, `assignPalette`, `sortFolderNames`, `renameKey`, `dropKey`, `PALETTES`, `getPalette`, `Palette`, `normalizeSettings`, `FolderPaletteSettings`, `renderSwatchStrip`, `markSelected`, `isHex`.
- Produces (on `FolderPalettePlugin`, used by the UI files):
  - `settings: FolderPaletteSettings`
  - `get palette(): Palette`
  - `topLevelFolderNames(): string[]` (sorted)
  - `isTopLevelFolder(file: TAbstractFile): file is TFolder`
  - `setFolderColor(path: string, color: string | null): Promise<void>` — does **not** rebuild the settings tab (rows sync themselves).
  - `setPaletteId(id: string): Promise<void>`, `setColorFiles(on: boolean): Promise<void>`, `applyPalette(palette: Palette): Promise<void>` — these rebuild the tab if open.
  - `FolderPaletteSettingTab.refresh(): void` — rebuilds only when the tab is open.

- [ ] **Step 1: Write `src/main.ts`**

```ts
import { Plugin, TAbstractFile, TFolder } from "obsidian";
import { assignPalette, dropKey, renameKey, sortFolderNames } from "./assign";
import { ColorModal } from "./colorModal";
import { buildCss } from "./css";
import { PaletteSuggestModal } from "./paletteModal";
import { getPalette, Palette } from "./palettes";
import { DEFAULT_SETTINGS, FolderPaletteSettings, normalizeSettings } from "./settings";
import { FolderPaletteSettingTab } from "./settingsTab";

const STYLE_ID = "folder-palette-styles";

export default class FolderPalettePlugin extends Plugin {
  settings: FolderPaletteSettings = { ...DEFAULT_SETTINGS, folderColors: {} };
  private styleEl: HTMLStyleElement | null = null;
  private settingTab!: FolderPaletteSettingTab;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());

    this.styleEl = document.createElement("style");
    this.styleEl.id = STYLE_ID;
    document.head.appendChild(this.styleEl);
    this.applyStyles();

    this.settingTab = new FolderPaletteSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.addCommand({
      id: "apply-palette",
      name: "Apply a color palette to all folders…",
      callback: () => {
        new PaletteSuggestModal(this.app, (palette) => void this.applyPalette(palette)).open();
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!this.isTopLevelFolder(file)) return;
        menu.addItem((item) =>
          item
            .setTitle("Change folder color…")
            .setIcon("palette")
            .onClick(() => new ColorModal(this.app, this, file.path).open())
        );
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFolder)) return;
        if (!(oldPath in this.settings.folderColors)) {
          // A folder appeared at (or left) the top level without a color: the
          // settings list changed shape, nothing to persist.
          this.settingTab.refresh();
          return;
        }
        this.settings.folderColors = this.isTopLevelFolder(file)
          ? renameKey(this.settings.folderColors, oldPath, file.path)
          : dropKey(this.settings.folderColors, oldPath);
        void this.persist();
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFolder)) return;
        if (file.path in this.settings.folderColors) {
          this.settings.folderColors = dropKey(this.settings.folderColors, file.path);
          void this.persist();
        } else {
          this.settingTab.refresh();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.isTopLevelFolder(file)) this.settingTab.refresh();
      })
    );
  }

  onunload(): void {
    this.styleEl?.remove();
    this.styleEl = null;
  }

  get palette(): Palette {
    return getPalette(this.settings.paletteId);
  }

  /** Sorted names (== paths) of the vault's top-level folders. */
  topLevelFolderNames(): string[] {
    const names = this.app.vault
      .getRoot()
      .children.filter((child): child is TFolder => child instanceof TFolder)
      .map((folder) => folder.path);
    return sortFolderNames(names);
  }

  isTopLevelFolder(file: TAbstractFile): file is TFolder {
    return file instanceof TFolder && file.parent !== null && file.parent.isRoot();
  }

  /** `color` null clears the folder. Rows in the settings tab re-sync themselves. */
  async setFolderColor(path: string, color: string | null): Promise<void> {
    this.settings.folderColors =
      color === null
        ? dropKey(this.settings.folderColors, path)
        : { ...this.settings.folderColors, [path]: color };
    await this.persist(false);
  }

  async setPaletteId(id: string): Promise<void> {
    this.settings.paletteId = getPalette(id).id;
    await this.persist();
  }

  async setColorFiles(on: boolean): Promise<void> {
    this.settings.colorFiles = on;
    await this.persist();
  }

  /** Select `palette` and color every top-level folder from it, in order. */
  async applyPalette(palette: Palette): Promise<void> {
    this.settings.paletteId = palette.id;
    this.settings.folderColors = assignPalette(this.topLevelFolderNames(), palette);
    await this.persist();
  }

  private async persist(rebuildTab = true): Promise<void> {
    await this.saveData(this.settings);
    this.applyStyles();
    if (rebuildTab) this.settingTab.refresh();
  }

  private applyStyles(): void {
    if (!this.styleEl) return;
    const entries = Object.entries(this.settings.folderColors).map(([path, color]) => ({
      path,
      color,
    }));
    this.styleEl.textContent = buildCss(entries, { colorFiles: this.settings.colorFiles });
  }
}
```

- [ ] **Step 2: Write `src/settingsTab.ts`**

```ts
import { App, ColorComponent, PluginSettingTab, Setting } from "obsidian";
import { isHex } from "./hex";
import type FolderPalettePlugin from "./main";
import { PALETTES, Palette } from "./palettes";
import { markSelected, renderSwatchStrip } from "./swatches";

const FALLBACK_PICKER = "#888888";

export class FolderPaletteSettingTab extends PluginSettingTab {
  private open = false;
  private rows: FolderRow[] = [];

  constructor(app: App, private plugin: FolderPalettePlugin) {
    super(app, plugin);
  }

  display(): void {
    this.open = true;
    const { containerEl } = this;
    const scrollTop = containerEl.scrollTop;
    containerEl.empty();
    this.rows = [];

    const palette = this.plugin.palette;

    new Setting(containerEl)
      .setName("Palette")
      .setDesc(`${palette.colors.length} colors — ${palette.source}`)
      .addDropdown((dropdown) => {
        for (const p of PALETTES) dropdown.addOption(p.id, p.name);
        dropdown.setValue(palette.id).onChange((id) => void this.plugin.setPaletteId(id));
      });

    renderSwatchStrip(containerEl.createDiv({ cls: "fp-strip fp-strip-preview" }), palette, null, null);

    new Setting(containerEl)
      .setName("Apply to all folders")
      .setDesc(
        "Colors every top-level folder from this palette in alphabetical order (wrapping around if there are more folders than colors). Replaces any colors set below."
      )
      .addButton((button) =>
        button
          .setButtonText("Apply")
          .setCta()
          .onClick(() => void this.plugin.applyPalette(palette))
      );

    new Setting(containerEl)
      .setName("Color files inside folders")
      .setDesc("Notes under a colored folder take the folder's color too.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.colorFiles)
          .onChange((on) => void this.plugin.setColorFiles(on))
      );

    new Setting(containerEl).setName("Folders").setHeading();

    const names = this.plugin.topLevelFolderNames();
    if (names.length === 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "No top-level folders in this vault yet.",
      });
    }
    for (const name of names) {
      this.rows.push(new FolderRow(containerEl, this.plugin, name, palette));
    }

    containerEl.scrollTop = scrollTop;
  }

  hide(): void {
    this.open = false;
    this.rows = [];
  }

  /** Rebuild if the tab is currently showing; no-op otherwise. */
  refresh(): void {
    if (this.open) this.display();
  }
}

/** One settings row: dot + name, palette swatches, custom picker, clear. */
class FolderRow {
  private readonly dot: HTMLElement;
  private readonly swatches: Map<string, HTMLElement>;
  private picker!: ColorComponent;

  constructor(
    parent: HTMLElement,
    private readonly plugin: FolderPalettePlugin,
    private readonly path: string,
    palette: Palette
  ) {
    const setting = new Setting(parent).setClass("fp-folder-row");

    setting.nameEl.empty();
    this.dot = setting.nameEl.createSpan({ cls: "fp-dot" });
    setting.nameEl.appendText(path);

    this.swatches = renderSwatchStrip(
      setting.controlEl.createDiv({ cls: "fp-strip" }),
      palette,
      this.current(),
      (hex) => void this.set(hex)
    );

    setting.addColorPicker((picker) => {
      this.picker = picker;
      picker.setValue(this.current() ?? FALLBACK_PICKER).onChange((hex) => void this.set(hex));
    });

    setting.addExtraButton((button) =>
      button
        .setIcon("x")
        .setTooltip("Clear color")
        .onClick(() => void this.set(null))
    );

    this.sync();
  }

  private current(): string | null {
    const color = this.plugin.settings.folderColors[this.path];
    return isHex(color) ? color : null;
  }

  private async set(color: string | null): Promise<void> {
    await this.plugin.setFolderColor(this.path, color);
    this.sync();
  }

  /** Re-sync dot, swatch mark and picker from settings without rebuilding DOM. */
  sync(): void {
    const color = this.current();
    this.dot.style.setProperty("--fp-color", color ?? "transparent");
    markSelected(this.swatches, color);
    if (color !== null) this.picker.setValue(color);
  }
}
```

- [ ] **Step 3: Write `src/colorModal.ts`**

```ts
import { App, Modal, Setting } from "obsidian";
import { isHex } from "./hex";
import type FolderPalettePlugin from "./main";
import { markSelected, renderSwatchStrip } from "./swatches";

const FALLBACK_PICKER = "#888888";

/** Opened from the folder context menu: swatches, custom picker, clear. */
export class ColorModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: FolderPalettePlugin,
    private readonly path: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    contentEl.addClass("fp-modal");
    titleEl.setText(`Color for "${this.path}"`);

    const palette = this.plugin.palette;
    const current = this.plugin.settings.folderColors[this.path];
    const initial = isHex(current) ? current : null;

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `${palette.name} — click a swatch, or choose a custom color below.`,
    });

    const swatches = renderSwatchStrip(
      contentEl.createDiv({ cls: "fp-strip fp-strip-large" }),
      palette,
      initial,
      (hex) => {
        void this.plugin.setFolderColor(this.path, hex);
        this.close();
      }
    );

    new Setting(contentEl).setName("Custom color").addColorPicker((picker) =>
      picker.setValue(initial ?? FALLBACK_PICKER).onChange((hex) => {
        void this.plugin.setFolderColor(this.path, hex);
        markSelected(swatches, hex);
      })
    );

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Clear color").onClick(() => {
          void this.plugin.setFolderColor(this.path, null);
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("Done")
          .setCta()
          .onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ] **Step 4: Write `src/paletteModal.ts`**

```ts
import { App, FuzzyMatch, FuzzySuggestModal, renderMatches } from "obsidian";
import { PALETTES, Palette } from "./palettes";
import { renderSwatchStrip } from "./swatches";

/** Command palette helper: pick a palette to apply to every top-level folder. */
export class PaletteSuggestModal extends FuzzySuggestModal<Palette> {
  constructor(app: App, private readonly onPick: (palette: Palette) => void) {
    super(app);
    this.setPlaceholder("Choose a palette to apply to all folders");
  }

  getItems(): Palette[] {
    return PALETTES;
  }

  getItemText(palette: Palette): string {
    return palette.name;
  }

  renderSuggestion(item: FuzzyMatch<Palette>, el: HTMLElement): void {
    const title = el.createDiv();
    renderMatches(title, item.item.name, item.match.matches);
    title.appendText(` · ${item.item.colors.length} colors`);
    renderSwatchStrip(el.createDiv({ cls: "fp-strip fp-strip-mini" }), item.item, null, null);
  }

  onChooseItem(palette: Palette): void {
    this.onPick(palette);
  }
}
```

- [ ] **Step 5: Typecheck, test, build**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc clean; 38 tests pass; `main.js` emitted. If tsc complains that `Setting.nameEl`/`controlEl`, `ColorComponent`, `renderMatches`, or `PluginSettingTab.hide` don't exist, the installed `obsidian` typings are too old — run `npm install obsidian@latest --save-dev` and retry (all of these exist in ≥1.5).

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/settingsTab.ts src/colorModal.ts src/paletteModal.ts
git commit -m "feat: plugin core with settings tab, folder context menu and palette command"
```

---

### Task 8: README, selector check in a real browser, deploy

**Files:**
- Create: `README.md`
- Modify: `manifest.json` (version stays 0.1.0 for the first deploy)
- Vault: `C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\folder-palette\{main.js,manifest.json,styles.css}`, `C:\Users\rober\Documents\SyncedMain\.obsidian\community-plugins.json`

**Interfaces:** none (delivery).

- [ ] **Step 1: Write `README.md`**

````markdown
# FolderPalette

Obsidian plugin for the SyncedMain vault. Colors the **top-level folders** in
the file explorer — the thing `bruh.css` used to hard-code — from inside
Obsidian.

## Use

- **Settings → FolderPalette**
  - *Palette*: pick one of 11 presets (every preset has ≥10 colors). The first
    one, **Muted Rainbow**, is the exact palette from `bruh.css`.
  - *Apply to all folders*: colors every top-level folder from the palette in
    alphabetical order. With Muted Rainbow that reproduces the old CSS exactly.
  - *Folders*: one row per top-level folder — click a swatch, use the color
    picker for any custom hex, or ✕ to clear.
  - *Color files inside folders*: notes under a colored folder inherit the color.
- **Right-click a top-level folder → Change folder color…**
- **Command palette → "FolderPalette: Apply a color palette to all folders…"**

## How it works with bruh.css

The plugin injects `<style id="folder-palette-styles">` with one rule per
folder that sets `--folder-color`, using the same selector as the snippet but
prefixed with `body` so it wins. The snippet's border, icon and outline rules
all read `var(--folder-color)`, so they keep working. The six
`data-path="…"` lines in `bruh.css` (the `--folder-color: var(--folder-color-N)`
ones and the matching `.nav-file-title` ones) are now redundant and can be
deleted — if you keep them, they only act as a fallback for folders the plugin
has no color for. Turning *Color files inside folders* off only takes full
effect once those `.nav-file-title` lines are gone.

## Palettes

| Palette | Colors | Source |
|---|---|---|
| Muted Rainbow | 10 | `bruh.css` + Soft Mint |
| Catppuccin Mocha / Latte | 14 / 14 | catppuccin.com/palette |
| Tokyo Night | 10 | folke/tokyonight.nvim |
| Gruvbox | 14 | morhetz/gruvbox |
| Nord | 10 | nordtheme.com |
| Tableau 10 | 10 | Tableau |
| Paul Tol Muted | 10 | colorblind-safe, personal.sron.nl/~pault |
| Material Vivid / Pastel | 16 / 16 | Material Design 2014 (500 / 200 tones) |
| Flat UI | 14 | flatuicolors.com |

## Build & deploy

    npm install
    npm test
    npm run build
    robocopy . "C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\folder-palette" main.js manifest.json styles.css

robocopy exit code 1 means success. Never use /MIR (it would delete
`data.json`, your saved colors). Bump the version in `manifest.json` each
deploy, then fully restart Obsidian (it hides in the tray):

    Stop-Process -Name Obsidian -Force
    Start-Process "$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe"

## Limits

- Top-level folders only (nested folders inherit their parent's color through
  the snippet's `.nav-folder-title { color: var(--folder-color) }` rule).
- No custom palette editor; the color picker covers one-off colors.
````

- [ ] **Step 2: Build a DOM fixture and check the generated CSS in Chromium**

Write `C:\Users\rober\AppData\Local\Temp\claude\…\scratchpad\fixture.html` that reproduces the explorer DOM the snippet targets, loads `bruh.css` inline, then the plugin's generated CSS for `{Archive: "#112233"}` (a color that is NOT in the snippet, so a win is unambiguous) with `colorFiles: true`:

```html
<div class="nav-files-container"><div>
  <div class="tree-item nav-folder">
    <div class="tree-item-self nav-folder-title" data-path="Archive"><div class="nav-folder-title-content">Archive</div></div>
    <div class="tree-item-children nav-folder-children">
      <div class="tree-item nav-file"><div class="tree-item-self nav-file-title" data-path="Archive/a.md"><div class="nav-file-title-content">a</div></div></div>
    </div>
  </div>
  <div class="tree-item nav-folder">
    <div class="tree-item-self nav-folder-title" data-path="University"><div class="nav-folder-title-content">University</div></div>
  </div>
</div></div>
```

Generate the plugin CSS with `node -e` against the built `main.js`? No — `main.js` requires `obsidian`. Instead run the pure module through vitest-free TypeScript: `npx esbuild src/css.ts --bundle --format=cjs --outfile=<scratch>/css.cjs` then `node -e "const {buildCss}=require('<scratch>/css.cjs'); console.log(buildCss([{path:'Archive',color:'#112233'}],{colorFiles:true}))"` and paste the output into a `<style>` after the snippet.

Open the fixture in Chrome (claude-in-chrome) and evaluate:

```js
const c = (sel) => getComputedStyle(document.querySelector(sel)).color;
JSON.stringify({
  archiveTitle: c('.nav-folder-title[data-path="Archive"]'),     // expect rgb(17, 34, 51)
  archiveFile:  c('.nav-file-title[data-path="Archive/a.md"]'),  // expect rgb(17, 34, 51)
  uniTitle:     c('.nav-folder-title[data-path="University"]'),  // expect snippet's lavender rgb(178, 167, 226)
});
```

Expected: Archive title and file are `rgb(17, 34, 51)` (plugin beat the snippet's `--folder-color-2`), University still lavender (untouched folders fall back to the snippet). If the browser extension is unavailable, skip this step and rely on the manual checklist in Step 5.

- [ ] **Step 3: Deploy**

```powershell
cd C:\Users\rober\Desktop\ObsidianCustomPlugins\FolderPalette
npm run build
robocopy . "C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\folder-palette" main.js manifest.json styles.css
```

Expected: robocopy exit code 1 (3 files copied). Then enable the plugin: read `C:\Users\rober\Documents\SyncedMain\.obsidian\community-plugins.json`, add `"folder-palette"` to the array if absent, and write it back **via robocopy from a staged copy in the scratchpad** (direct writes are blocked by Controlled Folder Access):

```powershell
$vault = "C:\Users\rober\Documents\SyncedMain\.obsidian"
$stage = "<scratchpad>\stage"
New-Item -ItemType Directory -Force $stage | Out-Null
$list = Get-Content "$vault\community-plugins.json" | ConvertFrom-Json
if ($list -notcontains "folder-palette") { $list += "folder-palette" }
ConvertTo-Json @($list) | Set-Content -Encoding utf8 "$stage\community-plugins.json"
robocopy $stage $vault community-plugins.json
```

- [ ] **Step 4: Restart Obsidian so it loads the new plugin**

```powershell
Stop-Process -Name Obsidian -Force -ErrorAction SilentlyContinue
Start-Process "$env:LOCALAPPDATA\Programs\Obsidian\Obsidian.exe"
```

Expected: Obsidian reopens; Settings → Community plugins lists FolderPalette enabled.

- [ ] **Step 5: Manual checklist (needs a human — leave for the user)**

1. Settings → FolderPalette → Apply (Muted Rainbow). Sidebar looks identical to before.
2. Click a different swatch on *University*. Border, title and note names change immediately.
3. Right-click *Miscellaneous* → Change folder color… → pick a swatch. Changes live.
4. Rename a colored folder. Color follows.
5. Disable `bruh` in Appearance → CSS snippets. Titles/notes still colored (no border/icons — expected). Re-enable.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: README with usage, bruh.css notes, palettes and deploy steps"
```
