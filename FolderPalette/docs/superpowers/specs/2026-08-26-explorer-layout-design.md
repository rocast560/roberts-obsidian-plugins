# Explorer layout: FolderPalette absorbs bruh.css, adds collapse arrows and tree lines

**Date:** 2026-08-26
**Status:** Draft, awaiting Rob's review
**Repos touched:** FolderPalette (primary), BetterNotes (icon footprint + chevron), SyncedMain vault config (snippet off)

## Purpose

The look of the file explorer in the SyncedMain vault is currently owned by a hand-written
CSS snippet, `.obsidian/snippets/bruh.css`, layered on Obsidian core. FolderPalette only
colors folders on top of it. Rob wants:

1. `bruh.css` gone, with FolderPalette shipping the equivalent CSS so one plugin owns the
   explorer's look.
2. A collapse arrow on every folder row (plain folders and BetterNotes alike) that points
   down when open and right when closed, and toggles the children.
3. Tree lines: a colored path that runs from a parent down through all of its children,
   with an elbow into each child, under every palette-colored folder.
4. Rows at the same depth indented identically, whether they are a plain folder, a
   BetterNote or a file.

## Decisions (Rob, 2026-08-26)

- Remove `bruh.css`; FolderPalette carries its own CSS in its place.
- Collapse arrows on plain folders as well as BetterNotes. Setting, default **on**.
- Tree lines under all colored folders, in the folder's palette color. Setting, default **on**.

## Current state (from source; live-DOM numbers come in step 0)

