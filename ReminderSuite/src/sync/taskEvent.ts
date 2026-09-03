/**
 * Translation between a vault task line and a Google Calendar event.
 *
 * Pure module: no `obsidian` import, no clock, no randomness — every
 * environment-dependent value (the time zone, the reminder default, the
 * completion strategy) is injected by the caller, so this is directly
 * unit-testable and the engine stays the only place that reads the world.
 *
 * Both directions live here: `taskToEventInput` (push) and `applyEventToTask`
 * (pull). They are each other's inverse for the fields an event can carry, and
 * a round-trip test holds them to it.
 */

import { isTaskDone } from "../tasks/parser.ts";
import type { ParsedTask, TaskReminder } from "../tasks/parser.ts";
import type { GCalEvent, GCalEventInput } from "../gcal/types.ts";

/** What to do with an event whose task got completed. Mirrors the `completedTaskStrategy` setting. */
export type CompletedTaskStrategy = "retitle" | "delete";

export interface TaskEventDefaults {
	/** Popup reminder lead time in minutes; `null` defers to the calendar's own defaults. */
	reminderMinutes: number | null;
	/** IANA zone (e.g. "America/Los_Angeles") that a task's wall-clock ⏰ time is interpreted in. */
	timeZone: string;
}

/** Prefixed to a completed task's event summary under the "retitle" strategy. */
const COMPLETED_PREFIX = "✓ ";
/** A task with a ⏰ time becomes a block of this length; tasks carry no duration of their own. */
const TIMED_EVENT_MINUTES = 60;
const MINUTES_PER_DAY = 24 * 60;

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Civil-date arithmetic on a "YYYY-MM-DD" string. Uses UTC internally so the machine's zone can't shift the result. */
function addDaysISO(dateStr: string, days: number): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	const shifted = new Date(Date.UTC(y, m - 1, d + days));
	return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/**
 * Adds minutes to a wall-clock date+time, rolling the date over as needed.
 * Deliberately wall-clock rather than instant arithmetic: the result is paired
 * with an explicit `timeZone`, and Google resolves it in that zone.
 */
function addMinutes(dateStr: string, time: string, minutes: number): { date: string; time: string } {
	const [hh, mm] = time.split(":").map(Number);
	const total = hh * 60 + mm + minutes;
	const dayOffset = Math.floor(total / MINUTES_PER_DAY);
	const withinDay = total - dayOffset * MINUTES_PER_DAY;
	return {
		date: addDaysISO(dateStr, dayOffset),
		time: `${pad2(Math.floor(withinDay / 60))}:${pad2(withinDay % 60)}`,
	};
}

/**
 * Whether this task can be placed on a calendar at all. Exported so a caller
 * can check before doing anything irreversible — the engine stamps a block id
 * into the user's note on opt-in, which shouldn't happen for a task that was
 * never going to sync.
 *
 * Kept in step with `taskToEventInput`'s null case by a test that asserts the
 * two agree.
 */
export function isEventWorthy(parsed: ParsedTask): boolean {
	return parsed.reminder !== null || parsed.due !== null;
}

/**
 * Maps a task to the event body to create or patch, or `null` when the task
 * isn't event-worthy — no ⏰ and no 📅. (⏳ scheduled deliberately doesn't
 * count: it's a planning hint, not a commitment on the calendar.)
 *
 * A ⏰ reminder wins over 📅 and produces a timed one-hour block; otherwise
 * the task is an all-day event on its due date, with the exclusive end date
 * Google expects.
 */
export function taskToEventInput(
	parsed: ParsedTask,
	blockId: string,
	defaults: TaskEventDefaults,
	strategy: CompletedTaskStrategy,
): GCalEventInput | null {
	const description = parsed.description.trimEnd();
	const completed = isTaskDone(parsed);
	const summary = completed && strategy === "retitle" ? `${COMPLETED_PREFIX}${description}` : description;

	const reminders =
		defaults.reminderMinutes !== null
			? { useDefault: false, overrides: [{ method: "popup", minutes: defaults.reminderMinutes }] }
			: { useDefault: true };

	const common = {
		summary,
		reminders,
		extendedProperties: { private: { reminderSuite: "1", blockId } },
	};

	if (parsed.reminder !== null) {
		const { date, time } = parsed.reminder;
		const end = addMinutes(date, time, TIMED_EVENT_MINUTES);
		return {
			...common,
			start: { dateTime: `${date}T${time}:00`, timeZone: defaults.timeZone },
			end: { dateTime: `${end.date}T${end.time}:00`, timeZone: defaults.timeZone },
		};
	}

	if (parsed.due !== null) {
		return {
			...common,
			start: { date: parsed.due },
			end: { date: addDaysISO(parsed.due, 1) },
		};
	}

	return null;
}

export interface ApplyEventDefaults {
	/** Mirrors the `completedTaskStrategy` setting; only "retitle" gives a ✓ summary meaning. */
	strategy: CompletedTaskStrategy;
	/** Today as YYYY-MM-DD, stamped as ✅ when a remote ✓ completes a task. Injected so this stays clock-free. */
	todayISO: string;
	/**
	 * IANA zone to read an instant in when the event names no zone of its own —
	 * in practice the user's. Injected rather than read from the machine so this
	 * module stays pure and its tests can't depend on where they run.
	 */
	fallbackTimeZone: string;
}

