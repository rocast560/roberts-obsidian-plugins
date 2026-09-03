# FolderPalette

Obsidian plugin for the SyncedMain vault. Owns the look of the file explorer:
top-level folder colors from preset palettes, folder/file icons, the
top-level folder "cards", one indent for files, folders and BetterNotes at
the same depth, collapse arrows, and colored tree lines. It replaced the
hand-written `bruh.css` snippet on 2026-08-26 (kept as
`docs/legacy-bruh.css` for reference).

## Use

- **Settings → FolderPalette**
  - *Palette*: pick one of 11 presets (every preset has ≥10 colors). The first
    one, **Muted Rainbow**, is the exact palette from `bruh.css`.
  - *Apply to all folders*: colors every top-level folder from the palette in
    alphabetical order. With Muted Rainbow that reproduces the old CSS exactly.
  - *Folders*: one row per top-level folder — click a swatch, use the color
    picker for any custom hex, or ✕ to clear.
  - *Color files inside folders*: notes under a colored folder inherit the color.
  - *Show collapse arrows*: the chevron on folder rows (down = open, right =
    closed); click it to fold. BetterNotes keep theirs regardless.
  - *Tree lines*: thin grey connectors from each folder down through its
    children, with a rounded elbow into every child and no tail after the
    last one.
- **Right-click a top-level folder → Change folder color…**
- **Command palette → "FolderPalette: Apply a color palette to all folders…"**

## How the CSS is layered

`styles.css` carries the static explorer look (body-prefixed so it wins ties
with the theme). Per-folder colors are injected at runtime into
`<style id="folder-palette-styles">` as `--folder-color` on each top-level
folder; that variable inherits down the subtree, which is how nested rows,
file glyphs and tree lines pick the color up. Obsidian's virtual tree measures
the children offset and each row's padding and bakes them into inline styles,
so the `--fp-*` geometry variables still drive the indent. The two explorer
toggles are body classes, `fp-arrows-off` and `fp-tree-lines`. Variables other
plugins may read: `--fp-glyph-size`, `--fp-glyph-gap` (BetterNotes sizes its
note icon from them), `--fp-row-indent`, `--fp-children-margin`,
`--fp-children-indent`.

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
  `.nav-folder-title { color: var(--folder-color) }`).
- No custom palette editor; the color picker covers one-off colors.
