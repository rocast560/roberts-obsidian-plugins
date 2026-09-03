# BetterNotes — Design Spec

**Date:** 2026-08-15
**Status:** Approved by user (decisions: full Ctrl+N takeover, attachments in folder root, chevron shows everything)

## Purpose

An Obsidian plugin that replaces the "Folder notes" community plugin with a Notion-style model: instead of *folders that happen to have notes*, BetterNotes presents *notes that contain things*. A **BetterNote** is a folder + same-named markdown note treated as a single unit that looks and behaves like a note in the file explorer, can hold attachments and nested BetterNotes, and exposes its children through a collapse chevron.

## Core model

- A folder `X/` containing a note `X/X.md` is a BetterNote. This matches the user's existing Folder Notes convention (`folderNoteName: {{folder_name}}`, `storageLocation: insideFolder`), so existing folder notes are recognized with zero migration.
- Markdown notes only in v1 (no canvas/base folder notes).
- Nesting is free by construction: a BetterNote's folder may contain more BetterNotes, recursively.

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

## Features

### 1. File explorer presentation (explorer patch)

- BetterNote folder rows are restyled to look like notes: note icon, no folder underline requirement, CSS class `betternote`.
- The inner `X/X.md` row is hidden (`display:none` via class on the file item).
- Clicking the row title opens `X/X.md`. The chevron (collapse arrow) toggles visibility of children and never opens the note.
- Chevron shows **everything**: attachments and nested BetterNotes/folders alike (user decision 3a).
- If a BetterNote has no children besides its own note, the chevron is hidden — it looks exactly like a plain note.
- Global command **"BetterNotes: Toggle children visibility"** + setting: when off, all BetterNote children are hidden entirely and chevrons don't show, so BetterNotes read as flat notes.
- Implementation: patch the file explorer view (decorate DOM on `vault` events + explorer render), capture-phase click handler on folder title elements. No monkey-patching of internal render methods more than necessary; re-decoration is idempotent.

### 2. Attachments

- **Storage:** attachments pasted/dragged into a BetterNote save into the BetterNote's folder root, next to the note (user decision 2a). Implemented by overriding `Vault.getAvailablePathForAttachments` (wrap; fall back to default behavior for non-BetterNotes).
- **Attachments bar:** rendered at the bottom of the note view (reading + live preview) for BetterNotes. Shows every non-markdown file in the folder (non-recursive): images as thumbnails, other types with a file-type icon + name.
  - Click → open in a new tab. Hover → Obsidian native page preview where supported.
  - Collapsible; header shows `📎 Attachments (N)`.
  - Auto-refreshes on vault create/delete/rename events under that folder.

### 3. Creation & keybind

- Command **"BetterNotes: New BetterNote"**, default hotkey **Ctrl+N**.
- **Full takeover (user decision 1a):** on load, if the takeover setting is on (default on), the core `file-explorer:new-file` / `workspace:new-file`-equivalent Ctrl+N binding is unbound via `app.hotkeyManager` so there is no conflict. Toggling the setting off restores the core binding. If the internal API is unavailable, degrade gracefully: register the hotkey anyway and surface a notice pointing at Hotkeys settings.
- New BetterNote is created as `Untitled/Untitled.md` in the location given by the core "Default location for new notes" setting (root / current folder / specified folder). If invoked from a context menu on a BetterNote or with a BetterNote active, it nests inside that BetterNote's folder.
- After creation the note opens and inline rename (title edit) is triggered.
- Context menu items:
  - On a folder or BetterNote: **"New BetterNote inside"**.
  - Vault root (file explorer background/ribbon command available too).

### 4. Rename / delete / move sync

- Renaming the note renames the folder, and vice versa (two-way sync, loop-guarded).
- Deleting the BetterNote folder deletes the unit (folder delete already includes the note; follow the user's trash settings).
- Deleting the inner note only → folder reverts to a plain folder (unpaired) and explorer decoration is removed.
- Moving the inner note out of its folder → unpairs cleanly, both items become normal.

### 5. Convert / flatten

- Context menu on a plain note: **"Convert to BetterNote"** → create sibling folder named after the note, move the note inside.
- Context menu on a BetterNote: **"Flatten to plain note"** → move the note out beside the folder; delete the folder if now empty, else leave it as a plain folder.
- Context menu on a plain folder: **"Create BetterNote"** → create `X/X.md` (matches Folder Notes' create affordance).

## Architecture

```
BetterNotes/
├── manifest.json
├── styles.css               explorer restyling + attachments bar
├── esbuild.config.mjs       build → main.js
└── src/
    ├── main.ts              plugin entry, commands, keybind takeover, event wiring
    ├── settings.ts          settings tab + defaults
    ├── core/pairing.ts      pure logic: betternote detection, path math for
    │                        create/convert/flatten/rename-sync (unit-testable)
    ├── explorer/patch.ts    file-explorer decoration, click interception,
    │                        chevron/children visibility
    └── view/attachments.ts  attachments bar in markdown views
```

Data flow: vault events (create/rename/delete) → `pairing` computes required sync operations → `main` executes them → `explorer/patch` re-decorates → `attachments` view refreshes for the open note.

`core/pairing.ts` is pure (no Obsidian imports beyond types) so it can be unit-tested with vitest against a fake file tree.

## Settings (v1)

| Setting | Default |
|---|---|
| Take over Ctrl+N | on |
| Show BetterNote children (global) | on |
| Attachments bar | on |
| Attachments bar collapsed by default | off |
| Delete action honors Obsidian trash setting | always |

## Error handling

- Name collisions on create/convert/rename (target exists) → suffix ` 1`, ` 2`, … like core Obsidian.
- Rename-sync loop guard: ignore vault events generated by our own rename operations.
- Explorer patch must be resilient to Obsidian re-rendering the tree (decoration is re-applied on `layout-change`, vault events, and explorer reveal); unload fully restores stock behavior.

## Testing

- Unit tests (vitest): `core/pairing.ts` — detection, create paths, convert/flatten plans, rename-sync targets, collision suffixing, unpair conditions.
- Manual test checklist in the test vault (`test-vault/` in repo): explorer visuals, click/chevron behavior, Ctrl+N, attachments paste + bar, nesting 3 deep, rename both directions, flatten, plugin unload restores stock explorer.

## Deployment (this machine)

1. Back up the vault `C:\Users\rober\Documents\SyncedMain` (full copy, includes current `folder-notes` plugin + its `data.json`) to a timestamped zip/folder before any change.
2. Build and copy `manifest.json`, `main.js`, `styles.css` into `SyncedMain\.obsidian\plugins\betternotes\`.
3. Disable `folder-notes` and enable `betternotes` in `community-plugins.json` (edit while Obsidian is closed, or instruct a restart).

## Amendment (2026-08-15, post-v1.0 user request)

Attachment storage changed from folder root (original decision 2a) to a hidden `Attachments/` subfolder inside each BetterNote, created on demand when an attachment is saved. The subfolder is hidden in the file explorer by default and excluded from the chevron/children logic while hidden. Visibility is toggled **per BetterNote** via the note's or the folder's context menu ("Show/Hide attachments folder") or the command "Toggle attachments folder visibility" (default hotkey Ctrl+Shift+A, active while an inner note is open). Visibility state persists in plugin settings and follows the BetterNote through renames/moves. The attachments bar reads from `Attachments/` plus any legacy files in the folder root.

## Out of scope (v1)

Canvas/base folder notes, folder-overview code block, per-folder exclusion lists, mobile-specific UI, Style Settings integration.