/** The leading civil date and wall-clock time of an event's `dateTime`. */
const DATE_TIME_PREFIX = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/u;
/** A trailing `Z` or `±HH:MM`: what makes a dateTime an instant rather than a wall clock. */
const ZONE_DESIGNATOR = /(?:Z|[+-]\d{2}:?\d{2})$/u;
/** An Obsidian tag inside a task's description. */
const TAG_TOKEN = /#[\p{L}\p{N}_/-]+/gu;

/** The tags in a description, in order, de-duplicated. */
function tagsIn(text: string): string[] {
	return [...new Set(text.match(TAG_TOKEN) ?? [])];
}

/**
 * The wall-clock date and time of an instant in `timeZone`. Returns null for a
 * zone Intl doesn't recognize, so a caller can fall back instead of throwing.
 *
 * `hourCycle: "h23"` rather than `hour12: false`: the latter renders midnight
 * as hour 24 in some ICU builds, which would put an unparseable "24:00" into
 * the user's note.
 */
function wallClockInZone(instantMs: number, timeZone: string): TaskReminder | null {
	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		}).formatToParts(new Date(instantMs));
	} catch {
		return null;
	}
	const field = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
		parts.find((part) => part.type === type)?.value;
	const [year, month, day, hour, minute] = [
		field("year"),
		field("month"),
		field("day"),
		field("hour"),
		field("minute"),
	];
	if (
		year === undefined ||
		month === undefined ||
		day === undefined ||
		hour === undefined ||
		minute === undefined
	) {
		return null;
	}
	return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
}

/**
 * The wall-clock time a task's ⏰ should carry for a timed event.
 *
 * A `dateTime` with no `Z` and no offset is already a wall clock — that's what
 * this plugin writes, paired with an explicit `timeZone` — and is taken as
 * written. One that carries a designator is an *instant*, and reading its
 * leading characters would state the time in whatever zone the writing client
 * happened to use: a UTC-form event would put 14:00 on a task that is really at
 * 09:00. Those are converted into the event's own `timeZone`, or, when it
 * declares none, into `fallbackTimeZone` — the instant is unambiguous either
 * way, and a ⏰ is a time the user will act on, so it belongs in a zone they
 * live in rather than one an API chose.
 *
 * Anything unparseable falls back to the literal wall clock: a time that may be
 * in the wrong zone still beats dropping the reminder.
 */
function eventWallClock(dateTime: string, timeZone: string | undefined, fallbackTimeZone: string): TaskReminder | null {
	const literal = DATE_TIME_PREFIX.exec(dateTime);
	if (literal === null) {
		return null;
	}
	const asWritten: TaskReminder = { date: literal[1], time: literal[2] };
	if (!ZONE_DESIGNATOR.test(dateTime)) {
		return asWritten;
	}
	// Safe from the machine's zone: a designator is present, so this is never the
	// spec's "interpret a bare date-time as local" case.
	const instant = Date.parse(dateTime);
	if (Number.isNaN(instant)) {
		return asWritten;
	}
	return wallClockInZone(instant, timeZone ?? fallbackTimeZone) ?? asWritten;
}

/**
 * Remote→local translation: the half of the loop that lets an edit made in
 * Google reach the task line. Returns a new task; `parsed` is never mutated.
 *
 * What it maps: the summary becomes the description (minus the ✓ this plugin
 * writes for completed tasks), and the event's start becomes the task's dates —
 * a timed event is a ⏰ plus a 📅 on the same day, an all-day event is a 📅
 * with no ⏰.
 *
 * What it deliberately leaves alone: priority, recurrence, block id, indent,
 * the non-due dates, and completion. Those have no representation on a Google
 * event, so a pulled event carries no opinion about them — the single
 * exception is a ✓-prefixed summary under the "retitle" strategy, which is this
 * plugin's own marker coming home and does complete the task. The reverse
 * (a ✓ disappearing) never un-completes anything: completion travels vault →
 * Google only.
 *
 * Tags are part of a task's description rather than a field, so any tag the new
 * summary dropped is re-appended. Losing one would not just delete text — it
 * can drop the task out of a `taskFilterTag`-filtered index entirely.
 */
export function applyEventToTask(parsed: ParsedTask, event: GCalEvent, defaults: ApplyEventDefaults): ParsedTask {
	const next: ParsedTask = { ...parsed };

	if (event.summary !== undefined) {
		const completedRemotely = event.summary.startsWith(COMPLETED_PREFIX);
		const summary = (completedRemotely ? event.summary.slice(COMPLETED_PREFIX.length) : event.summary).trim();
		// An untitled event would otherwise erase the task's text, so an empty
		// summary is read as "no opinion" rather than "no description".
		if (summary !== "") {
			const restored = tagsIn(parsed.description).filter((tag) => !tagsIn(summary).includes(tag));
			next.description = restored.length === 0 ? summary : `${summary} ${restored.join(" ")}`;
		}
		if (completedRemotely && defaults.strategy === "retitle" && !isTaskDone(next)) {
			next.checked = "x";
			next.done = parsed.done ?? defaults.todayISO;
		}
	}

	const start = event.start;
	if (start?.dateTime !== undefined) {
		const wallClock = eventWallClock(start.dateTime, start.timeZone, defaults.fallbackTimeZone);
		if (wallClock !== null) {
			next.reminder = wallClock;
			// The 📅 follows the ⏰: converting zones can move the event onto the
			// previous or next day, and the two must not disagree.
			next.due = wallClock.date;
		}
	} else if (start?.date !== undefined) {
		next.due = start.date;
		next.reminder = null;
	}

	return next;
}
