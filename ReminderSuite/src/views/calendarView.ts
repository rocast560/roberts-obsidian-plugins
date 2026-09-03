import { ItemView, MarkdownView, Notice } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import { DayGrid, Interaction, TimeGrid, createCalendar, destroyCalendar } from "@event-calendar/core";
import type { Calendar } from "@event-calendar/core";
import { ReauthRequiredError } from "../auth/tokenStore.ts";
import { PreconditionFailedError } from "../gcal/errors.ts";
import type ReminderSuitePlugin from "../main.ts";
import type { GCalCalendarListEntry, GCalEvent, GCalEventInput } from "../gcal/types.ts";
import { isTaskCancelled, isTaskDone } from "../tasks/parser.ts";
import type { IndexedTask } from "../tasks/index.ts";
import { writableCalendars } from "../settings.ts";
import { toCalendarEvent } from "./eventMapping.ts";
import type { CalendarLibEvent } from "./eventMapping.ts";
import { CreateEventModal } from "./eventCreateModal.ts";
import type { CreateEventRequest } from "./eventCreateModal.ts";
import { EventEditModal } from "./eventEditModal.ts";

export const CALENDAR_VIEW_TYPE = "reminder-suite-calendar";

/** Padding added on both sides of the visible range before fetching, in ms. */
const RANGE_PAD_MS = 24 * 60 * 60 * 1000;

/** Distinct from Google's own calendar colors so vault-task events read as a separate source at a glance. */
const TASK_EVENT_COLOR = "#7c3aed";

const TASK_EVENT_ID_PREFIX = "task::";

/** New events created by clicking an empty slot run this long. */
const NEW_EVENT_MS = 60 * 60 * 1000;

interface VisibleRange {
	start: Date;
	end: Date;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isoDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** Formats a Date as a timezone-designator-less local ISO datetime (@event-calendar/core parses these as local time, not UTC). */
function localDateTimeISO(d: Date): string {
	const h = String(d.getHours()).padStart(2, "0");
	const min = String(d.getMinutes()).padStart(2, "0");
	return `${isoDate(d)}T${h}:${min}:00`;
}

function nextDayISODate(dateStr: string): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	return isoDate(new Date(y, m - 1, d + 1));
}

/** Parses a plain "YYYY-MM-DD" + "HH:mm" pair (both always local, no timezone concept) into a Date. */
function localDate(dateStr: string, time: string): Date {
	const [y, m, d] = dateStr.split("-").map(Number);
	const [hh, mm] = time.split(":").map(Number);
	return new Date(y, m - 1, d, hh, mm);
}

/** Pins a vault-task event: its times live in the markdown line, so dragging it here would be a lie. */
const TASK_EVENT_PINNED = { editable: false, startEditable: false, durationEditable: false };

/**
 * Maps one dated vault task to a calendar-lib event: all-day on its due date
 * (falling back to scheduled) when there's no reminder time, or a timed
 * 1-hour block starting at the ⏰ time when there is one. Never draggable or
 * resizable — only Google events are edited from this view.
 */
function taskToCalendarEvent(task: IndexedTask): CalendarLibEvent | null {
	const dateStr = task.parsed.due ?? task.parsed.scheduled;
	if (dateStr === null) {
		return null;
	}
	const id = `${TASK_EVENT_ID_PREFIX}${task.filePath}::${task.line}`;
	const title = task.parsed.description !== "" ? task.parsed.description : "(untitled task)";

	if (task.parsed.reminder !== null) {
		const start = localDate(task.parsed.reminder.date, task.parsed.reminder.time);
		const end = new Date(start.getTime() + 60 * 60 * 1000);
		return {
			id,
			title,
			start: localDateTimeISO(start),
			end: localDateTimeISO(end),
			allDay: false,
			backgroundColor: TASK_EVENT_COLOR,
			...TASK_EVENT_PINNED,
		};
	}
	return {
		id,
		title,
		start: dateStr,
		end: nextDayISODate(dateStr),
		allDay: true,
		backgroundColor: TASK_EVENT_COLOR,
		...TASK_EVENT_PINNED,
	};
}

