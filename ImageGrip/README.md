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

## How the handles are hosted (and why)

The corner handles live in an overlay appended to `<body>` (`position: fixed`),
anchored to the image's viewport rect and re-anchored on scroll/resize/image
resize. They are deliberately **not** inserted into the embed because, with
Obsidian 1.13 + the Minimal theme:

- pressing anything inside `.image-embed` makes it `:active`, which Minimal
  uses for click-and-hold zoom (the embed goes fullscreen-fixed and the `<img>`
  measures 0x0 mid-press). That is also why Obsidian's *own* resize corner can
  write `|0` into a link under Minimal — it reads the image size during the
  press. Minimal's Style Settings has a "Disable image zoom" toggle if you want
  the native corner to work too.
- Obsidian's native 30x30 `.image-resize-corner` (z-index 1) covers the
  bottom-right of the embed, and handles that overhang the embed are painted
  over by the next `.cm-line`.

Click resolution also accepts the embed container as the click target
(`src/clickTarget.ts`), since under Minimal the pointerup lands on the
container rather than the `<img>`.

## Known limits

- Live Preview only (by design).
- Markdown-embed paths containing `)` and wiki targets containing `]` are not parsed.
- Remote images whose host blocks CORS can't be copied (tainted canvas) — you get
  an explanatory notice instead.
