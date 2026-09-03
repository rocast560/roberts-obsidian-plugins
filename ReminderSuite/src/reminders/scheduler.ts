/**
 * Desktop reminder notifications for ⏰ tasks.
 *
 * Obsidian-coupled (Notice, vault.process, workspace) — no unit tests here,
 * same as `tasks/index.ts` and `sync/engine.ts`. The pure date math it needs
 * (snoozing "tomorrow", advancing a date by a day) reuses `addDaysISO` from
 * `recurrence.ts` rather than duplicating it.
 *
 * Construction is desktop-gated by the caller (main.ts, via
 * `Platform.isDesktopApp`) — this class assumes it's allowed to run and sets
 * no platform guards of its own beyond the ones documented per-feature below.
 */

import { ButtonComponent, MarkdownView, Menu, Notice } from "obsidian";
import type { App } from "obsidian";
import { findTaskLine } from "../tasks/index.ts";
import type { IndexedTask, VaultTaskIndex } from "../tasks/index.ts";
import { isTaskCancelled, isTaskDone, parseTaskLine, serializeTask } from "../tasks/parser.ts";
import type { ParsedTask, TaskReminder } from "../tasks/parser.ts";
import { addDaysISO } from "./recurrence.ts";
import type { ReminderSuiteSettings } from "../settings.ts";

export interface ReminderSchedulerDeps {
	app: App;
	index: VaultTaskIndex;
	settings: ReminderSuiteSettings;
	/** Persists `settings` — the scheduler owns `notifiedReminders` and writes it through. */
	saveSettings: () => Promise<void>;
}

/** How often main.ts's `registerInterval` calls `tick()`. */
export const REMINDER_TICK_MS = 30_000;

/** How long a fired reminder's key survives a restart before it's pruned from `settings.notifiedReminders`. */
const NOTIFIED_RETENTION_DAYS = 7;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * 60;
const MS_PER_MINUTE = 60_000;

