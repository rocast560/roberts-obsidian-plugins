# FolderPalette — design spec

Date: 2026-08-23
Status: approved under stated assumptions (session ran autonomously; see §8)

## 1. Problem

The SyncedMain vault colors its top-level folders in the file explorer through a
CSS snippet (`.obsidian/snippets/bruh.css`). The snippet defines a "Muted
Rainbow" palette as `--folder-color-1..10` on `body`, then hard-codes one rule
per folder:

```css
.nav-files-container > div > .nav-folder:has(> .nav-folder-title[data-path="Archive"]) { --folder-color: var(--folder-color-2); }
```

Everything else in the snippet (folder title color, file title color, icon
color, 5px left border) reads `var(--folder-color)`. Changing a folder's color
means editing CSS by hand. The user wants to pick colors from inside Obsidian,
per folder, from preset palettes — including the current rainbow — with each
palette at least 10 colors long.

## 2. Scope

In scope (v1):

- Color any **top-level** folder of the vault from a settings UI.
- Preset palettes (≥10 colors each), with the existing Muted Rainbow first.
- "Apply palette to all folders" in one click (and as a command).
- Per-folder swatch picking, free hex via native color picker, clear.
- Folder context-menu entry for top-level folders.
- Colors survive folder renames.
- Works with or without `bruh.css` enabled (the plugin colors titles/files
  itself; the snippet adds border/icons on top).

Out of scope (v1): nested folders, user-defined palettes, per-file colors,
editing `bruh.css`, icon customization.

## 3. Mechanism

The plugin owns a single `<style id="folder-palette-styles">` element in
`document.head`. Whenever settings change it regenerates the stylesheet from a
pure function and replaces `textContent`. On unload it removes the element.

Generated CSS per colored folder (`P` = attribute-escaped folder path,
`C` = validated `#rrggbb`):

```css
body .nav-files-container > div > .nav-folder:has(> .nav-folder-title[data-path="P"]) { --folder-color: C; }
body .nav-files-container > div > .nav-folder:has(> .nav-folder-title[data-path="P"]) > .nav-folder-title { color: var(--folder-color); }
/* only when colorFiles is on: */
body .nav-files-container > div > .nav-folder:has(> .nav-folder-title[data-path="P"]) .nav-file-title { color: var(--folder-color); }
```

Why this shape:

- Same selector as the snippet, so it targets exactly the same elements
  Obsidian renders today; `:has()` is already proven to work in this vault.
- The leading `body` adds one type selector of specificity, so the plugin's
  rule wins over the snippet's identical-specificity rule regardless of
  stylesheet order. No need to edit the snippet.
- The variable approach means the snippet's border/icon rules pick up the
  plugin's color for free.
- No DOM observation: the explorer can re-render as much as it likes.

Escaping: folder paths go into a double-quoted attribute selector; backslash
becomes double-backslash and a double quote becomes backslash-quote. Colors
must match `/^#[0-9a-f]{6}$/i` or the entry is skipped (defends against a
hand-edited `data.json` breaking the stylesheet).

## 4. Data model (`data.json`)

```ts
interface FolderPaletteSettings {
  paletteId: string;                    // palette selected in the settings UI
  folderColors: Record<string, string>; // top-level folder name -> "#rrggbb"
  colorFiles: boolean;                  // also color .nav-file-title inside the folder (default true)
}
```

Defaults: `paletteId: "muted-rainbow"`, `folderColors: {}`, `colorFiles: true`.
Unknown `paletteId` falls back to the first palette at read time (never
written back unless the user changes it).

Folder identity is the folder **name** (equal to its path for top-level
folders, which is what `data-path` holds).

Vault events:

- `rename` of a top-level folder → move its entry to the new name, re-render.
- `delete` of a top-level folder → drop its entry, re-render.
- `create` of a folder → re-render settings list if open (no color assigned).

## 5. Palettes

`src/palettes.ts` exports `PALETTES: Palette[]` where

```ts
interface Palette { id: string; name: string; source: string; colors: { name: string; hex: string }[] }
```

Invariants (unit-tested): unique ids; every palette ≥ 10 colors; every hex
matches `/^#[0-9a-f]{6}$/i`; first palette is `muted-rainbow` and its first 9
colors equal the snippet's `--folder-color-2..10` in order, so "Apply to all"
reproduces the current sidebar exactly (Archive→Soft Red, Cyber
Security→Soft Orange, Internships→Soft Yellow, Miscellaneous→Soft Green,
Software Engineering→Soft Blue, University→Soft Lavender).