/**
 * `${calendarId}::${eventId}` — split from the right, since a calendar id is
 * user data (an email address) while Google's event ids are `[a-v0-9]+`.
 * Returns null for task-derived ids, which are handled separately.
 */
function parseGCalEventId(id: string): { calendarId: string; eventId: string } | null {
	if (id.startsWith(TASK_EVENT_ID_PREFIX)) {
		return null;
	}
	const lastSep = id.lastIndexOf("::");
	if (lastSep === -1) {
		return null;
	}
	return { calendarId: id.slice(0, lastSep), eventId: id.slice(lastSep + 2) };
}

/** `task::${filePath}::${line}` — split from the right so a `::` inside a file path can't confuse the parse. */
function parseTaskEventId(id: string): { filePath: string; line: number } | null {
	if (!id.startsWith(TASK_EVENT_ID_PREFIX)) {
		return null;
	}
	const rest = id.slice(TASK_EVENT_ID_PREFIX.length);
	const lastSep = rest.lastIndexOf("::");
	if (lastSep === -1) {
		return null;
	}
	const line = Number.parseInt(rest.slice(lastSep + 2), 10);
	if (Number.isNaN(line)) {
		return null;
	}
	return { filePath: rest.slice(0, lastSep), line };
}

/**
 * Main-area view that renders Google Calendar events with @event-calendar/core.
 *
 * Google events are editable in place — drag or resize writes the new times
 * back with `If-Match`, clicking an empty slot creates an event, and clicking
 * an event opens the edit modal (rename/retime/delete, or a Google Calendar
 * hand-off for recurring events). Vault-task events are read-only here: their
 * times live in the markdown line, so they're edited by editing the task.
 */
export class CalendarView extends ItemView {
	private plugin: ReminderSuitePlugin;
	private calendar: Calendar | null = null;
	private currentRange: VisibleRange | null = null;
	/** Bumped on every fetch; a resolving fetch discards its result if it's no longer current. */
	private fetchSequence = 0;
	/** Suppresses repeat Notices while a run of consecutive fetches keeps failing. */
	private lastFetchFailed = false;
	/** Unsubscribes from `taskIndex.onChange`; set in onOpen, cleared in onClose. */
	private unsubscribeTaskIndex: (() => void) | null = null;
	/** `${calendarId}::${eventId}` → etag of the version last fetched, so an edit can't clobber a newer one. */
	private etagByEvent = new Map<string, string>();
	/** `${calendarId}::${eventId}` → the raw event as last fetched; feeds the edit modal's prefill. */
	private gcalEventByKey = new Map<string, GCalEvent>();
	/** Calendar list from the last successful fetch; feeds the create-event modal without another round trip. */
	private knownCalendars: GCalCalendarListEntry[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: ReminderSuitePlugin) {
		super(leaf);
		this.plugin = plugin;
		// A calendar is a persistent workspace surface, not something you navigate
		// away from like a file — matches Obsidian's guidance for view types such
		// as this one.
		this.navigation = false;
	}

	getViewType(): string {
		return CALENDAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "ReminderSuite Calendar";
	}

	getIcon(): string {
		return "calendar-days";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("reminder-suite-calendar-container");
		const mountEl = container.createDiv({ cls: "reminder-suite-calendar" });

		// The lib ships its own light/dark theme (toggled via this class); we
		// follow Obsidian's active theme rather than forking the lib's CSS.
		if (document.body.classList.contains("theme-dark")) {
			mountEl.addClass("ec-dark");
		}

		this.calendar = createCalendar(mountEl, [DayGrid, TimeGrid, Interaction], {
			view: "dayGridMonth",
			// Google events are draggable and resizable; vault-task events opt out
			// per-event (see TASK_EVENT_PINNED — the per-event flags are the only
			// ones that outrank these globals).
			editable: true,
			eventStartEditable: true,
			eventDurationEditable: true,
			headerToolbar: {
				start: "prev,next today",
				center: "title",
				end: "dayGridMonth,timeGridWeek,timeGridDay refresh",
			},
			customButtons: {
				refresh: {
					text: "Refresh",
					click: () => {
						void this.refetch();
					},
				},
			},
			datesSet: (info) => {
				this.currentRange = { start: info.start, end: info.end };
				void this.fetchWindow(info.start, info.end);
			},
			eventClick: (info) => {
				const id = String(info.event.id);
				const taskRef = parseTaskEventId(id);
				if (taskRef !== null) {
					void this.openTaskEvent(taskRef.filePath, taskRef.line);
					return;
				}
				this.promptEditEvent(id);
			},
			dateClick: (info) => {
				void this.promptCreateEvent(info.date, info.allDay);
			},
			eventDrop: (info) => {
				void this.applyEventMove(info.event, info.revert);
			},
			eventResize: (info) => {
				void this.applyEventMove(info.event, info.revert);
			},
		});

		// Vault-task events aren't necessarily current yet (a restored view can
		// mount before taskIndex.rebuild() resolves) and never redraw on their
		// own otherwise — a task completed/edited via the sidebar or a file
		// edit needs to be reflected here too, independent of the Google poll
		// interval and its signed-in/enabled-calendars gate.
		this.unsubscribeTaskIndex = this.plugin.taskIndex.onChange(() => {
			void this.refetch();
		});
	}

