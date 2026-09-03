# RobTerminal

A real terminal inside Obsidian. Genuine Windows ConPTY via node-pty, rendered with
xterm.js — so PSReadLine, psmux, Claude Code, vim and `git rebase -i` all just work.

Splits beneath the current note, opens from any right-clicked folder, and can run
elevated **in a pane**.

---

## Install

The plugin ships a native module and vendored bundles, so it must be copied whole —
`main.js` alone is not enough.

```powershell
robocopy "C:\Users\rober\Desktop\ObsidianCustomPlugins\RobTerminal" `
         "C:\Users\rober\Documents\SyncedMain\.obsidian\plugins\rob-terminal" `
         /E /XD .git /NFL /NDL /NJH /NJS
```

Use `/E`, **not** `/MIR` — a mirror would delete `data.json`, which holds the plugin's
saved settings. Use robocopy rather than `Copy-Item`: Controlled Folder Access protects
`Documents` on this machine and blocks other writers.

Then reload the plugin. Obsidian **closes to the tray** — closing the window does not
restart it, and the old `main.js` stays in memory until an actual reload. Either toggle
RobTerminal off/on under **Settings → Community plugins**, run
`Ctrl+P → "Reload app without saving"`, or fully quit from the tray and relaunch.
Verify by checking the version number under Community plugins.

**Requires Node.js on PATH.** The PTY host runs under it. You have v24.15.0. If Node
ever goes missing the plugin falls back to Obsidian's own runtime, which usually works
but is less reliable — the setting is under *Node runtime*.

---

## Using it