| id | name | n | source |
|---|---|---|---|
| muted-rainbow | Muted Rainbow | 10 | bruh.css (9) + Soft Mint `#9EDFA9` |
| catppuccin-mocha | Catppuccin Mocha | 14 | catppuccin.com/palette |
| catppuccin-latte | Catppuccin Latte | 14 | catppuccin.com/palette |
| tokyo-night | Tokyo Night | 10 | folke/tokyonight.nvim extras |
| gruvbox | Gruvbox | 14 | morhetz/gruvbox colors/gruvbox.vim |
| nord | Nord | 10 | nordtheme.com (Aurora + Frost + nord4) |
| tableau-10 | Tableau 10 | 10 | tableau.com "Colors upgrade in Tableau 10" |
| tol-muted | Paul Tol Muted (colorblind-safe) | 10 | personal.sron.nl/~pault |
| material-vivid | Material Vivid | 16 | Material Design 2014 palette, 500 tones |
| material-pastel | Material Pastel | 16 | Material Design 2014 palette, 200 tones |
| flat-ui | Flat UI | 14 | flatuicolors.com (v1) |

## 6. Components

```
src/
  main.ts        Plugin: load/save settings, style element, vault events,
                 context menu, command, settings tab registration
  css.ts         buildCss(entries, {colorFiles}) + escapeAttr + isHex   [pure]
  palettes.ts    PALETTES data, getPalette(id) with fallback            [pure]
  assign.ts      sortFolderNames, assignPalette(names, palette),
                 renameKey, dropKey                                     [pure]
  settingsTab.ts PluginSettingTab UI (palette section + folder rows)
  colorModal.ts  Modal used by the context menu: swatches + picker
styles.css       swatch strip / dot styling (static, loaded by Obsidian)
tests/           vitest for css.ts, palettes.ts, assign.ts
```

Interfaces:

- `buildCss(entries: {path: string; color: string}[], opts: {colorFiles: boolean}): string`
  — deterministic; skips invalid colors; returns "" for no entries.
- `assignPalette(names: string[], palette: Palette): Record<string,string>`
  — names[i] → colors[i % colors.length].hex, names already sorted.
- `sortFolderNames(names)` — `localeCompare` with `{sensitivity: "base", numeric: true}`
  to approximate the explorer's default alphabetical order.
- `renameKey(map, oldKey, newKey)` / `dropKey(map, key)` — return new objects.

Settings tab layout (top to bottom):

1. **Palette** dropdown → swatch strip (read-only preview) → *Apply to all
   folders* button.
2. **Color files inside folders** toggle.
3. **Folders** heading, then one `Setting` per top-level folder (sorted):
   name with a colored dot in the description; control area holds a swatch
   strip from the selected palette (click = assign; current color marked),
   an `addColorPicker` for custom hex, and an extra button to clear.

Every change: update settings → `saveData` → re-render the style element →
(for palette/apply/clear) re-render the tab so dots/marks refresh.

Context menu: `workspace.on("file-menu")`, only when `file instanceof TFolder`
and `file.parent?.isRoot()`. Item "Change folder color…" opens
`ColorModal(folderName)` with the selected palette's swatches, a color
picker, and a Clear button.

Command: `apply-palette` — `FuzzySuggestModal<Palette>` → `assignPalette` on
all current top-level folders.

## 7. Error handling

- Invalid hex in settings → entry skipped in CSS, shown as "no color" in UI.
- Unknown `paletteId` → first palette.
- `:has()` unsupported (very old Obsidian) → rules silently don't match; the
  manifest sets `minAppVersion` 1.4.0 where Chromium ≥ 105 is guaranteed.
- Loading failures in `loadData()` → defaults.

## 8. Assumptions (made because the session ran without the user)

1. Top-level folders only — the request named the top-level folders and "main
   folders".
2. `bruh.css` stays untouched; its six per-folder lines become redundant, not
   harmful. The README says which lines can be deleted.
3. Swatch picking per folder + a native color picker is the right amount of UI;
   no custom-palette editor in v1.
4. Muted Rainbow keeps the snippet's order (ending with teal) and gains a single
   new 10th color rather than duplicating `#E5877E`.

## 9. Testing

- Unit (vitest, node): `css.test.ts`, `palettes.test.ts`, `assign.test.ts`.
- Manual (requires Obsidian): install, open settings, apply Muted Rainbow,
  confirm the sidebar is pixel-identical to the snippet; pick a swatch on one
  folder and see the border/title/file names change live; rename a folder
  and confirm the color follows; disable `bruh.css` and confirm titles/files
  still colored (no border — expected).

## 10. Deploy

Same as the other plugins in this repo: `npm run build`, robocopy `main.js
manifest.json styles.css` into
`C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\folder-palette`, add
`folder-palette` to `community-plugins.json`, bump the manifest version, fully
restart Obsidian (tray-kill).