	async onClose(): Promise<void> {
		if (this.unsubscribeTaskIndex !== null) {
			this.unsubscribeTaskIndex();
			this.unsubscribeTaskIndex = null;
		}
		// Invalidate any in-flight fetch so it can't call setOption after teardown.
		this.fetchSequence++;
		this.currentRange = null;
		if (this.calendar !== null) {
			const calendar = this.calendar;
			this.calendar = null;
			await destroyCalendar(calendar);
		}
	}

	/** Re-fetches events for the currently visible range. Public: sync engine and sidebar trigger this. */
	async refetch(): Promise<void> {
		if (this.currentRange === null) {
			return;
		}
		await this.fetchWindow(this.currentRange.start, this.currentRange.end);
	}

	private async fetchWindow(rangeStart: Date, rangeEnd: Date): Promise<void> {
		const requestToken = ++this.fetchSequence;
		const enabledIds = this.plugin.settings.enabledCalendarIds;

		const paddedStart = new Date(rangeStart.getTime() - RANGE_PAD_MS);
		const paddedEnd = new Date(rangeEnd.getTime() + RANGE_PAD_MS);
		const taskEvents = this.collectTaskEvents(paddedStart, paddedEnd);

		if (enabledIds.length === 0) {
			if (requestToken === this.fetchSequence) {
				this.calendar?.setOption("events", taskEvents);
			}
			return;
		}

		const timeMinISO = paddedStart.toISOString();
		const timeMaxISO = paddedEnd.toISOString();

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
		const etags = new Map<string, string>();
		const rawEvents = new Map<string, GCalEvent>();
		await Promise.all(
			enabledIds.map(async (calendarId) => {
				try {
					const { events } = await this.plugin.gcalClient.listEventsWindow(
						calendarId,
						timeMinISO,
						timeMaxISO,
					);
					for (const ev of events) {
						if (ev.status === "cancelled") {
							continue;
						}
						const libEvent = toCalendarEvent(calendarId, ev, colorById.get(calendarId));
						mapped.push(libEvent);
						etags.set(libEvent.id, ev.etag);
						rawEvents.set(libEvent.id, ev);
					}
				} catch (error) {
					anyFailed = true;
					if (error instanceof ReauthRequiredError) {
						reauthRequired = true;
					}
				}
			}),
		);

		if (requestToken !== this.fetchSequence) {
			// A newer fetch superseded this one; discard the stale result.
			return;
		}

		if (calendars.length > 0) {
			this.knownCalendars = calendars;
		}
		this.etagByEvent = etags;
		this.gcalEventByKey = rawEvents;
		this.calendar?.setOption("events", [...mapped, ...taskEvents]);

		if (anyFailed) {
			this.reportFailure(reauthRequired);
		} else {
			this.lastFetchFailed = false;
		}
	}

	// ---- Creating and editing Google events -------------------------------

