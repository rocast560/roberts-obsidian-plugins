# ReminderSuite — Obsidian Plugin: Plan & Task Breakdown

**Goal:** A single Obsidian plugin with three pillars that no existing plugin combines:

1. **Two-way Google Calendar sync** — push events/tasks from Obsidian to Google Calendar and pull changes back.
2. **A clean in-app calendar** — a full calendar view you can open as a tab (month/week/day), showing both Google events and vault tasks.
3. **A to-do reminder sidebar** — add and manage tasks from a right-sidebar panel, with reminders, and *optionally* sync any task to Google Calendar.

---

## 1. Research: the existing plugin landscape (Aug 2026)

### Calendar + Google sync plugins

| Plugin | Sync | Status | License | Takeaway |
|---|---|---|---|---|
| **Google Calendar** (YukiGasai) | True two-way via GCal API | **Dead** ("stale mode", last real release Sep 2024) | GPL-3.0 | Richest views ever shipped (month/week/year/timeline); issue tracker dominated by OAuth failures |
| **Full Calendar** (davish) | Local notes + read-only ICS/CalDAV, no Google API | **Archived Aug 2026** | MIT | Proved FullCalendar.io works inside an ItemView; safe to study/copy |
| **Full Calendar Remastered** (fork) | Two-way GCal via API, verified "Login with Google" | Very active | GPL-3.0 | The strongest competitor; GPL because it uses FullCalendar *Premium* — reference only, don't copy code |
| **Day Planner** (ivan-lednev) | Read-only ICS display only | Very active (2.7k ⭐) | MIT | Best timeline/sidebar UX to learn from; top complaints are mobile drag-and-drop bugs |
| **GCal Sync** (Sasoon) | One-way: Obsidian Tasks → GCal | Not in community registry | GPL-3.0 | Proves the Tasks-emoji → event mapping; hides sync IDs in HTML comments |
| **Time Blocks** (jonmccon) | Two-way with conflict-resolution modes | Pre-release, active | MIT | Uses **PKCE desktop OAuth with no client secret**; stores blocks in data.json instead of notes (weakness) |
| **obsidian-ics** (muness) | One-way ICS → daily-note bullets | Active, in registry | MIT | Clean minimal reference for ICS parsing |

### Task / reminder plugins

| Plugin | Role | Status | License | Takeaway |
|---|---|---|---|---|
| **Tasks** (obsidian-tasks-group) | De-facto standard task format + query engine | Very active (3.9k ⭐) | MIT | Its emoji format (`📅 ⏳ 🛫 ✅ 🔁 ⏫`) is the ecosystem lingua franca — **adopt it, don't invent a new format** |
| **Reminder** (uphy) | Notifications for Tasks-format checkboxes | Recently revived | MIT | Copy its UX: modal card with Done/Snooze/Open, OS notifications, Tasks-format interop (`⏰` time extension) |
| **Ultimate Todoist Sync** | Two-way "replica" sync markdown ↔ Todoist | Surviving via forks | GPL-3.0 | ID mapping via hidden `%%[todoist_id:: …]%%` comments — which **broke the Tasks parser** (end-of-line rule); lesson learned |
| **Sync with Todoist** (jamiebrynes7) | "Materialized view" — remote tasks rendered in code blocks, never written to markdown | Well maintained | MIT | The zero-conflict architecture; good model for displaying calendar-born events |
| **Checklist** (delashum) | Sidebar aggregating vault checkboxes | Caretaker mode | MIT | Reference for a sidebar ItemView that aggregates + writes completions back to files |

### Gaps this plugin fills

- **Nobody combines all three pillars.** Two-way sync + polished calendar + task sidebar never coexist in one maintained plugin.
- **OAuth is the #1 failure mode everywhere** — a clean, well-documented auth flow is itself a differentiator.
- **Task↔event bridging is one-directional everywhere.** "Add a task in the sidebar → it becomes a GCal event that round-trips" doesn't exist.
- **Licensing note:** to keep this plugin "your own" (MIT), only copy code/patterns from the MIT projects (davish Full Calendar, Day Planner, Time Blocks, Tasks, Reminder, obsidian-ics, jamiebrynes7). The GPL plugins (YukiGasai, Remastered, GCal Sync) are **reference-only** — study behavior, never paste code.

---

## 2. Key design decisions (recommended defaults)

