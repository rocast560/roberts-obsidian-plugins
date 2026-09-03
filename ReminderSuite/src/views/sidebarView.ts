/**
 * Right-sidebar view: quick-add, today's Google Calendar agenda, and the
 * vault task list grouped into Overdue/Today/Upcoming/Someday. Plain DOM
 * (createEl) — no framework. No unit tests here (obsidian-coupled).
 */

import { ButtonComponent, ItemView, MarkdownView, Menu, Notice, TextComponent, ToggleComponent } from "obsidian";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { ReauthRequiredError } from "../auth/tokenStore.ts";
import type ReminderSuitePlugin from "../main.ts";
import { resolvedTaskSourcePath } from "../settings.ts";
import { parseTaskLine, priorityEmoji, serializeTask } from "../tasks/parser.ts";
import type { IndexedTask, TaskBuckets } from "../tasks/index.ts";
import type { GCalCalendarListEntry } from "../gcal/types.ts";
import { toCalendarEvent } from "./eventMapping.ts";
import type { CalendarLibEvent } from "./eventMapping.ts";

export const SIDEBAR_VIEW_TYPE = "reminder-suite-sidebar";

/** Sidebar's own re-render coalescing window; the index also coalesces its onChange at the same rate. */
const RERENDER_DEBOUNCE_MS = 500;

type BucketKey = keyof TaskBuckets;