	/**
	 * Opens the new-event modal for a clicked slot. Only calendars that are
	 * both writable and enabled for display are offered — creating an event in
	 * a calendar this view doesn't show would look like nothing happened.
	 */
	private async promptCreateEvent(date: Date, allDay: boolean): Promise<void> {
		if (!this.plugin.tokenStore.isSignedIn()) {
			new Notice("Sign in to Google in ReminderSuite settings");
			return;
		}
		const enabled = new Set(this.plugin.settings.enabledCalendarIds);
		if (enabled.size === 0) {
			new Notice("ReminderSuite: enable a calendar in settings first.");
			return;
		}

		if (this.knownCalendars.length === 0) {
			try {
				this.knownCalendars = await this.plugin.gcalClient.listCalendars();
			} catch (error) {
				new Notice(`ReminderSuite: ${errorMessage(error)}`);
				return;
			}
		}

		const choices = writableCalendars(this.knownCalendars).filter((cal) => enabled.has(cal.id));
		if (choices.length === 0) {
			new Notice("ReminderSuite: enable a calendar you can write to first.");
			return;
		}

		new CreateEventModal(this.app, {
			calendars: choices,
			defaultCalendarId: this.plugin.settings.defaultTaskCalendarId,
			date,
			allDay,
			onSubmit: (request) => {
				void this.createEvent(date, request);
			},
		}).open();
	}

	private async createEvent(date: Date, request: CreateEventRequest): Promise<void> {
		const input: GCalEventInput = request.allDay
			? {
					summary: request.title,
					start: { date: isoDate(date) },
					end: { date: nextDayISODate(isoDate(date)) },
				}
			: {
					summary: request.title,
					// A UTC instant is unambiguous, so no timeZone field is needed.
					start: { dateTime: date.toISOString() },
					end: { dateTime: new Date(date.getTime() + NEW_EVENT_MS).toISOString() },
				};
		try {
			await this.plugin.gcalClient.createEvent(request.calendarId, input);
		} catch (error) {
			new Notice(`ReminderSuite: ${errorMessage(error)}`);
			return;
		}
		await this.refetch();
	}

	/**
	 * Writes a dragged or resized Google event's new times back, guarded by the
	 * etag from the fetch that put it on screen. A 412 means someone else moved
	 * it first: the drag is reverted rather than overwriting their change.
	 */
	private async applyEventMove(event: Calendar.Event, revert: () => void): Promise<void> {
		const ref = parseGCalEventId(String(event.id));
		if (ref === null) {
			// A task event somehow moved (it shouldn't be editable) — undo it.
			revert();
			return;
		}

		const key = `${ref.calendarId}::${ref.eventId}`;
		const patch: GCalEventInput = event.allDay
			? { start: { date: isoDate(event.start) }, end: { date: isoDate(event.end) } }
			: { start: { dateTime: event.start.toISOString() }, end: { dateTime: event.end.toISOString() } };

		try {
			const updated = await this.plugin.gcalClient.patchEvent(
				ref.calendarId,
				ref.eventId,
				patch,
				this.etagByEvent.get(key),
			);
			this.etagByEvent.set(key, updated.etag);
		} catch (error) {
			revert();
			if (error instanceof PreconditionFailedError) {
				new Notice("Event changed in Google — refresh");
			} else {
				new Notice(`ReminderSuite: ${errorMessage(error)}`);
			}
			await this.refetch();
		}
	}

	/**
	 * Opens the edit modal for a clicked Google-born event. Recurring
	 * occurrences, events mirroring vault tasks, and read-only calendars get
	 * the hand-off mode instead of editable fields: Google's UI owns series
	 * semantics, and a synced task is edited through its markdown line.
	 */
	private promptEditEvent(id: string): void {
		const ref = parseGCalEventId(id);
		if (ref === null) {
			return;
		}
		const event = this.gcalEventByKey.get(id);
		if (event === undefined) {
			new Notice("ReminderSuite: event not loaded yet — refresh and try again.");
			return;
		}
		const calendarEntry = this.knownCalendars.find((cal) => cal.id === ref.calendarId);
		// An unknown calendar (the list fetch failed) is treated as writable:
		// the server is the real gate, and a wrong guess only costs an error
		// Notice on save.
		const writable = calendarEntry === undefined || writableCalendars([calendarEntry]).length > 0;
		const isRecurring = event.recurringEventId !== undefined || event.recurrence !== undefined;
		const isTaskMirror = event.extendedProperties?.private?.reminderSuite === "1";

		let readOnlyReason: string | undefined;
		if (isTaskMirror) {
			readOnlyReason = "This event mirrors a vault task — edit the task line (or use the sidebar) instead.";
		} else if (isRecurring) {
			readOnlyReason = "This is one occurrence of a repeating event. Edit the series in Google Calendar.";
		} else if (!writable) {
			readOnlyReason = "You don't have write access to this calendar.";
		}

		new EventEditModal(this.app, {
			event,
			calendarName: calendarEntry?.summary ?? ref.calendarId,
			editable: readOnlyReason === undefined,
			readOnlyReason,
			onSave: (patch) => {
				void this.applyEventEdit(ref, id, patch);
			},
			onDelete: () => {
				void this.applyEventDelete(ref, id);
			},
		}).open();
	}