### D1. Auth: bring-your-own Google client, loopback + PKCE
Each user creates their own free Google Cloud project, enables the Calendar API, creates a **Desktop app** OAuth client, and pastes the client ID + secret into plugin settings. The plugin runs the standard installed-app flow: system browser → temporary listener on `http://127.0.0.1:<random port>` → code exchange with PKCE.

- **Scopes (narrow, on purpose):** `calendar.events` + `calendar.calendarlist.readonly`. Never request the broad `auth/calendar` scope.
- **Zero infrastructure, zero Google verification** — each user's project serves only themselves.
- **Must-document gotcha:** while the consent screen is in *Testing* status, refresh tokens die after **7 days**. The setup guide must tell users to publish the consent screen to *Production* (the one-time "unverified app" warning is expected and bypassable).
- Tokens are refreshed automatically (`access_type=offline`, `prompt=consent`); on `invalid_grant`, prompt re-login.
- **v1 is desktop-only sign-in** (mobile has no loopback server); tokens can ride to mobile via vault sync later. A hosted verified client is a possible v2 upgrade if the plugin gains users.
- **Security note:** tokens live in `data.json` — plaintext in the vault. Document the risk (vault sync, git); optionally use Electron `safeStorage` on desktop later.

### D2. Task format: the Tasks-plugin emoji standard
Tasks are ordinary markdown checkboxes with trailing emoji metadata:

```markdown
- [ ] Call the dentist 📅 2026-08-20 ⏰ 2026-08-20 09:00 ⏫ 🔁 every month
```

- Read/write `📅` due, `⏳` scheduled, `🛫` start, `✅` done, `🔁` recurrence, priority emojis; support the `⏰ HH:mm` time extension popularized by the Reminder plugin.
- **Respect the end-of-line rule:** the Tasks parser only reads metadata trailing the description — never append hidden comments after the emoji block (that exact mistake broke Ultimate Todoist Sync).
- **Sync ID mapping:** give each synced task a standard Obsidian block ID (`^gcal-a1b2c3`, tolerated at end of line) and keep the map `blockID → {calendarId, eventId, etag, lastSyncedHash}` in `data.json`. Markdown stays clean; sync state (tombstones, hashes) lives where it belongs.
- Completion semantics match Tasks/Reminder: mark done → insert `✅ YYYY-MM-DD`, roll `🔁` recurrences into a fresh line.

### D3. Sync engine: polling + syncTokens + etags, hybrid data model
- **Pull:** poll `events.list` per selected calendar with a stored **syncToken** (only changes come back, deletions arrive as `status: "cancelled"`). Default every 5 min, configurable, plus sync-on-startup and a manual refresh button. On HTTP 410, discard the token and full-resync.
- **Push:** local creates/edits/deletes go out with `If-Match: <etag>`. A 412 means the remote changed → re-fetch and apply the conflict policy (**newest-wins by `updated`** by default; a conflict modal is a later nice-to-have).
- **Change detection:** watch `metadataCache` / `vault.on("modify")` and compare against `lastSyncedHash` — don't diff the vault on every poll.
- **Hybrid data model (the important call):**
  - *Vault-born tasks* (sidebar or markdown) are the source of truth in markdown and replica-synced to GCal **only when the user opts in** (per-task toggle in the sidebar / add-task modal).
  - *Calendar-born events* (created in Google) are rendered **virtually** in the calendar view and sidebar agenda — no notes are created for them by default. This is the zero-conflict "materialized view" model and avoids vault clutter.

