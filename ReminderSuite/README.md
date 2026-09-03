# ReminderSuite

ReminderSuite is an Obsidian plugin that combines three things: two-way sync between your vault's tasks and Google Calendar, an in-app calendar view for browsing your Google events (and your dated vault tasks) without leaving Obsidian, and a right-sidebar panel for quickly adding, tracking, and getting reminded about tasks. It reads and writes the same checkbox-with-emoji task format used by the [Tasks](https://publish.obsidian.md/tasks) plugin, so it works alongside notes you already have.

This is an unofficial, independent project. It is not affiliated with, endorsed by, or supported by Google or Obsidian.

## Features

**Two-way Google Calendar sync**
- Bring your own Google OAuth client — no shared backend, no account with a third party
- Push: opt individual tasks into sync (right-click a task in the sidebar, or a toggle on quick-add); a task needs a due date (📅) or a reminder time (⏰) to become an event
- Pull: incremental sync via Google's `syncToken`, with automatic full-resync recovery if a token expires
- Conflict handling: concurrent edits on both sides resolve newest-wins, compared by file modification time vs. the event's `updated` timestamp
- Configurable behavior for what happens when a task is completed, and for what happens to a task when its linked Google event is deleted remotely
- A sync log (command: **Show sync log**) records what happened on each cycle

**In-app calendar**
- A full calendar tab (month / week / day) built on `@event-calendar/core`, opened from the ribbon or a command
- Shows your enabled Google calendars alongside dated vault tasks (drawn as read-only, distinctly colored events)
- Drag, resize, or click-create Google events directly on the grid; edits push back to Google with an `If-Match` etag
- Click a Google event to rename, retime, or delete it in place. Recurring events, read-only calendars, and events mirroring synced tasks open a hand-off instead (Open in Google Calendar / edit the task)
- Clicking a vault-task event jumps to that task's line in its note

**Task & reminder sidebar**
- Compatible with the Tasks-plugin emoji format (📅 due, ⏳ scheduled, 🛫 start, ✅ done, 🔁 recurrence, priority emojis) plus the Reminder-plugin's `⏰ HH:mm` time extension
- Quick-add with lightweight natural-language parsing (a trailing `HH:mm`, preceded by `today`, `tomorrow`, or `YYYY-MM-DD` — e.g. "Call mom tomorrow 14:00"), or paste full emoji syntax directly
- Tasks grouped into Overdue / Today / Upcoming / Someday, with an optional tag filter to limit which checkboxes get indexed
- Today's Google Calendar agenda shown above the task list
- Desktop notification cards (Done / Snooze / Open) plus optional OS notifications when a ⏰ comes due, with recurrence rollover on completion

## Setup: Google Cloud credentials

ReminderSuite doesn't ship with its own Google API access — each user creates a free Google Cloud project and connects it directly. This takes about ten minutes, once.

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and create a new project (or pick an existing one you're happy to use for this).
2. In **APIs & Services → Library**, find and enable the **Google Calendar API**.
3. In **APIs & Services → OAuth consent screen**, configure a consent screen with user type **External**. Fill in the required app info (name, support email) — you don't need to submit anything for review yet.
4. **Publish the app to Production.** This step matters: while the consent screen is in **Testing** status, Google expires refresh tokens after **7 days**, which means you'd have to sign in again every week. Publishing to Production removes that limit. Publishing triggers a one-time "Google hasn't verified this app" warning when you sign in — that's expected for a personal, unpublished-for-review client; click **Advanced**, then **Continue**.
5. In **APIs & Services → Credentials**, create an OAuth client ID of type **Desktop app**.
6. Copy the generated **Client ID** and **Client secret** into ReminderSuite's settings (**Google account** section).
7. Click **Sign in**. Your system browser opens Google's consent screen; after you approve, control returns to Obsidian automatically.

## Using the plugin

**Calendar view** — open it from the ribbon icon ("Open ReminderSuite calendar") or the **Open calendar** command. Toggle which calendars are shown, and how often the view polls, from plugin settings.

**Sidebar** — open it from the ribbon icon ("Open ReminderSuite sidebar") or the **Open sidebar** command (or let it open automatically at startup, if enabled in settings).
- **Quick-add** parses full `📅`/`⏰` emoji syntax if you type it, or falls back to a lightweight natural form: a trailing `HH:mm`, preceded by `today` / `tomorrow` / `YYYY-MM-DD` — e.g. "Call mom tomorrow 14:00" (the date must come first; a time with no date defaults to today). The parsed task is appended to your configured inbox note (or to the task source note, when one is set). A toggle next to the input also syncs the new task to Google, if you're signed in and have a default calendar chosen.
- Tasks are grouped into **Overdue / Today / Upcoming / Someday**, each collapsible.
- By default every checkbox line in the vault is indexed. Set **Task source note** in settings to read tasks from one dedicated note instead (quick-add then writes there too, and the setting follows the note if you rename it), or set **Task filter tag** (e.g. `#task`) to keep the vault-wide scan but only index tagged lines.
- Right-click any task for **Sync to Google Calendar** / **Stop syncing**, and **Open task** to jump to its line.

**Completing tasks** — checking a task off (in the sidebar, or in the note itself) inserts `✅ YYYY-MM-DD`. If the task carries a `🔁` recurrence and this is the transition into "done," a fresh open occurrence is inserted with dates advanced according to the rule (`every N days/weeks/months/years`, `every <weekday>`, and the `... when done` variant). The new occurrence does not inherit the completed task's sync link — a still-recurring task has to be re-synced by hand after it rolls over.

**What syncs and what doesn't** — only tasks with a due date or a reminder time are "event-worthy"; a task with only a `⏳` scheduled date (and nothing else) won't push, since scheduled is treated as a planning hint rather than a calendar commitment. Events created directly in Google Calendar are never turned into vault notes — they're shown "virtually" in the calendar view and sidebar agenda, so nothing is written to your vault unless you asked for it.

**Conflict policy** — if a synced task and its Google event were both edited since the last sync, the newer one wins, compared by the note's file modification time against the event's `updated` timestamp. A tie goes to Google's copy (it's more likely the local clock is fast than that the two happened at the same instant); if either timestamp is missing or unparseable, the local (vault) version wins instead, since overwriting the vault is the more destructive direction.