	private async applyEventEdit(
		ref: { calendarId: string; eventId: string },
		key: string,
		patch: GCalEventInput,
	): Promise<void> {
		try {
			const updated = await this.plugin.gcalClient.patchEvent(
				ref.calendarId,
				ref.eventId,
				patch,
				this.etagByEvent.get(key),
			);
			this.etagByEvent.set(key, updated.etag);
			this.gcalEventByKey.set(key, updated);
		} catch (error) {
			if (error instanceof PreconditionFailedError) {
				new Notice("Event changed in Google — refresh");
			} else {
				new Notice(`ReminderSuite: ${errorMessage(error)}`);
			}
		}
		await this.refetch();
	}

	private async applyEventDelete(ref: { calendarId: string; eventId: string }, key: string): Promise<void> {
		try {
			await this.plugin.gcalClient.deleteEvent(ref.calendarId, ref.eventId, this.etagByEvent.get(key));
		} catch (error) {
			if (error instanceof PreconditionFailedError) {
				new Notice("Event changed in Google — refresh");
			} else {
				new Notice(`ReminderSuite: ${errorMessage(error)}`);
			}
		}
		await this.refetch();
	}

	/** Shows a Notice for the first failure in a run; stays quiet for repeats until a fetch succeeds. */
	private reportFailure(reauthRequired: boolean): void {
		if (this.lastFetchFailed) {
			return;
		}
		this.lastFetchFailed = true;
		if (reauthRequired) {
			new Notice("Sign in to Google in ReminderSuite settings");
		} else {
			new Notice("ReminderSuite: failed to load calendar events.");
		}
	}

	/**
	 * Dated, non-done, non-cancelled vault tasks whose date falls within the
	 * padded range. Filters on the same date `taskToCalendarEvent` renders
	 * at — `reminder?.date ?? due ?? scheduled` — so a task with a ⏰ on a
	 * different date than its 📅/⏳ can't pass this filter and then render
	 * outside the window (or vice versa).
	 */
	private collectTaskEvents(rangeStart: Date, rangeEnd: Date): CalendarLibEvent[] {
		const startBound = isoDate(rangeStart);
		const endBound = isoDate(rangeEnd);
		const events: CalendarLibEvent[] = [];
		for (const task of this.plugin.taskIndex.all()) {
			if (isTaskDone(task.parsed) || isTaskCancelled(task.parsed)) {
				continue;
			}
			const dateStr = task.parsed.reminder?.date ?? task.parsed.due ?? task.parsed.scheduled;
			if (dateStr === null || dateStr < startBound || dateStr > endBound) {
				continue;
			}
			const mapped = taskToCalendarEvent(task);
			if (mapped !== null) {
				events.push(mapped);
			}
		}
		return events;
	}

	/** Opens a task-derived event's source file at its line, mirroring the sidebar's click-to-source behavior. */
	private async openTaskEvent(filePath: string, line: number): Promise<void> {
		const file = this.app.vault.getFileByPath(filePath);
		if (file === null) {
			new Notice(`ReminderSuite: file not found: ${filePath}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file, { eState: { line } });
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view !== null) {
			const pos = { line, ch: 0 };
			view.editor.setCursor(pos);
			view.editor.scrollIntoView({ from: pos, to: pos }, true);
		}
	}
}
