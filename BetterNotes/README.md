# BetterNotes

Notion-style notes for Obsidian. A note can contain things: attachments, sub-notes, whole trees of them. The folders still exist on disk, but you stop looking at them.

## why not just Folder Notes

I ran the "Folder notes" community plugin for a while, and it does what it says. But what it says is folder-first: you make a folder, and the plugin makes clicking that folder open a note. The folder is still the unit you think in. Every time I wanted a note that holds things, the ritual was create folder, create note inside, name them the same, and let pasted images land in some global attachments directory on the other side of the vault.

Notion never asks for any of that. A page is a page. Sub-pages go in it, files go in it, and the sidebar shows pages. That is the model I wanted in Obsidian, and it is why this plugin exists instead of a settings tweak.

BetterNotes keeps the exact on-disk convention Folder Notes uses (a folder `X/` with `X/X.md` inside), so an existing vault of folder notes is recognized with zero migration. Then it covers ground Folder Notes doesn't touch:

- `Ctrl+N` creates the whole unit in one keystroke, with the title ready to type over.
- Attachments pasted into the note are stored inside it, in a hidden `Attachments/` subfolder, and shown in a bar at the bottom of the note.
- Renames sync both ways between note and folder.
- A command generates a linked table of contents of every sub-note, nested.
- Flatten goes the other direction: a BetterNote can be turned back into a plain note.

Folder Notes has things this doesn't: canvas folder notes, the folder-overview code block, per-folder exclusion lists. If you rely on those, keep it. For me they were never the point, and running both plugins at once will fight over the explorer, so pick one.

## what counts as a BetterNote

A folder plus a same-named markdown note inside it, treated as one unit:

```
ON DISK                              IN THE FILE EXPLORER
Vault/                               Vault/
├── Projects/                        ├── 📄 Projects        ▸
│   ├── Projects.md      ◄─hidden──  ├── 📄 Daily Log
│   ├── mockup.png                   └── 📁 Old Stuff
│   └── Website Redesign/
│       ├── Website Redesign.md
│       └── screenshot.png
├── Daily Log.md
└── Old Stuff/
```

No index file, no frontmatter marker, no plugin database. Delete the inner note and the folder is a plain folder again. Move the note out and both halves go back to normal. The pairing is the naming convention and nothing else.

## the three features that carry the plugin

### the explorer shows notes, not folders

A BetterNote's row gets a note icon and loses the folder styling, and the inner `X/X.md` row is hidden so the unit appears once. Clicking the name opens the note. `Ctrl+click` opens it in a new tab. The chevron toggles the children underneath (down when open, right when closed) and never opens the note; it stays visible even if your explorer theme hides chevrons on plain folders, and if there are no children it disappears entirely, so an empty BetterNote is indistinguishable from a plain note. The note icon sizes itself from FolderPalette's --fp-glyph-size / --fp-glyph-gap variables when that plugin is present, so a BetterNote's title lines up exactly with sibling folders and files. Themes that paint their own folder icons are suppressed on these rows, and if your CSS assigns per-folder colors via `--folder-color`, the note icon picks the color up.

There is also a global switch: the command "Toggle BetterNote children visibility" hides every subtree at once, which makes the whole vault read as a flat list of notes when you want the quiet version.

### Ctrl+N makes a BetterNote

By default the plugin unbinds the core "Create new note" hotkey and takes `Ctrl+N` for itself. That is deliberate. If creating a containing note costs more keystrokes than creating a bare one, you fall back to bare notes and the model never sticks. `Ctrl+N` creates `Untitled/Untitled.md`, opens it, and puts the cursor in the title; typing a name renames the folder along with it. Where it lands follows the core "Default location for new notes" setting, so with that set to "same folder as current file", pressing `Ctrl+N` inside a BetterNote nests the new one inside it. Right-clicking any folder offers "New BetterNote inside" when you want to aim explicitly.