const BUCKET_LABELS: Record<BucketKey, string> = {
	overdue: "Overdue",
	today: "Today",
	upcoming: "Upcoming",
	someday: "Someday",
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function todayDate(): Date {
	return new Date();
}

function isoDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function addDays(d: Date, days: number): Date {
	const next = new Date(d);
	next.setDate(next.getDate() + days);
	return next;
}

function formatTime(iso: string): string {
	const d = new Date(iso);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

/**
 * A trailing `today|tomorrow|YYYY-MM-DD` token, optionally followed by an
 * `HH:mm` token — date first, then time, as in "Call mom tomorrow 14:00" —
 * turns into 📅/⏰. A lone trailing time defaults its date to today. Anything
 * not recognized is left in the description.
 */
function naturalMiniParse(description: string): { description: string; due: string | null; reminder: { date: string; time: string } | null } {
	const words = description.split(/\s+/u).filter((w) => w !== "");
	let time: string | null = null;
	let due: string | null = null;

	if (words.length > 0 && /^\d{2}:\d{2}$/u.test(words[words.length - 1])) {
		time = words.pop()!;
	}
	if (words.length > 0) {
		const last = words[words.length - 1];
		const lower = last.toLowerCase();
		if (lower === "today") {
			due = isoDate(todayDate());
			words.pop();
		} else if (lower === "tomorrow") {
			due = isoDate(addDays(todayDate(), 1));
			words.pop();
		} else if (/^\d{4}-\d{2}-\d{2}$/u.test(last)) {
			due = last;
			words.pop();
		}
	}

	if (time === null) {
		return { description: words.join(" "), due, reminder: null };
	}
	// A trailing time with no recognized date defaults to today.
	const reminderDate = due ?? isoDate(todayDate());
	return { description: words.join(" "), due: reminderDate, reminder: { date: reminderDate, time } };
}

export class SidebarView extends ItemView {
	private plugin: ReminderSuitePlugin;
	private agendaListEl: HTMLElement | null = null;
	private tasksContainerEl: HTMLElement | null = null;
	private rerenderTimer: ReturnType<typeof setTimeout> | null = null;
	private collapsedBuckets = new Set<BucketKey>();
	/** Whether quick-added tasks also get a Google event. Off by default; not persisted between sessions. */
	private quickAddSync = false;
	private quickAddSyncToggle: ToggleComponent | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ReminderSuitePlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = false;
	}

	getViewType(): string {
		return SIDEBAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "ReminderSuite";
	}

	getIcon(): string {
		return "list-todo";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("reminder-suite-sidebar");

		this.renderQuickAdd(container);
		this.renderAgendaSection(container);
		this.renderTasksSection(container);

		this.register(this.plugin.taskIndex.onChange(() => this.scheduleRerender()));

		this.renderTasks();
		void this.refreshAgenda();
	}

	async onClose(): Promise<void> {
		if (this.rerenderTimer !== null) {
			clearTimeout(this.rerenderTimer);
			this.rerenderTimer = null;
		}
	}

	/** Re-fetches today's events. Public: the main poll interval and the section's own refresh button call this. */
	async refreshAgenda(): Promise<void> {
		// Cheap, and this is the one thing called on every poll tick and manual
		// refresh — so a sign-in from settings reaches the quick-add toggle.
		this.updateQuickAddSyncToggle();

		const container = this.agendaListEl;
		if (container === null) {
			return;
		}

		if (!this.plugin.tokenStore.isSignedIn()) {
			this.renderAgendaMessage("Sign in to Google to see events");
			return;
		}
		const enabledIds = this.plugin.settings.enabledCalendarIds;
		if (enabledIds.length === 0) {
			this.renderAgendaMessage("No calendars enabled");
			return;
		}

		const startOfDay = todayDate();
		startOfDay.setHours(0, 0, 0, 0);
		const endOfDay = addDays(startOfDay, 1);

		let calendars: GCalCalendarListEntry[] = [];
		let anyFailed = false;
		let reauthRequired = false;
		try {
			calendars = await this.plugin.gcalClient.listCalendars();
		} catch (error) {
			anyFailed = true;
			reauthRequired = error instanceof ReauthRequiredError;
		}
		const colorById = new Map(calendars.map((cal) => [cal.id, cal.backgroundColor]));

		const mapped: CalendarLibEvent[] = [];
		await Promise.all(
			enabledIds.map(async (calendarId) => {
				try {
					const { events } = await this.plugin.gcalClient.listEventsWindow(
						calendarId,
						startOfDay.toISOString(),
						endOfDay.toISOString(),
					);
					for (const ev of events) {
						if (ev.status === "cancelled") {
							continue;
						}
						mapped.push(toCalendarEvent(calendarId, ev, colorById.get(calendarId)));
					}
				} catch (error) {
					anyFailed = true;
					if (error instanceof ReauthRequiredError) {
						reauthRequired = true;
					}
				}
			}),
		);

		if (reauthRequired) {
			this.renderAgendaMessage("Sign in to Google to see events");
			return;
		}

		mapped.sort((a, b) => {
			if (a.allDay !== b.allDay) {
				return a.allDay ? -1 : 1;
			}
			return a.start.localeCompare(b.start);
		});

		container.empty();
		if (mapped.length === 0) {
			container.createEl("p", {
				cls: "reminder-suite-agenda-empty",
				text: anyFailed ? "Couldn't load events" : "No events today",
			});
			return;
		}
		for (const ev of mapped) {
			this.renderAgendaRow(container, ev);
		}
	}

	// ---- Quick add ----------------------------------------------------

	private renderQuickAdd(container: HTMLElement): void {
		const section = container.createDiv({ cls: "reminder-suite-section reminder-suite-quickadd" });
		section.createEl("h4", { text: "Quick add" });

		const row = section.createDiv({ cls: "reminder-suite-quickadd-row" });
		const input = new TextComponent(row);
		input.setPlaceholder('Add a task… e.g. "Call mom tomorrow 14:00"');
		input.inputEl.addClass("reminder-suite-quickadd-input");
		input.inputEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				void this.submitQuickAdd(input);
			}
		});
		new ButtonComponent(row).setButtonText("Add").onClick(() => {
			void this.submitQuickAdd(input);
		});

		const syncRow = section.createDiv({ cls: "reminder-suite-quickadd-sync" });
		syncRow.createSpan({ text: "Sync to Google" });
		this.quickAddSyncToggle = new ToggleComponent(syncRow).onChange((value) => {
			this.quickAddSync = value;
		});
		this.updateQuickAddSyncToggle();
	}

	/**
	 * Signing in or picking a default calendar can happen while this view is
	 * open, so the toggle's availability is re-evaluated rather than decided
	 * once at render time.
	 */
	private updateQuickAddSyncToggle(): void {
		const toggle = this.quickAddSyncToggle;
		if (toggle === null) {
			return;
		}
		const available = this.canSyncTasks();
		if (!available) {
			this.quickAddSync = false;
		}
		toggle.setDisabled(!available);
		toggle.setValue(this.quickAddSync);
		toggle.setTooltip(
			available
				? "Also create a Google Calendar event for new tasks"
				: "Sign in and pick a default task calendar in settings",
		);
	}

	private canSyncTasks(): boolean {
		return this.plugin.tokenStore.isSignedIn() && this.plugin.settings.defaultTaskCalendarId !== "";
	}

	private async submitQuickAdd(input: TextComponent): Promise<void> {
		const raw = input.getValue().trim();
		if (raw === "") {
			return;
		}
		let appended: { file: TFile; line: number };
		const task = this.buildQuickAddTask(raw);
		try {
			appended = await this.appendToTaskNote(serializeTask(task));
			input.setValue("");
		} catch (error) {
			new Notice(`ReminderSuite: ${errorMessage(error)}`);
			return;
		}

		if (!this.quickAddSync || !this.canSyncTasks()) {
			return;
		}
		// The engine re-locates the line inside vault.process before touching it,
		// so it works from what was just written rather than waiting for the
		// metadata cache to catch up and the index to re-read the file.
		try {
			await this.plugin.syncEngine.optIn(
				{ filePath: appended.file.path, line: appended.line, parsed: task },
				this.plugin.settings.defaultTaskCalendarId,
			);
		} catch (error) {
			new Notice(`ReminderSuite: ${errorMessage(error)}`);
		}
		await this.plugin.taskIndex.refreshFile(appended.file);
	}

	/**
	 * Parses quick-add text into a task. If the user already typed emoji
	 * metadata (e.g. "📅 2026-08-20"), the full parser handles it directly —
	 * constructing a synthetic checkbox line and parsing it reuses every rule
	 * in tasks/parser.ts for free. Otherwise falls back to natural-language
	 * mini-parsing of a trailing date/time.
	 */
	private buildQuickAddTask(rawText: string) {
		// parseTaskLine never returns null here: we control the "- [ ] " prefix.
		const parsed = parseTaskLine(`- [ ] ${rawText}`)!;
		if (parsed.due === null && parsed.reminder === null) {
			const { description, due, reminder } = naturalMiniParse(parsed.description);
			parsed.description = description;
			parsed.due = due;
			parsed.reminder = reminder;
		}
		return parsed;
	}

	/**
	 * Appends the line and reports where it landed, so a follow-up sync knows
	 * which line it's syncing. Targets the single task-source note when one is
	 * configured (otherwise the index would never see the new task), the inbox
	 * note otherwise.
	 */
	private async appendToTaskNote(line: string): Promise<{ file: TFile; line: number }> {
		const sourcePath = resolvedTaskSourcePath(this.plugin.settings);
		const path = sourcePath !== "" ? sourcePath : this.plugin.settings.inboxNotePath;
		let file = this.app.vault.getFileByPath(path);
		if (file === null) {
			file = await this.app.vault.create(path, sourcePath !== "" ? "# Tasks\n" : "# Inbox\n");
		}
		let appendedLine = 0;
		await this.app.vault.process(file, (content) => {
			const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
			const next = `${content}${sep}${line}\n`;
			// The trailing newline leaves an empty final element, so the appended
			// line is second from the end.
			appendedLine = next.split("\n").length - 2;
			return next;
		});
		return { file, line: appendedLine };
	}

	// ---- Today's agenda -------------------------------------------------

	private renderAgendaSection(container: HTMLElement): void {
		const section = container.createDiv({ cls: "reminder-suite-section reminder-suite-agenda" });
		const header = section.createDiv({ cls: "reminder-suite-section-header" });
		header.createEl("h4", { text: "Today" });
		new ButtonComponent(header)
			.setIcon("refresh-cw")
			.setTooltip("Sync with Google and refresh")
			.setClass("reminder-suite-agenda-refresh")
			.onClick(() => {
				// The same full cycle the poll tick runs, not just a re-fetch: a
				// user reaching for refresh wants their calendar reconciled, and
				// `syncNow` refreshes this view when it's done.
				void this.plugin.syncNow();
			});
		this.agendaListEl = section.createDiv({ cls: "reminder-suite-agenda-list" });
	}

	private renderAgendaMessage(text: string): void {
		const container = this.agendaListEl;
		if (container === null) {
			return;
		}
		container.empty();
		container.createEl("p", { cls: "reminder-suite-agenda-empty", text });
	}

	private renderAgendaRow(container: HTMLElement, ev: CalendarLibEvent): void {
		const row = container.createDiv({ cls: "reminder-suite-agenda-row" });
		const dot = row.createSpan({ cls: "reminder-suite-color-dot" });
		if (ev.backgroundColor !== undefined) {
			dot.style.backgroundColor = ev.backgroundColor;
		}
		row.createSpan({ cls: "reminder-suite-agenda-time", text: ev.allDay ? "all-day" : formatTime(ev.start) });
		row.createSpan({ cls: "reminder-suite-agenda-title", text: ev.title });
	}

	// ---- Tasks ------------------------------------------------------------

	private renderTasksSection(container: HTMLElement): void {
		const section = container.createDiv({ cls: "reminder-suite-section reminder-suite-tasks" });
		section.createEl("h4", { text: "Tasks" });
		this.tasksContainerEl = section.createDiv();
	}

	private scheduleRerender(): void {
		if (this.rerenderTimer !== null) {
			return;
		}
		this.rerenderTimer = setTimeout(() => {
			this.rerenderTimer = null;
			this.renderTasks();
		}, RERENDER_DEBOUNCE_MS);
	}

	private renderTasks(): void {
		const container = this.tasksContainerEl;
		if (container === null) {
			return;
		}
		const buckets = this.plugin.taskIndex.byBucket();
		container.empty();
		this.renderBucket(container, "overdue", buckets.overdue);
		this.renderBucket(container, "today", buckets.today);
		this.renderBucket(container, "upcoming", buckets.upcoming);
		this.renderBucket(container, "someday", buckets.someday);
	}

	private renderBucket(container: HTMLElement, key: BucketKey, tasks: IndexedTask[]): void {
		const details = container.createEl("details", { cls: "reminder-suite-bucket" });
		details.open = !this.collapsedBuckets.has(key);
		details.addEventListener("toggle", () => {
			if (details.open) {
				this.collapsedBuckets.delete(key);
			} else {
				this.collapsedBuckets.add(key);
			}
		});
		details.createEl("summary", { text: `${BUCKET_LABELS[key]} (${tasks.length})` });

		const list = details.createDiv({ cls: "reminder-suite-bucket-list" });
		if (tasks.length === 0) {
			list.createEl("p", { cls: "reminder-suite-bucket-empty", text: "Nothing here" });
			return;
		}
		for (const task of tasks) {
			this.renderTaskRow(list, task);
		}
	}

	private renderTaskRow(container: HTMLElement, task: IndexedTask): void {
		const row = container.createDiv({ cls: "reminder-suite-task-row" });

		const checkbox = row.createEl("input", { type: "checkbox", cls: "reminder-suite-task-checkbox" });
		checkbox.checked = task.parsed.checked === "x" || task.parsed.checked === "X";
		checkbox.addEventListener("change", () => {
			const nextChecked = checkbox.checked;
			checkbox.disabled = true;
			this.plugin.taskIndex
				.setTaskChecked(task, nextChecked)
				.catch((error: unknown) => {
					checkbox.checked = !nextChecked;
					new Notice(`ReminderSuite: ${errorMessage(error)}`);
				})
				.finally(() => {
					checkbox.disabled = false;
				});
		});

		const textEl = row.createEl("span", { cls: "reminder-suite-task-desc" });
		const prefix = priorityEmoji(task.parsed.priority);
		textEl.setText(prefix === "" ? task.parsed.description : `${prefix} ${task.parsed.description}`);
		textEl.addEventListener("click", () => {
			void this.openTaskSource(task);
		});

		const dateStr = task.parsed.due ?? task.parsed.scheduled;
		if (task.parsed.reminder !== null || dateStr !== null) {
			row.createEl("span", {
				cls: "reminder-suite-task-chip",
				text: task.parsed.reminder !== null ? task.parsed.reminder.time : (dateStr as string),
			});
		}

		if (this.plugin.syncEngine.isSynced(task)) {
			row.createEl("span", {
				cls: "reminder-suite-task-chip reminder-suite-gcal-chip",
				text: "GCal",
			});
		}

		row.addEventListener("contextmenu", (evt) => {
			evt.preventDefault();
			this.showTaskMenu(evt, task);
		});
	}

	private showTaskMenu(evt: MouseEvent, task: IndexedTask): void {
		const menu = new Menu();
		if (this.plugin.syncEngine.isSynced(task)) {
			menu.addItem((item) =>
				item
					.setTitle("Stop syncing")
					.setIcon("calendar-x")
					.onClick(() => {
						void this.setTaskSynced(task, false);
					}),
			);
		} else {
			menu.addItem((item) =>
				item
					.setTitle("Sync to Google Calendar")
					.setIcon("calendar-plus")
					.onClick(() => {
						void this.setTaskSynced(task, true);
					}),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Open task")
				.setIcon("file-text")
				.onClick(() => {
					void this.openTaskSource(task);
				}),
		);
		menu.showAtMouseEvent(evt);
	}

	/** Opts a task in or out of Google sync, then re-renders so its GCal chip matches. */
	private async setTaskSynced(task: IndexedTask, synced: boolean): Promise<void> {
		if (synced && !this.canSyncTasks()) {
			new Notice("ReminderSuite: sign in and pick a default task calendar in settings first.");
			return;
		}
		try {
			if (synced) {
				await this.plugin.syncEngine.optIn(task, this.plugin.settings.defaultTaskCalendarId);
				new Notice("ReminderSuite: task synced to Google Calendar.");
			} else {
				await this.plugin.syncEngine.optOut(task);
				new Notice("ReminderSuite: stopped syncing that task.");
			}
		} catch (error) {
			new Notice(`ReminderSuite: ${errorMessage(error)}`, 10000);
		}
		this.renderTasks();
	}

	private async openTaskSource(task: IndexedTask): Promise<void> {
		const file = this.app.vault.getFileByPath(task.filePath);
		if (file === null) {
			new Notice(`ReminderSuite: file not found: ${task.filePath}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file, { eState: { line: task.line } });
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view !== null) {
			const pos = { line: task.line, ch: 0 };
			view.editor.setCursor(pos);
			view.editor.scrollIntoView({ from: pos, to: pos }, true);
		}
	}
}