**When an event is deleted in Google** (settings → "When an event is deleted in Google"):
- **Tick the task off** (default) — the task is marked done, as if you'd completed it
- **Delete the task line** — the line is removed from the note
- **Leave the task alone** — only the sync link is dropped; the task text is untouched

**When a task is completed** (settings → "When a task is completed"):
- **Keep it, prefixed with ✓** (default) — the Google event stays, retitled with a `✓ ` prefix
- **Delete the event** — the Google event is deleted

**Status bar** — a clickable item in Obsidian's status bar reflects sync state: `GCal` (never synced yet), `GCal ✓ HH:MM` (idle, last synced at that time), `GCal ⟳` (syncing now), `GCal ⚠` (last cycle errored — hover for the message). Clicking it, or running the **Sync with Google now** command, triggers a sync (or prompts you to sign in, if you aren't).

**Sync log** — the **Show sync log** command opens a modal listing recent sync events (pushes, pulls, conflicts, deletions, failures) from the current session.

## Reminders

When a task's `⏰` time arrives, ReminderSuite shows a sticky in-app notification card with **Done**, **Snooze** (10 minutes / 1 hour / tomorrow at 9:00), and **Open** actions. If "Desktop notifications" is enabled in settings, an OS-level notification also fires alongside the card. A configurable grace period (default 60 minutes) still surfaces reminders that came due while Obsidian was closed.

This entire mechanism — the scheduler, the notification card, OS notifications — is desktop-only. On mobile, Obsidian gives plugins no reliable background execution, so reminders for **tasks synced to Google Calendar** are instead delivered by the Google Calendar app on your phone, using whatever reminder lead time you've configured in settings. This is by design, not a missing feature: it's the reason syncing a task to Google is worth doing even if you never look at the in-app calendar. Unsynced tasks have no mobile reminder path.

## Network use & privacy disclosure

ReminderSuite talks to exactly three Google hosts, and only after you sign in:

- `accounts.google.com` — the OAuth authorization screen
- `oauth2.googleapis.com` — exchanging/refreshing/revoking tokens
- `www.googleapis.com` — the Google Calendar REST API (listing calendars, reading/writing events)

It makes no other network requests: no telemetry, no analytics, no update checks, no calls to any service other than the Google APIs above.

The OAuth scopes requested are narrow and fixed: `calendar.events` (read/write your events) and `calendar.calendarlist.readonly` (list your calendars, so you can pick which ones to sync — nothing is written there). The broad `auth/calendar` scope, and any scope that would identify you (like `openid`), are deliberately never requested.

Your OAuth client secret and access/refresh tokens are stored **unencrypted** in this vault's `.obsidian/plugins/reminder-suite/data.json`. Anyone with read access to that file — including copies made by a vault sync service, a backup, or a git repository — can read them. If your vault is a git repository, add `.obsidian/plugins/reminder-suite/data.json` to `.gitignore` (or ignore the whole `.obsidian/` folder, per your usual practice) before committing.

## Security posture

- **One direct dependency**: `@event-calendar/core`, used only for the calendar grid. No Google API SDK, no HTTP/crypto/date libraries — the Calendar REST API is called directly with Obsidian's `requestUrl()`, and PKCE uses the browser's built-in Web Crypto.
- **That one dependency is not one package**: it brings the Svelte 5 runtime and toolchain with it — 20 transitive packages (`svelte`, `acorn`, `magic-string`, and the rest), each exact-pinned in the committed `package-lock.json` and audited at build time. The ones the calendar actually imports (the Svelte 5 runtime, `clsx`, `esm-env`) are bundled into `main.js` at compile time, so the shipped plugin is a single file and nothing is fetched at runtime; the compiler-side packages stay on the build machine. Either way the code you are trusting is that whole installed set, not one package.
- **Exact-pinned lockfile**: `package-lock.json` is committed; installs use `npm ci`.
- **Install scripts disabled**: `.npmrc` sets `ignore-scripts=true` and `save-exact=true`.
- **No network code runs at build time** — the build is `tsc` + a local esbuild bundle, nothing fetched.

## Development

```bash
git clone <this repo>
cd ReminderSuite
npm ci
npm run dev     # esbuild in watch mode
npm run build   # tsc typecheck + production esbuild bundle
npm test        # node --test over test/**/*.test.ts
```

Releases are intended to be built by CI from the committed lockfile (`npm ci` → `npm run build`, artifact attached to a tagged GitHub release) rather than built by hand on a maintainer's machine; that CI workflow is not set up yet, so releases today are built locally as shown above. Submission to Obsidian's community plugin registry is out of scope for this release and left as future work.