`Ctrl+Alt+` \` splits a terminal beneath the current note, in that note's folder.
Right-click any folder → **Launch terminal** → split, tab, admin, or a specific shell.

Every key you press goes to the shell. `Ctrl+C` interrupts for real, `Ctrl+B` is psmux's
prefix, `Ctrl+R` is history search, `Ctrl+P`/`Ctrl+B` never reach Obsidian's command
palette or bold. Plugin actions live on `Ctrl+Shift+*` so they can't collide.

Making that true took three distinct fixes — a keyboard scope against Obsidian's
capture-phase hotkey handler, an environment scrub so psmux agrees to start, and a
two-sided clear for `Ctrl+L`. They are documented in
[Why keys used to vanish](#why-keys-used-to-vanish--the-v21x-fixes) below.

### Global

| Key | Action |
| --- | --- |
| `Ctrl+Alt+` \` | Terminal below the current note |
| `Ctrl+Alt+Shift+` \` | Terminal at the vault root |
| `Ctrl+Alt+A` | **Administrator terminal in a pane** (UAC) |
| `Ctrl+Alt+T` | Focus the terminal |
| `Ctrl+Alt+E` | External console window |
| `Ctrl+Alt+R` | Restart the active terminal |

### Inside a terminal

| Key | Action |
| --- | --- |
| `Ctrl+B`, `<key>` | psmux chord — second key bypasses all plugin shortcuts |
| `Ctrl+L` | Clear output and scrollback (alt-screen apps keep it as redraw) |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste |
| `Ctrl+Shift+F` | Find in scrollback |
| `Ctrl+Shift+R` | Restart this terminal |
| `Ctrl+Shift+N` | New terminal in the same directory |
| everything else | goes to the shell |

Each detected shell also gets its own command, so you can bind one key straight to
psmux. Rebind anything under **Settings → Hotkeys**, search "RobTerminal".

Detected on this machine: Windows PowerShell, psmux, Command Prompt, Git Bash, WSL.

---

## Why keys used to vanish — the v2.1.x fixes

Three separate bugs stacked on top of each other made it look like "psmux keybinds
don't work and Ctrl+L does nothing". Each was found by testing one layer at a time
with the layer above removed; all three are fixed as of **v2.1.2**.

### 1. Obsidian steals keys in the capture phase (v2.1.2) — the big one

Obsidian's hotkey manager registers `window.addEventListener("keydown", …, true)` —
on the **window**, in the **capture phase**. Capture listeners run before any element
handler, so Obsidian saw every keystroke before xterm.js did. `Ctrl+B` matched its
default *toggle bold* hotkey and `Ctrl+L` matched *toggle checkbox status*; both were
handled and cancelled at the window, and the terminal never received them. The next
key (`c`) has no global hotkey, so it passed through and was typed into the pane —
the classic symptom: *prefix does nothing, then it just types c*.

No amount of `stopPropagation` in the terminal can fix this — bubble-phase handlers
run after the damage is done. The fix uses Obsidian's own mechanism: while a terminal
pane has keyboard focus the plugin **pushes a `Scope` onto `app.keymap`** (the same
thing Obsidian's modals do), which suppresses all global hotkeys. RobTerminal's own
launch bindings are re-registered inside that scope — resolved through
`hotkeyManager` so custom hotkeys from Settings → Hotkeys are honored — and the scope
is popped the moment focus leaves the terminal. Focus is tracked per-view with
`focusin`/`focusout` on the pane, so split panes and popout windows all work.

Trade-off, by design: while typing in a terminal, Obsidian-wide chords like `Ctrl+P`
go to the shell, not the command palette. Click into a note and everything is normal.

### 2. psmux refused to start: inherited nesting markers (v2.1.1)

Typing `psmux` in a pane printed `sessions should be nested with care, unset
PSMUX_SESSION to force` and dropped straight back to the prompt — easy to miss, and
from then on every "psmux keybind" was really being typed at PSReadLine. The cause:
this machine's session chain runs inside a psmux warm session, so Obsidian inherited
`PSMUX_SESSION`, `TMUX`, and `TMUX_PANE`, and psmux's tmux-style nesting guard
refused to launch. A pane in Obsidian is never genuinely nested, so the PTY host now
scrubs `PSMUX_SESSION`, `PSMUX_TARGET_SESSION`, `PSMUX_PANE`, `TMUX`, and `TMUX_PANE`
before spawning any shell.

### 3. Ctrl+L cleared only half the terminal (v2.1.0)

`Ctrl+L` clears the xterm screen **and scrollback** (a plain `term.clear()` would
desync ConPTY, which keeps its own screen model and would repaint at the stale cursor
row — so the plugin also sends a `clear` control message to the PTY host, which calls
node-pty's native ConPTY clear, the same pairing VS Code uses). Full-screen apps
(psmux, vim) live on the alternate buffer and keep `Ctrl+L` as their redraw key.

On top of these, the psmux prefix (`Ctrl+B`, configurable) arms a 2-second
passthrough so the chord's second key bypasses even the plugin's own `Ctrl+Shift`
shortcuts — the blue **prefix** badge in the toolbar shows while it's pending.

---

## Admin in a pane

An elevated process cannot inherit a non-elevated parent's stdio, which is why most
terminal plugins can only shell out to a separate admin window. RobTerminal instead has
the elevated helper **connect back** to a named pipe the plugin created — a High
integrity process may open a Medium integrity object, so the handshake is legal and the
elevated shell lands in a normal Obsidian pane.

One UAC prompt per admin terminal. Elevation is deliberately *not* restored when a
workspace reopens, so a saved layout can never fire an unexpected UAC prompt at startup.

---

## How it works

```
Obsidian renderer                     system Node
┌────────────────────────┐           ┌──────────────────────┐
│ xterm.js (vendored)    │  named    │ ptyhost.js           │
│ RobTerminalView        │◄─ pipe ──►│ node-pty → ConPTY    │──► powershell / psmux / …
│ PtyBridge              │  +token   │                      │
└────────────────────────┘           └──────────────────────┘
```

node-pty is a native module. Loaded *inside* Obsidian it would be pinned to Obsidian's
Electron ABI and break on Obsidian updates, so it runs out-of-process under the system
Node instead. The cost is one extra process per terminal and a pipe hop measured in
microseconds; the benefit is that Obsidian can update freely.

Each session gets a random pipe name plus a 24-byte token, the listener closes after the
first client, and a wrong token is refused. When the pipe drops, the host kills its PTY
and everything under it — a running build never outlives its pane.

Wire format both ways: `[type:u8][length:u32be][payload]`, type 0 raw PTY bytes, type 1
JSON control. Bytes stay bytes end to end; xterm.js does its own UTF-8 decoding.

---

## Settings

Default shell · Node runtime · split direction · reuse one pane · font size and family
(use a Nerd Font for prompt glyphs) · scrollback · cursor style and blink · WebGL
rendering · ribbon icon · psmux prefix key (`ctrl+b` by default; empty disables the
passthrough).

---

## Verified

Driven against a real ConPTY, no mocks below the plugin boundary:

- pipe handshake, spawn, clean exit, and token rejection on a forged handshake
- real PTY confirmed by ConPTY's own `\e[?9001h` negotiation and PSReadLine's live
  syntax highlighting
- resize propagating through to the shell (`$Host.UI.RawUI.WindowSize.Width` follows)
- **psmux** starting a session and entering the alternate screen buffer
- **psmux keybinds end-to-end** through the real PTY host: after the env scrub,
  `prefix + c` verifiably creates a second window (confirmed via `list-windows`
  against the server, not screen-scraping) and `prefix + %` splits the pane
- the `clear` control message accepted by a live ConPTY with the shell still
  responsive afterwards
- 23 unit tests over the key-handling logic run against the exact deployed
  `main.js`: Ctrl+L on both buffers, prefix arm/disarm/passthrough, the focus
  scope's push/pop refcounting, and armed chords yielding to the shell
- **Claude Code** launching under the PTY
- Git Bash, WSL, cmd and PowerShell all detected and pointing at real executables
- no orphaned host or psmux processes after teardown
- the elevation launcher validated with the PowerShell parser, including paths
  containing spaces and apostrophes

Verified by a human in live Obsidian (2026-08-15): psmux TUI opens in a pane, prefix
chords create windows and splits, and `Ctrl+L` clears. Still not verified by
automation: the UAC hop itself — it needs a human to approve the prompt.
