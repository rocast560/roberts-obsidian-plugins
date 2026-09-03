# ImageGrip — Design Spec (2026-08-20)

## Purpose

Obsidian plugin for the SyncedMain vault. Two features, both in **Live Preview only**:

1. **Resize by dragging corner handles.** Click an image embed to select it; drag any
   of four corner handles to resize proportionally. On release, the new width is
   written into the markdown link so the size persists and syncs across devices.
2. **Copy with Ctrl+C.** While an image is selected, Ctrl+C puts the actual image
   (PNG bitmap) on the system clipboard, pasteable into external apps.

Plugin id: `image-grip`. Folder: `ImageGrip`. Reading mode is out of scope: it
displays whatever size is saved in the link, with no handles.

## Approach

DOM overlay via event delegation — no CodeMirror decorations, no patching of
Obsidian's embed widgets. A plugin-level click listener (registered with
`registerDomEvent`) catches clicks on `img` elements inside the Live Preview editor.
Selection and handles are absolutely-positioned overlay elements. On drag release,
`EditorView.posAtDOM(img)` maps the image element back to a document position; the
embed's source text is located around that position and rewritten.

Rejected alternative: CM6 widget decorations wrapping Obsidian's internal embed
widgets — fragile across Obsidian versions for no user-visible gain.

## Components

Same toolchain as BetterNotes: TypeScript, esbuild bundle to `main.js`, vitest.

- **`src/main.ts`** — plugin entry. Registers: click listener (select/deselect),
  `copy` event listener, Escape keydown, workspace `active-leaf-change` (deselect on
  leaf switch). Owns the single `SelectionController` instance.
- **`src/resize.ts`** — `SelectionController`: tracks the currently selected `img`
  (at most one), renders the outline + 4 corner handles as an overlay div appended to
  the embed container, implements drag (pointer events, pointer capture).
  Corner drag is proportional; only width is tracked. Minimum width 40px. During drag
  the img's `width` attribute/style updates live; on pointerup the link rewrite runs.
- **`src/linkRewrite.ts`** — pure, unit-tested functions:
  - `findEmbedAt(lineText, ch)` — locate the embed source span (`![[...]]` or
    `![...](...)`) covering a character offset.
  - `rewriteWidth(embedText, width)` — return the embed with the width applied:
    - Wiki: `![[photo.png]]` → `![[photo.png|420]]`. If the **last** pipe segment is
      a size (`\d+` or `\d+x\d+`), replace it; otherwise append. Alt/caption
      segments are preserved: `![[photo.png|caption|300]]` → `![[photo.png|caption|420]]`.
    - Markdown: `![alt](path)` → `![alt|420](path)`, same last-segment-of-alt rule.
      Height (`WxH`) collapses to width-only on rewrite (aspect is preserved by the
      renderer).
- **`src/copy.ts`** — `copyImage(img)`: draw to canvas at natural resolution,
  `canvas.toBlob('image/png')`, `navigator.clipboard.write([ClipboardItem])`.
  Success → Notice "Image copied". Tainted canvas (CORS, remote images) or clipboard
  failure → Notice explaining the image couldn't be copied.
- **`styles.css`** — selection outline (accent color via `var(--interactive-accent)`),
  corner handle squares, cursor styles.

## Data flow (resize)

```
click img → SelectionController.select(img) → overlay rendered
drag handle → pointermove: img.style width updated live (proportional)
pointerup   → posAtDOM(img) → editor line text → findEmbedAt → rewriteWidth
            → editor.replaceRange (single transaction)
```

Live Preview re-renders the embed from the new source; the overlay re-attaches to the
re-rendered img (re-select by resolved src within the same embed container, else
deselect cleanly).

## Error handling

- **Source not found / unparseable on pointerup**: revert the DOM width to the
  pre-drag value, deselect, show a Notice. The markdown is never left half-edited.
- **Editor/leaf changed mid-drag**: cancel the drag, no write.
- **Copy failure**: Notice only; never throws.
- Deselect on: click elsewhere, Escape, leaf change, file switch, layout change.

## Ctrl+C mechanics

Listen for the DOM `copy` event on the document (capture). If an image is selected
and the editor has no text selection, `preventDefault()` and run `copyImage`.
This sidesteps the Obsidian capture-phase hotkey-manager issue — `copy` fires
regardless of keydown handling. Cmd/Ctrl both covered for free.

## Testing

- **vitest**: `linkRewrite.ts` exhaustively — wiki + markdown syntax, no size,
  existing size, `WxH`, caption/alt segments, multiple embeds on one line,
  embed at line start/end, non-embed text around it.
- **Manual in vault**: drag feel, handle rendering, clipboard paste into an external
  app, Reading-mode display of saved sizes. Deploy via robocopy `/E` (never `/MIR`)
  to `C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\image-grip`, bump
  `manifest.json` version, tray-kill restart Obsidian.

## Out of scope (YAGNI)

Reading-mode handles, height-only sizing, free (non-proportional) resize, mobile
touch support (desktop-focused; `isDesktopOnly: false` kept since nothing Electron-
specific is used), settings tab (no options needed v1), community registry submission.