type SnoozeChoice = "10m" | "1h" | "tomorrow";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function isoDaysAgo(days: number): string {
	const d = new Date();
	d.setDate(d.getDate() - days);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * A reminder's wall-clock date+time, read in the *machine's own* local zone
 * (no "Z"/offset in the string is what makes `Date.parse` do that) — the
 * same convention `taskEvent.ts` documents for ⏰: it's a time the user set
 * for themselves, not an instant tied to any particular zone.
 */
function reminderLocalMs(reminder: TaskReminder): number {
	return new Date(`${reminder.date}T${reminder.time}:00`).getTime();
}

/** Identifies one fired reminder for dedup, in-session and across restarts. */
function reminderKey(filePath: string, line: number, reminder: TaskReminder): string {
	return `${filePath}|${line}|${reminder.date}|${reminder.time}`;
}

/** The date embedded in a `reminderKey` — pruning reads it back out rather than storing a separate timestamp. */
function keyDate(key: string): string {
	return key.split("|")[2] ?? "";
}

function snoozeTarget(reminder: TaskReminder, choice: SnoozeChoice): TaskReminder {
	if (choice === "tomorrow") {
		return { date: addDaysISO(reminder.date, 1), time: "09:00" };
	}
	const minutes = choice === "10m" ? 10 : MINUTES_PER_HOUR;
	const [hh, mm] = reminder.time.split(":").map(Number);
	const total = hh * MINUTES_PER_HOUR + mm + minutes;
	const dayOffset = Math.floor(total / MINUTES_PER_DAY);
	const withinDay = total - dayOffset * MINUTES_PER_DAY;
	return {
		date: dayOffset === 0 ? reminder.date : addDaysISO(reminder.date, dayOffset),
		time: `${pad2(Math.floor(withinDay / MINUTES_PER_HOUR))}:${pad2(withinDay % MINUTES_PER_HOUR)}`,
	};
}

export class ReminderScheduler {
	private deps: ReminderSchedulerDeps;
	/** Open ⏰ tasks worth checking on each tick — future, or overdue within the grace window. Rebuilt on every index change rather than re-derived every 30s. */
	private upcoming: IndexedTask[] = [];
	/** Fired this session; checked before the persisted `notifiedReminders` list so a just-fired reminder never needs a settings round-trip to dedup against itself. */
	private notifiedThisSession = new Set<string>();
	private unsubscribeIndex: () => void;

	constructor(deps: ReminderSchedulerDeps) {
		this.deps = deps;
		this.pruneNotified();
		this.rebuildUpcoming();
		this.unsubscribeIndex = deps.index.onChange(() => this.rebuildUpcoming());
	}

	/** Unsubscribes from the task index. Called from main.ts's `onunload` — the 30s tick itself is torn down by Obsidian's own `registerInterval`. */
	destroy(): void {
		this.unsubscribeIndex();
	}

	/** Called every `REMINDER_TICK_MS` by main.ts via `registerInterval`. Fires any due, not-yet-notified ⏰ tasks. */
	tick(): void {
		const now = Date.now();
		const graceMs = this.deps.settings.missedReminderGraceMinutes * MS_PER_MINUTE;
		for (const task of this.upcoming) {
			if (isTaskDone(task.parsed) || isTaskCancelled(task.parsed)) {
				continue;
			}
			const reminder = task.parsed.reminder;
			if (reminder === null) {
				continue;
			}
			const dueMs = reminderLocalMs(reminder);
			// Not yet due, or so overdue it's outside the grace window (never fires at all, missed for good).
			if (dueMs > now || now - dueMs > graceMs) {
				continue;
			}
			const key = reminderKey(task.filePath, task.line, reminder);
			if (this.notifiedThisSession.has(key) || this.deps.settings.notifiedReminders.includes(key)) {
				continue;
			}
			this.fire(task, key);
		}
	}

	/** Recomputes `upcoming` from the current index. Cheap filter — the real due/grace check happens per-tick in `tick()`, this just bounds the working set. */
	private rebuildUpcoming(): void {
		const now = Date.now();
		const graceMs = this.deps.settings.missedReminderGraceMinutes * MS_PER_MINUTE;
		this.upcoming = this.deps.index.all().filter((task) => {
			if (isTaskDone(task.parsed) || isTaskCancelled(task.parsed)) {
				return false;
			}
			const reminder = task.parsed.reminder;
			if (reminder === null) {
				return false;
			}
			return reminderLocalMs(reminder) >= now - graceMs;
		});
	}

	/** Drops `notifiedReminders` entries older than `NOTIFIED_RETENTION_DAYS`, so the list can't grow forever across restarts. */
	private pruneNotified(): void {
		const cutoff = isoDaysAgo(NOTIFIED_RETENTION_DAYS);
		const all = this.deps.settings.notifiedReminders;
		const kept = all.filter((entry) => keyDate(entry) >= cutoff);
		if (kept.length !== all.length) {
			this.deps.settings.notifiedReminders = kept;
			void this.deps.saveSettings();
		}
	}

	/** Marks `key` notified (in-memory and persisted) and shows the reminder — the sticky in-app card, and an OS notification when enabled. */
	private fire(task: IndexedTask, key: string): void {
		this.notifiedThisSession.add(key);
		this.deps.settings.notifiedReminders.push(key);
		void this.deps.saveSettings();

		this.showNoticeCard(task);

		if (this.deps.settings.useSystemNotification && typeof Notification !== "undefined") {
			try {
				new Notification("ReminderSuite", { body: task.parsed.description });
			} catch (error) {
				// Electron's renderer-side Notification can still throw (e.g. OS
				// notifications disabled) — the in-app card already fired, so this
				// is a log, not a user-facing failure.
				console.warn("ReminderSuite: could not show a system notification.", error);
			}
			// No click-to-focus wiring: the renderer's `Notification` has no
			// reliable, sandboxed-safe way back to "focus this Obsidian window"
			// without reaching for Electron internals. The card above is the
			// actionable one; this is a heads-up only.
		}
	}

	/** The sticky (duration 0) reminder card: task text plus Done / Snooze / Open. */
	private showNoticeCard(task: IndexedTask): void {
		let notice: Notice | null = null;

		const fragment = createFragment((frag) => {
			const container = frag.createDiv({ cls: "reminder-suite-reminder-notice" });
			container.createDiv({ cls: "reminder-suite-reminder-text", text: task.parsed.description });
			const buttons = container.createDiv({ cls: "reminder-suite-reminder-buttons" });

			new ButtonComponent(buttons)
				.setButtonText("Done")
				.setCta()
				.onClick(() => {
					void this.handleDone(task);
					notice?.hide();
				});

			new ButtonComponent(buttons).setButtonText("Snooze ▾").onClick((evt: MouseEvent) => {
				const menu = new Menu();
				menu.addItem((item) =>
					item.setTitle("10 minutes").onClick(() => {
						void this.handleSnooze(task, "10m");
						notice?.hide();
					}),
				);
				menu.addItem((item) =>
					item.setTitle("1 hour").onClick(() => {
						void this.handleSnooze(task, "1h");
						notice?.hide();
					}),
				);
				menu.addItem((item) =>
					item.setTitle("Tomorrow 9:00").onClick(() => {
						void this.handleSnooze(task, "tomorrow");
						notice?.hide();
					}),
				);
				menu.showAtMouseEvent(evt);
			});

			new ButtonComponent(buttons).setButtonText("Open").onClick(() => {
				void this.handleOpen(task);
			});
		});

		notice = new Notice(fragment, 0);
	}

	/** Done: ticks the task off through the same path the sidebar uses, so 🔁 rollover applies. */
	private async handleDone(task: IndexedTask): Promise<void> {
		try {
			await this.deps.index.setTaskChecked(task, true);
		} catch (error) {
			new Notice(`ReminderSuite: ${errorMessage(error)}`);
		}
	}

	/**
	 * Snooze: rewrites the task's ⏰ in place via `vault.process`, re-locating
	 * the line by its canonical serialization the same way `setTaskChecked`
	 * does — the file may have changed since this reminder fired.
	 */
	private async handleSnooze(task: IndexedTask, choice: SnoozeChoice): Promise<void> {
		const reminder = task.parsed.reminder;
		if (reminder === null) {
			return;
		}
		const file = this.deps.app.vault.getFileByPath(task.filePath);
		if (file === null) {
			new Notice(`ReminderSuite: file not found: ${task.filePath}`);
			return;
		}
		const expectedCanonical = serializeTask(task.parsed);
		const newReminder = snoozeTarget(reminder, choice);
		let updatedParsed: ParsedTask | null = null;
		let updatedLine: number | null = null;

		try {
			await this.deps.app.vault.process(file, (content) => {
				const lines = content.split("\n");
				const targetLine = findTaskLine(lines, task.line, expectedCanonical);
				if (targetLine === null) {
					throw new Error(
						`ReminderSuite: could not find task to snooze (file changed): ${task.filePath}:${task.line}`,
					);
				}
				const rawLine = lines[targetLine];
				const hadCR = rawLine.endsWith("\r");
				const parsed = parseTaskLine(rawLine);
				if (parsed === null) {
					throw new Error(`ReminderSuite: line ${targetLine} in ${task.filePath} is no longer a task`);
				}
				const next: ParsedTask = { ...parsed, reminder: newReminder };
				lines[targetLine] = serializeTask(next) + (hadCR ? "\r" : "");
				updatedParsed = next;
				updatedLine = targetLine;
				return lines.join("\n");
			});
		} catch (error) {
			new Notice(`ReminderSuite: ${errorMessage(error)}`);
			return;
		}

		if (updatedParsed !== null && updatedLine !== null) {
			task.parsed = updatedParsed;
			task.line = updatedLine;
		}
	}

	/** Open: reveals the task's line in the active pane, same as the sidebar's "Open task". */
	private async handleOpen(task: IndexedTask): Promise<void> {
		const file = this.deps.app.vault.getFileByPath(task.filePath);
		if (file === null) {
			new Notice(`ReminderSuite: file not found: ${task.filePath}`);
			return;
		}
		const leaf = this.deps.app.workspace.getLeaf(false);
		await leaf.openFile(file, { eState: { line: task.line } });
		const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
		if (view !== null) {
			const pos = { line: task.line, ch: 0 };
			view.editor.setCursor(pos);
			view.editor.scrollIntoView({ from: pos, to: pos }, true);
		}
	}
}