| Layer | Role today |
|---|---|
| Obsidian core 1.13.7 (`%APPDATA%\obsidian\obsidian-1.13.7.asar`, not the 1.9.14 in Program Files) | `.tree-item-children`: 12px margin, 8px padding, **1px guide line already drawn** (`border-inline-start`). Row padding-left 24px (`--nav-item-padding`). Chevron `.tree-item-icon` is `position:absolute` at `-20px`, 16px wide, so it sits in the 24px gutter centered at 12px, directly over the guide line. `.collapse-icon.is-collapsed svg` rotates -90deg: down when open, right when closed, natively. |
| Minimal theme | Colors only (`--nav-indentation-guide-color`, `--nav-collapse-icon-color`). No nav layout rules. |
| `bruh.css` (enabled snippet) | `:173` hides every `.collapse-icon` in every tree pane. `:158` child indent 16px. `:72-82` file rows padding-left 8px (folders keep core's 24px). `:89-133` folder-open/closed and file glyphs via `::before` (`1em`, `margin-left:-1em`, `margin-right:6px`). `:44-63` top-level folder card (5px colored left border, outline). `:5-14`, `:28-42` palette + per-folder colors, already superseded by FolderPalette. |
| FolderPalette `src/css.ts` | Emits only `--folder-color` and `color` rules. No layout. |
| BetterNotes `styles.css:28-38` | `.betternote-icon` 16px + 8px margin (24px in flow) vs the snippet glyph's net 6px. |

Row geometry today, by the CSS math, from the row's left edge at one depth: file text at
~14px, plain-folder text at ~30px, BetterNote text at ~48px. Three different indents, and
the chevron cannot simply be un-hidden because the glyph occupies the gutter it lives in.

## Design

### 1. FolderPalette owns the explorer look (`styles.css`)

Port `bruh.css` into FolderPalette's `styles.css` as a new "Explorer look" section, every
selector prefixed with `body` so the rules beat Minimal's equal-specificity rules whatever
the stylesheet load order (the same trick `css.ts` already uses). Icons and outline colors
become namespaced variables on `body`:

    --fp-icon-file, --fp-icon-folder, --fp-icon-folder-open   (the three lucide data URIs)
    --fp-outline-color: #383838;  --fp-selected-outline-color: #8D8D8D;

Ported as-is: top-level folder card and active state (`:44-63`), title/file row typography
(`:65-82`), glyph masks (`:89-127`), container padding and root title (`:139-156`),
children indent (`:158`), transparent rows and active-row background (`:164-170`), flex
title contents (`:177-180`).

Dropped as dead:

- `--folder-color-1..10` and the twelve per-folder lines: FolderPalette's injected sheet does this.
- `transform: scale(1); transform-origin: left` on the card: a layout no-op.
- `.tree-item-self { margin-left: 0 }`, `.tree-item-inner { padding-left: 0 }`: core 1.13.7 sets neither, so both are no-ops (the step-1 CDP diff must confirm).
- `.nav-folder-title.nav-file-title::before` (Folder Notes plugin class; Folder Notes is disabled).
- `--ltr-icons` (unused).
- `:173` chevron hide: becomes the setting in section 3.

The original file is committed to this repo as `docs/legacy-bruh.css` for reference.

Acceptance: with the snippet disabled and FolderPalette deployed carrying only this port
(sections 2-4 not yet applied), the step-0 CDP dump of the explorer is identical to the
one taken before the change.

### 2. Unified row geometry

All explorer rows (`.nav-file-title` and `.nav-folder-title` inside `.nav-files-container`)
share one padding, `var(--size-2-2) var(--size-4-2) var(--size-2-2) var(--fp-row-indent)`
(today file rows are 8px tall-padded and folder rows 6px), and put the glyph in flow, after
the chevron gutter:

    --fp-row-indent: 20px;      /* row padding-left; core places the chevron at -20px, so it spans 0..16 */
    --fp-glyph-size: 1em;       /* published for BetterNotes */
    --fp-glyph-gap: 6px;        /* published for BetterNotes */
    --fp-children-margin: 7px;  /* .tree-item-children margin-inline-start: a 2px line at 7..9px centers on the chevron (8px) */
    --fp-children-indent: 12px; /* .tree-item-children padding-inline-start */

Resulting x positions at one depth: chevron 0..16 (center 8), glyph 20..33, text at 39,
for files, folders and BetterNotes alike. Rows without a chevron (files, childless
BetterNotes) leave the gutter empty so text still lines up. Each nesting level indents by
8 + 12 + the line width = 21px (22px with tree lines on). The vault-root title row keeps
its ported styling.

Acceptance: at every depth, `.nav-file-title-content` / `.nav-folder-title-content`
`getBoundingClientRect().left` is equal across a file, a plain folder and a BetterNote
sibling, and the chevron rect does not intersect the glyph box.

### 3. Collapse arrows setting

`showCollapseArrows: boolean`, default `true`. When false the plugin adds body class
`fp-arrows-off`, and `styles.css` carries:

    body.fp-arrows-off .nav-files-container .collapse-icon { display: none; }

Scoped to the file explorer. Outline, bookmarks and tags panes regain their native
chevrons; bruh.css hid them there only as collateral. Rotation, transition and
click-to-toggle are Obsidian core; nothing to implement.

### 4. Tree lines setting

`treeLines: boolean`, default `true`. When true the plugin adds body class `fp-tree-lines`.
The line color inherits the palette color through the whole subtree, because
`--folder-color` is set on the top-level `.nav-folder` and custom properties cascade:

    body.fp-tree-lines .nav-files-container {
      --fp-tree-line-color: var(--folder-color, var(--nav-indentation-guide-color));
    }
    body.fp-tree-lines .nav-files-container .nav-folder-children {
      border-inline-start: 2px solid var(--fp-tree-line-color);
    }
    /* elbow: from the vertical line into each child row */
    body.fp-tree-lines .nav-files-container .nav-folder-children > .tree-item > .tree-item-self::after {
      content: "";
      position: absolute;               /* .tree-item-self is position:relative in core */
      left: calc(-1 * (var(--fp-children-indent) + 2px));   /* starts on the vertical line */
      top: 50%;
      width: calc(var(--fp-children-indent) + 2px);         /* ends at the row's left edge */
      height: 2px;
      transform: translateY(-50%);
      background: var(--fp-tree-line-color);
      pointer-events: none;
    }

`::before` on rows is taken by the glyph, so the elbow uses `::after` (step 0 confirms
Minimal leaves `::after` free on these rows). The elbow stops at the row's left edge, so on
a folder row it meets the chevron gutter and on a file row it stops 20px short of the glyph;
extending file-row elbows to the glyph is a polish candidate, not v1. Uncolored trees fall
back to the theme's guide color. When the setting is off nothing is injected and core's 1px
theme-colored line stays, exactly as today.

If step 0 shows the top-level items nested inside `.nav-folder.mod-root > .nav-folder-children`
(rather than directly under `.mod-root`, as the shared top-level selector assumes), that
root container gets `border: none; margin: 0; padding: 0` so no line or elbow appears at the
vault root, and the top-level selector in `css.ts` is fixed in the same step.

Not in v1: stopping the vertical line at the last child (the "L"-corner look).

**Revision (2026-08-26, after Rob's first look, shipped as 0.2.4):** lines are thin
(1px), grey (`--text-faint`), rounded (5px), and fully connected. The container border
is kept but transparent (geometry unchanged); each child row's `::after` draws an "L"
(up 11px to the row above or the parent's open-chevron tip, across to the chevron
glyph's left edge, or on to the file/note glyph when the row has no chevron), and each
child wrapper's `::after` draws the vertical run to the next *visible* sibling only
(`:has(~ .tree-item:not(.betternote-hidden-note):not(.betternote-attachments-hidden))`),
so the last child ends in the rounded corner. Wrappers get `position: relative`. The
"L"-corner limitation above is therefore gone. Known edge: the virtual list only renders
rows near the viewport, so the last *rendered* child of a long folder momentarily looks
last until the rows below it render on scroll.

### 5. BetterNotes changes (`styles.css` only, version 1.3.0)

    .betternote-icon {
      width: var(--fp-glyph-size, 16px);
      height: var(--fp-glyph-size, 16px);
      margin-right: var(--fp-glyph-gap, var(--size-2-2));
    }
    .betternote-icon svg { width: 100%; height: 100%; }

    /* the original ask: a BetterNote with children always shows its chevron,
       even if FolderPalette's arrows toggle is off */
    body .betternote:not(.betternote-no-children) > .nav-folder-title > .nav-folder-collapse-indicator {
      display: flex;
    }

The existing no-children `visibility:hidden`, the global hide-children mode, and the
`::before` glyph suppression are unchanged. `patch.ts` needs no change: it intercepts
clicks on the title text only, so chevron clicks already fall through to core's toggle.

### 6. Vault changes

- `appearance.json`: `enabledCssSnippets: []`, written as a staged file + robocopy while
  Obsidian is stopped (Controlled Folder Access blocks direct writes; see the deploy notes).
- `bruh.css` stays on disk as the rollback until Rob signs off, then is deleted with
  robocopy `/MIR` from an empty staging dir into `snippets/` (the only file there).

## Settings surface

FolderPalette settings tab gains an "Explorer" heading with two toggles: "Show collapse
arrows" and "Tree lines". `normalizeSettings` defaults both to `true` when missing;
`settings.test.ts` covers missing and malformed values. Manifest description becomes
"Explorer look: folder colors, icons, collapse arrows and tree lines."

## Verification

- **Step 0, live DOM snapshot.** Restart Obsidian with `--remote-debugging-port=9222`
  (scrub the psmux env vars), reuse the `cdp.js` harness, run an `explorerdump.js` that
  records for every `.nav-files-container .tree-item`: path, kind (file / folder /
  betternote), depth, title-content `left`, chevron rect and computed `display`, computed
  `::before` width and margins, `::after` content, and the children container's computed
  margin / padding / border. Also records the counts for
  `.nav-files-container > div > .nav-folder` versus
  `.nav-folder.mod-root > .nav-folder-children > .nav-folder`. Saved as `before.json`.
- **After step 1** (port, toggles off): dump diff against `before.json` is empty.
- **After step 2**: the alignment assertions in section 2, checked by script.
- **After steps 3-4**: chevron visible and `is-collapsed` flips on a real click
  (`Input.dispatchMouseEvent`); elbows report a computed `::after` width; line color equals
  the folder's palette hex.
- **Unit:** vitest for settings normalization; existing `css.test.ts` unchanged.
- **Human:** Rob eyeballs the sidebar after each deploy.

## Sequence

Every deploy bumps the manifest patch version (0.2.0, 0.2.1, ...) so the reload can be
verified; the version that ships everything is whatever step 4 lands on.

0. Live DOM snapshot (`before.json`). Requires killing Obsidian (it hides in the tray).
1. Port `bruh.css` into FolderPalette `styles.css` (section 1 only); commit
   `docs/legacy-bruh.css`; disable the snippet; deploy; diff == identical.
2. Unified row geometry (section 2); deploy; alignment check.
3. BetterNotes 1.3.0 (section 5); deploy.
4. Arrows + tree-lines settings, body classes, CSS, tests (sections 3-4); deploy with both
   on; CDP checks.
5. READMEs, Rob's sign-off, delete `bruh.css`, update memory notes.

## Out of scope

- Custom icon picker, per-folder line styles, the last-child "L" corner.
- Coloring nested folders (FolderPalette stays top-level only).
- Editing the Minimal theme.

## Rollback

Re-enable the snippet in Settings -> Appearance and redeploy FolderPalette 0.1.0 from git
tag / commit 943e064. BetterNotes 1.3.0 degrades gracefully without FolderPalette because
every variable it reads has a fallback.
