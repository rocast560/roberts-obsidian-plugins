# Manual test checklist (run in test-vault, then spot-check in SyncedMain)

- [ ] Explorer: `Projects` shows note icon, no separate `Projects.md` row
- [ ] Click `Projects` name → note opens; chevron → children expand/collapse
- [ ] `Website Redesign` nested betternote renders and opens the same way
- [ ] Betternote with no extra children shows no chevron
- [ ] Command "Toggle BetterNote children visibility" hides/shows all children + chevrons
- [ ] Ctrl+N creates `Untitled/Untitled.md`, opens it, title focused; typing a name renames folder too
- [ ] Rename note via F2/inline title → folder follows; rename folder in explorer → note follows
- [ ] Drag betternote folder into another betternote → nests, pairing intact
- [ ] Paste image into a betternote → lands in its `Attachments/` subfolder (created on demand); attachments bar appears with thumbnail
- [ ] `Attachments/` folder is NOT visible in the explorer by default (chevron ignores it — a betternote with only hidden attachments shows no chevron)
- [ ] Ctrl+Shift+A while in the note toggles the `Attachments/` folder in the explorer; right-click note or betternote → "Show/Hide attachments folder" does the same
- [ ] Visibility state survives renaming/moving the betternote
- [ ] Click attachment → opens in new tab; hover → preview popup (for previewable types)
- [ ] Collapse/expand attachments bar; state persists across notes
- [ ] Right-click plain note → Convert to BetterNote works (incl. merge-into-existing-folder case)
- [ ] Right-click betternote → Flatten works; empty folder removed, links intact
- [ ] Right-click plain folder → Turn into BetterNote creates inner note
- [ ] Disable plugin → explorer back to stock (folder rows, note visible, no bar), Ctrl+N restored