### D4. UI stack
- **Calendar library:** `vkurko/event-calendar` — MIT, FullCalendar-like API (day/week/month/list, drag-drop editing), **~33 KB** vs FullCalendar's 200 KB+. Bundled into `main.js` (Obsidian policy: no code loaded from the network).
- **Calendar tab:** a main-area `ItemView` (opened via ribbon icon + command) with month/week/day toggle; drag/resize on a synced event pushes the change to Google.
- **Sidebar:** a right-leaf `ItemView` with two stacked sections — an **agenda** (today's events) and a **task list** grouped Today / Overdue / Upcoming / No date, checkbox toggles written back to the source file, click-through to the source line, and a quick-add input (natural-ish date entry + "sync to Google Calendar" toggle).
- **HTTP:** Obsidian's `requestUrl()` everywhere (CORS-free, works desktop + mobile).
- **Toolchain:** TypeScript + esbuild from the official sample-plugin template. Plain TS for views (no framework) unless the sidebar gets complex enough to justify Svelte.

### D5. Supply-chain hardening: near-zero dependency policy
npm is the biggest attack surface this project touches; the design keeps the runtime tree to **one auditable package (or zero if vendored)**.

- **No `googleapis` SDK** — call the Calendar REST API directly via `requestUrl()` (dozens of transitive packages avoided).
- **No HTTP, crypto, or date libraries** — `requestUrl()` for HTTP, Web Crypto (`crypto.subtle`) for PKCE, Obsidian's bundled moment.js for dates.
- **No `rrule`** — hand-roll the handful of `🔁 every day/week/month` patterns (~50 lines).
- **Sole runtime dep:** `vkurko/event-calendar` (itself zero-dependency). Option: vendor its MIT source into the repo so builds never pull runtime code from npm (trade-off: manually track upstream fixes).
- **Install scripts disabled** — `.npmrc` with `ignore-scripts=true` (blocks the postinstall vector used by most real npm attacks; esbuild still works via `optionalDependencies`) and `save-exact=true` (no `^` version floating).
- **Lockfile discipline** — commit `package-lock.json`, always install with `npm ci`.
- **Cooldown rule** — never upgrade a dependency the week it's released (hijacked versions are usually yanked within days); bump one at a time and skim the diff.
- **devDependencies stay minimal too** (`typescript`, `esbuild`, `obsidian`, `@types/node`) — they run on the dev machine, so they're attack surface even if never shipped.
- **Release integrity** — build `main.js` in GitHub Actions from the lockfile; pin third-party Actions by commit SHA (tags are mutable — see the 2025 `tj-actions/changed-files` compromise); hardware/app 2FA on GitHub. No npm publishing account is needed at all (Obsidian distributes via GitHub Releases).

### D6. Reminders
- **Desktop:** timer loop over the task index → in-app notice card (Done / Snooze presets / Open note) + optional OS notification via Electron.
- **Mobile:** Obsidian gives plugins no background execution or notification API. Instead of fighting it, **delegate to Google**: any task synced to GCal gets a default reminder (configurable, e.g. 10 min before), so Google's own apps notify on every device for free. This is a genuine advantage of the GCal integration.

---

## 3. Architecture

```
src/
├── main.ts              # plugin entry: registers views, commands, settings, sync scheduler
├── settings.ts          # settings tab + defaults (client creds, calendars, poll interval, reminder defaults)
├── auth/
│   ├── oauth.ts         # loopback flow, PKCE, token exchange
│   └── tokenStore.ts    # token persistence + auto-refresh
├── gcal/
│   ├── client.ts        # requestUrl wrapper: calendars, events CRUD, etag/If-Match, backoff on 403/429
│   └── types.ts         # GCal event/calendar types
├── sync/
│   ├── engine.ts        # poll loop, syncToken handling, push queue, 410/412 recovery
│   ├── mappings.ts      # blockID ↔ eventId map, hashes, tombstones (persisted to data.json)
│   └── conflict.ts      # newest-wins policy
├── tasks/
│   ├── parser.ts        # Tasks-emoji format read/write (📅 ⏳ ⏰ ✅ 🔁, priorities, block IDs)
│   └── index.ts         # vault task index built from metadataCache, debounced updates
├── views/
│   ├── calendarView.ts  # main-tab ItemView wrapping event-calendar
│   └── sidebarView.ts   # right-leaf ItemView: agenda + task list + quick-add
└── reminders/
    └── scheduler.ts     # desktop notification loop, snooze state
```

Data flow: `tasks/index` and `gcal/client` both feed the two views; `sync/engine` is the only module that talks to both sides and owns the mapping table.

---

## 4. Task breakdown

### Phase 0 — Scaffold
- [ ] Init from the official `obsidian-sample-plugin` template (TypeScript + esbuild); set `manifest.json` (id `reminder-suite`, `isDesktopOnly: false`), MIT `LICENSE`
- [ ] Add `.npmrc` with `ignore-scripts=true` and `save-exact=true`; commit `package-lock.json`; use `npm ci` for installs
- [ ] Prune devDependencies to `typescript`, `esbuild`, `obsidian`, `@types/node` only
- [ ] Decide: install `vkurko/event-calendar` from npm (exact-pinned) or vendor its MIT source into `src/vendor/` — either way it stays the **only** runtime dependency
- [ ] Dev loop: test vault + hot-reload plugin; `npm run dev` watch build
- [ ] Verify the plugin loads and a hello-world command runs

### Phase 1 — Google auth
- [ ] Settings fields for client ID/secret + a step-by-step Google Cloud setup guide (incl. the Testing→Production 7-day-token gotcha)
- [ ] Loopback OAuth flow with PKCE via Web Crypto — `crypto.getRandomValues` verifier + `crypto.subtle` SHA-256 challenge, no crypto dependency (system browser, ephemeral 127.0.0.1 port, success page)
- [ ] Token store: persist, auto-refresh, `invalid_grant` → re-auth prompt; Sign in / Sign out UI showing the connected account

### Phase 2 — Calendar API client
- [ ] `requestUrl`-based client (no `googleapis` SDK, no HTTP library): list calendars, list events (paginated, syncToken), create/patch/delete with `If-Match`
- [ ] Exponential backoff on 403 `rateLimitExceeded` / 429; typed errors for 410 / 412

### Phase 3 — Calendar view (read-only first)
- [ ] Main-tab `ItemView` bundling `vkurko/event-calendar`; ribbon icon + "Open calendar" command
- [ ] Render events from selected calendars (per-calendar colors, calendar picker in settings)
- [ ] Month / week / day toggle; manual refresh; background poll wiring

### Phase 4 — Task index + sidebar
- [ ] Tasks-emoji parser (read + write, end-of-line safe, block-ID aware) with unit tests
- [ ] Vault task index from `metadataCache`, debounced on file changes
- [ ] Sidebar `ItemView`: task list grouped Today / Overdue / Upcoming / No date; checkbox writeback (`vault.process`); click-to-source
- [ ] Quick-add input: parse date/time, append to a configurable inbox note (or current daily note)
- [ ] Today's-agenda section showing calendar events
- [ ] Vault tasks with dates appear on the calendar view

### Phase 5 — Push to Google
- [ ] Per-task "sync to GCal" opt-in (quick-add toggle + right-click on existing tasks); assign block ID, create event, record mapping
- [ ] Local edits (text, date/time, completion) push to the mapped event; completion strategy (mark event `[done]` in title vs delete — setting)
- [ ] Create events by click/drag on empty calendar slots; drag/resize synced events pushes updates
- [ ] Tombstones: deleting a synced task/event locally deletes it remotely (with confirmation setting)

### Phase 6 — Two-way sync hardening
- [ ] Incremental pull loop with syncToken persistence; 410 → windowed full resync
- [ ] Remote edits/deletes update mapped tasks in markdown; remote `cancelled` → configurable local behavior
- [ ] Conflict policy: newest-wins via `updated`/`lastSyncedHash`; log skipped conflicts to a sync log
- [ ] Sync status indicator (status bar: last sync, errors)

### Phase 7 — Reminders
- [ ] Desktop scheduler: `⏰`-aware notification card (Done / Snooze presets / Open) + optional OS notification
- [ ] Default GCal reminder minutes on synced events (mobile notifications via Google's apps — document this)
- [ ] Recurrence rollover on completion (`🔁`) — hand-rolled interval math, no `rrule` dependency

### Phase 8 — Polish & release
- [ ] Settings polish + first-run onboarding (connect Google → pick calendars → done)
- [ ] README: features, Google Cloud walkthrough with screenshots, **network-use disclosure** (Obsidian policy), plaintext-token warning
- [ ] Manual test pass on a real vault + mobile sanity check (views render; sign-in gated to desktop)
- [ ] Release build in GitHub Actions: `npm ci --ignore-scripts` from the lockfile, artifact attached to the tagged release; third-party Actions pinned by commit SHA
- [ ] GitHub account hardened with hardware/app 2FA
- [ ] Community plugin submission (or BRAT beta first)

---

## 5. Risks & open questions

| # | Question | Default in this plan |
|---|---|---|
| 1 | BYO Google client is a ~10-min setup burden per user | Accept for v1; hosted verified client only if the plugin gains traction |
| 2 | Should GCal-born events ever become notes? | No — virtual display only (zero-conflict); revisit if note-linking is wanted |
| 3 | Mobile scope | Views work on mobile; sign-in desktop-only in v1 (tokens can sync via vault) |
| 4 | Task completion → what happens to the GCal event? | Setting: retitle "[done]" (default) vs delete |
| 5 | Tokens in `data.json` are plaintext in the vault | Documented warning v1; Electron `safeStorage` later |
| 6 | Plugin id/name collision | Check `reminder-suite` availability in the community registry before submission |