Turn off "Take over Ctrl+N" in settings to get the stock binding back. If Obsidian's internal hotkey manager ever changes shape and the takeover fails, the plugin tells you in a notice instead of silently colliding.

### attachments live inside the note

Anything pasted or dragged into a BetterNote is saved to an `Attachments/` subfolder inside it, created on demand. The first release saved them loose in the folder root, and that turned out to be a mistake: three screenshots in, the children list was mostly clutter. So since 1.2 the subfolder is hidden from the explorer and from the chevron logic. To see it for one note, right-click the note or its explorer row and pick "Show attachments folder", or press `Ctrl+Shift+A` while the note is open. The reveal is per-BetterNote, the state persists across restarts, and it follows the note through renames and moves.

You rarely need to reveal it, though, because the note itself shows an attachments bar along the bottom: image thumbnails (8 formats), icons for audio, video, PDF and everything else, click to open in a new tab, hover for Obsidian's native preview. Files still sitting in a BetterNote's root from before 1.2 show up in the bar too, so nothing silently disappears. The bar collapses to a one-line header with a count.

## the rest

Rename sync is two-way and loop-guarded: rename the note and the folder follows, rename the folder and the note follows, and moving a BetterNote into another one keeps the pair intact. If a rename would collide with something that already exists, the pair splits into a plain note and folder rather than overwriting anything.

`Ctrl+Shift+T` inside a BetterNote inserts a table of contents of its sub-notes: a bulleted list of links, indented four spaces per nesting level, siblings alphabetical. The list sits between two `%%` comment markers that are invisible in reading mode. It is a static block, not a live query; run the command again and it refreshes in place wherever it sits in the note.

Converting goes in every direction. Right-click a plain note for "Convert to BetterNote" (also in the command palette); if a plain folder with the same name already sits next to the note, the note moves into it instead of creating "Name 1". Right-click a plain folder for "Turn into BetterNote". Right-click a BetterNote for "Flatten to plain note", which moves the note out beside the folder and sends the folder to the trash only if the note was the last thing in it. Trashing respects your "Deleted files" setting.

Disabling the plugin removes every decoration, restores the stock `Ctrl+N`, and leaves the vault exactly as the folders-and-files it always was.

## hotkeys

| Keybind | Command |
|---|---|
| `Ctrl+N` | New BetterNote (replaces the core "Create new note" while takeover is on) |
| `Ctrl+Shift+A` | Toggle the `Attachments/` folder in the explorer, for the BetterNote you are in only |
| `Ctrl+Shift+T` | Insert or refresh the sub-note table of contents |

All three are rebindable in Settings → Hotkeys. "Toggle BetterNote children visibility" and "Convert current note to BetterNote" are in the command palette with no default binding.

## settings

| Setting | Default |
|---|---|
| Take over Ctrl+N | on |
| Show BetterNote children | on |
| Attachments bar | on |
| Collapse attachments bar by default | on |

## what it doesn't do

Markdown notes only; a canvas named after its folder is just a file in a folder. The attachments bar's collapsed state is one global setting, so collapsing it in one note collapses it everywhere, which is arguably wrong and may become per-note later. The explorer integration decorates Obsidian's file-explorer DOM and the `Ctrl+N` takeover goes through an internal hotkey API, neither of which is a public interface, so a future Obsidian release could break either one; unloading the plugin always restores stock behavior. And nothing here has been tested on mobile.

## building

The whole plugin is about 850 lines of TypeScript across six source files. The path logic (pairing, rename sync, convert and flatten plans, the TOC) is pure functions with no Obsidian imports, covered by the vitest suite.

```
npm install
npm run build        # produces main.js
npm test             # unit tests (vitest)
npm run deploy:test  # copies the plugin into test-vault/
```

## installing

Copy `manifest.json`, `main.js`, and `styles.css` into `<your vault>/.obsidian/plugins/betternotes/`, then enable BetterNotes in Settings → Community plugins. Disable "Folder notes" first if you run it; the two overlap on the same convention.
