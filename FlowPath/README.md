# FlowPath

Clickable flow charts of options for Obsidian. You start at a node, see what you can do next, click one, and keep going. Each node can link to a note, and a link to any node can live inside any note.

I built it for playbooks. A pentest path like "Recon, Initial Access, Enumerate identities and roles, Escalate privileges, Move laterally, Persistence" is not a straight line: at every step there are several things to try, and each of those has its own next steps. A bulleted list flattens that, and a canvas makes you do the layout by hand. FlowPath keeps the options as real structure and lets me move around in it.

## the .flowpath file

A chart is one `.flowpath` file, plain JSON. Click it in the file explorer and it opens as a chart. It holds a stable chart id, the start node, the nodes (title, short description, linked note, colour, done flag) and the edges between them, in option order.

Node links point at the chart id and node id, not at the file name, so renaming or moving a chart never breaks a link in a note. Cycles are allowed, because a real playbook loops back.

If a `.flowpath` file ever fails to parse (say you hand-edited it), FlowPath shows a notice and treats it as read-only. It will not overwrite a file it couldn't read. Fix the JSON and it picks the change up.

## the four views

Same chart, different ways to look at it. Switch with the buttons in the toolbar or `Alt+1` to `Alt+4`.

- **Map**: the whole chart as a diagram. Pan, zoom, collapse branches, switch between top-down and left-right.
- **Focus**: one node at a time, with its description, a preview of its note and its options as big buttons. This is the one for actually following a path.
- **Outline**: an expandable tree.
- **Columns**: a Miller-columns browser, like Finder. Pick an option and the next column opens to its right.

The toolbar shows a clickable breadcrumb from the start node to where you are, plus back and forward. Zoom out by clicking a crumb, work down by clicking options.

## separate window and node links

By default a chart opens in its own pop-out window, so the note you're reading stays where it is. Opening a node opens (or reuses) that window and lands on the node. A node's linked note always opens in the main window, never inside the chart window. To get a normal tab instead, right-click and pick "Open in new tab" (see right-click menus below), or turn off the "Open charts in a separate window" setting.

Every node has "Copy link to node". The link is a normal markdown link whose target is `obsidian://flowpath?...`, and in a note it renders as a small chip. Click it, in reading view or live preview, and the chart window jumps to that node. From there you can zoom out or work your way down.

Wikilinks work too: `[[Attack Path.flowpath#Initial Access]]` opens the chart on that node (by title or by id).

## embeds

Put a chart inside a note with a code block:

````
```flowpath
chart: Attack Path
node: Initial Access
view: focus
height: 420
```
````

- `chart`: file path, file name, or link path. `.flowpath` is optional.
- `node`: optional node id or title to start on. Default is the start node.
- `view`: `map`, `focus`, `outline` or `columns`. Default `map`.
- `height`: pixels, default 420.

The embed is live and clickable, has its own view switcher, and updates when the chart changes anywhere else. The button in its header opens the chart in the window at the node you're on.

## BetterNotes integration

Nodes link to notes, and I use [BetterNotes](../BetterNotes/README.md) (a folder `X/` holding `X/X.md`) for mine.

- **Create BetterNote for this node**: makes `X/X.md` under the BetterNote of the node's parent, so the folders nest like the chart. The first line is a small callout linking back to the node. If a note with that path already exists it is linked, never overwritten.
- **Create BetterNotes for all nodes**: does that for every node without a note, top down. A notice reports created, linked and skipped.
- **Build flow chart from this BetterNote**: the reverse. The BetterNote becomes the root, sub-BetterNotes become nodes (recursively), plain notes in the folder become leaf nodes. `Attachments` folders are skipped.

The backlink callout is hidden from node previews.

FlowPath never deletes notes. Deleting a node only removes it from the chart.

## commands

- New flow chart…
- New flow chart from selected list: turns a nested list into a chart, either as steps in order or as options, and drops an embed under the list. The list itself is untouched.
- Insert link to flow node
- Embed flow chart
- Open flow chart (also the ribbon icon)
- Build flow chart from this BetterNote

## right-click menus

"Open in new tab" puts the chart in a normal tab of the main Obsidian window. "Open in separate window" uses the pop-out window. Both are on:

- a `.flowpath` file in the file explorer, and its folder ("Open flow chart in new tab")
- a node link in a note, in reading view or while editing ("Open flow node in new tab")
- a node, or empty space in the chart
- the header bar of an embedded chart
- the toolbar's ⋯ menu

Inside a pop-out window only "Open in new tab" is offered, and it opens the chart back in the main window.

Right-click in a note for "Link to a flow node…". Right-click (or the context menu) on a node for add option, connect to an existing node, rename, description, arrow label, link/unlink note, done, colour, move up/down, set as start, copy link or embed, remove from parent, and delete.

## keyboard shortcuts

In the chart window:

| key | does |
| --- | --- |
| `Alt+Left` / `Alt+Right` | back / forward |
| `Alt+1` to `Alt+4` | Map, Focus, Outline, Columns |

Inside a view (click it first so it has focus):

| key | does |
| --- | --- |
| `Backspace` or `u` | go to parent |
| `1` to `9` | pick that option |
| `Enter` | open the node's note |
| `a` | add an option |
| `F2` | rename |
| `x` | toggle done |
| `f` | fit the map |
| `c` | center on the current node |

Arrow keys move around in the map and outline.

## settings

- Open charts in a separate window (on)
- Pop-out width and height (1200 x 800)
- Default view for charts you haven't opened (map)
- Default map direction (top to bottom)
- Show "Open in window" in embeds (on)

Pan, zoom, collapsed branches, direction and the last view are remembered per chart.

## build & deploy

    npm install
    npm run build
    npx vitest run

Copy `main.js`, `manifest.json` and `styles.css` into the vault's `.obsidian/plugins/flowpath` folder, then turn FlowPath off and on under Settings → Community plugins.
