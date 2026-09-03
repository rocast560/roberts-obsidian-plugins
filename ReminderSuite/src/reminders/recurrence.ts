/**
 * Recurrence rules for the 🔁 field (Tasks-plugin subset) and the rollover that
 * applies one when a recurring task is completed.
 *
 * Pure module: no `obsidian` import, no `Date.now()` — every clock-dependent
 * value (the completion date) is a parameter, so this is directly
 * unit-testable and the caller (`tasks/index.ts`) stays the only place that
 * reads the world. All date math runs on `YYYY-MM-DD` strings via
 * `Date.UTC(...)` construction, never the machine's local zone, so a run at
 * 23:30 vs 00:30 can never shift a date by a day (see `taskEvent.ts`'s
 * `addDaysISO`, which this mirrors).
 */

import { isTaskCancelled, isTaskDone } from "../tasks/parser.ts";
import type { ParsedTask } from "../tasks/parser.ts";

export type RecurrenceUnit = "day" | "week" | "month" | "year";

/** One parsed 🔁 rule. */
export interface Recurrence {
	/** N in "every N weeks"; 1 when omitted ("every week"). Always >= 1. */
	interval: number;
	unit: RecurrenceUnit;
	/** "every week when done" — the next occurrence is computed from the completion date, not the task's own due/scheduled date. */
	whenDone: boolean;
	/** 0 (Sunday) .. 6 (Saturday) for the "every <weekday>" grammar; `null` for the N-unit grammar. */
	weekday: number | null;
}

/** The subset of a task's date fields that recurrence advances, by name. `reminder` is its ⏰ date only — the HH:mm is a rollover concern, not this module's. */
export interface RecurrenceBase {
	due?: string;
	scheduled?: string;
	reminder?: string;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const UNIT_WORDS: Record<string, RecurrenceUnit> = {
	day: "day",
	days: "day",
	week: "week",
	weeks: "week",
	month: "month",
	months: "month",
	year: "year",
	years: "year",
};

const WHEN_DONE = /\s+when done\s*$/u;
const WEEKDAY_FORM = /^every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/u;
const UNIT_FORM = /^every\s+(\d+\s+)?(day|days|week|weeks|month|months|year|years)$/u;

/**
 * Parses a raw 🔁 string (e.g. "every 2 weeks", "every month when done",
 * "every monday"). Returns `null` for anything outside this subset — no
 * ordinal days ("every month on the 15th"), no "every other week", nothing
 * Tasks-plugin supports beyond this grammar. A `null` here is not an error:
 * the caller lets the task complete without rolling over.
 */
export function parseRecurrence(raw: string): Recurrence | null {
	const trimmed = raw.trim().toLowerCase();
	const whenDoneMatch = WHEN_DONE.exec(trimmed);
	const whenDone = whenDoneMatch !== null;
	const body = (whenDone ? trimmed.slice(0, whenDoneMatch.index) : trimmed).trim();

	const weekdayMatch = WEEKDAY_FORM.exec(body);
	if (weekdayMatch !== null) {
		return { interval: 1, unit: "week", whenDone, weekday: WEEKDAYS.indexOf(weekdayMatch[1]) };
	}

	const unitMatch = UNIT_FORM.exec(body);
	if (unitMatch !== null) {
		const interval = unitMatch[1] !== undefined ? Number.parseInt(unitMatch[1].trim(), 10) : 1;
		if (interval < 1) {
			return null;
		}
		return { interval, unit: UNIT_WORDS[unitMatch[2]], whenDone, weekday: null };
	}

	return null;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Civil-date arithmetic on a "YYYY-MM-DD" string, UTC-anchored so the machine's zone can't shift the result. */
export function addDaysISO(dateStr: string, days: number): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	const shifted = new Date(Date.UTC(y, m - 1, d + days));
	return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** The number of days in `year`-`month1to12`, e.g. `daysInMonthUTC(2026, 2) === 28`. */
function daysInMonthUTC(year: number, month1to12: number): number {
	return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** Adds whole months, clamping the day into the target month (Jan 31 + 1 month → Feb 28 or 29). */
function addMonthsClamped(dateStr: string, months: number): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	const totalMonths = m - 1 + months;
	const newYear = y + Math.floor(totalMonths / 12);
	const newMonth = (((totalMonths % 12) + 12) % 12) + 1;
	const clampedDay = Math.min(d, daysInMonthUTC(newYear, newMonth));
	return `${newYear}-${pad2(newMonth)}-${pad2(clampedDay)}`;
}

/** Adds whole years, clamping Feb 29 into Feb 28 when the target year isn't a leap year. */
function addYearsClamped(dateStr: string, years: number): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	const newYear = y + years;
	const clampedDay = Math.min(d, daysInMonthUTC(newYear, m));
	return `${newYear}-${pad2(m)}-${pad2(clampedDay)}`;
}

/** The next date, strictly after `dateStr`, that falls on `targetWeekday` (0=Sunday..6=Saturday). Always >= 1 day forward, even when `dateStr` itself is already that weekday. */
function nextWeekdayAfter(dateStr: string, targetWeekday: number): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	const currentWeekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	const diff = (targetWeekday - currentWeekday + 7) % 7;
	return addDaysISO(dateStr, diff === 0 ? 7 : diff);
}

/** The whole-day span between two "YYYY-MM-DD" strings (`b` minus `a`), UTC-anchored. */
function diffDaysUTC(a: string, b: string): number {
	const [ay, am, ad] = a.split("-").map(Number);
	const [by, bm, bd] = b.split("-").map(Number);
	return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Advances one anchor date by `rec`'s rule: the weekday form if present, otherwise the N-unit form with month/year clamping. */
function advanceAnchor(anchor: string, rec: Recurrence): string {
	if (rec.weekday !== null) {
		return nextWeekdayAfter(anchor, rec.weekday);
	}
	switch (rec.unit) {
		case "day":
			return addDaysISO(anchor, rec.interval);
		case "week":
			return addDaysISO(anchor, rec.interval * 7);
		case "month":
			return addMonthsClamped(anchor, rec.interval);
		case "year":
			return addYearsClamped(anchor, rec.interval);
	}
}

/**
 * The next occurrence's date fields, or `null` when `base` carries no dates
 * to advance at all.
 *
 * One anchor date drives the interval math: `doneDateISO` under `when done`,
 * otherwise `base.due ?? base.scheduled` (falling back to `base.reminder`
 * when neither is set — a task with only a ⏰ still needs something to anchor
 * month/year clamping on). The anchor is advanced by `rec`'s rule, and the
 * resulting day-delta is then applied identically to every field present in
 * `base` — not each field readvanced from its own value — so a task's
 * due/scheduled/⏰ keep whatever offset they had from each other before the
 * rollover. This is a deliberate reading of "advance every date field
 * present by the same interval": "the same interval" is the single delta
 * computed once from the anchor, not a per-field recomputation, which is what
 * keeps (for example) a "due 2 days after scheduled" task 2 days apart after
 * every recurrence instead of collapsing both onto the same date.
 */
export function nextOccurrence(
	rec: Recurrence,
	base: RecurrenceBase,
	doneDateISO: string,
): RecurrenceBase | null {
	if (base.due === undefined && base.scheduled === undefined && base.reminder === undefined) {
		return null;
	}
	const anchor = rec.whenDone ? doneDateISO : (base.due ?? base.scheduled ?? base.reminder ?? doneDateISO);
	const nextAnchor = advanceAnchor(anchor, rec);
	const deltaDays = diffDaysUTC(anchor, nextAnchor);

	const result: RecurrenceBase = {};
	if (base.due !== undefined) {
		result.due = addDaysISO(base.due, deltaDays);
	}
	if (base.scheduled !== undefined) {
		result.scheduled = addDaysISO(base.scheduled, deltaDays);
	}
	if (base.reminder !== undefined) {
		result.reminder = addDaysISO(base.reminder, deltaDays);
	}
	return result;
}

/**
 * Whether completing a task (`checked: true`) should attempt a recurrence
 * rollover at all, rather than a plain checkbox flip: the task must be
 * transitioning *into* done (not already done, and not cancelled — a
 * cancelled task's `checked` is `"-"`, which `isTaskDone` doesn't recognize,
 * so that exclusion has to be explicit), and it must carry a 🔁 string.
 *
 * This only gates the *attempt*: it doesn't check whether the string
 * actually parses. `rollover` itself does that and returns `null` for an
 * unsupported grammar, and the caller falls back to a plain completion in
 * that case — this predicate stays cheap and doesn't duplicate that work.
 */
export function shouldRollover(parsed: ParsedTask, checked: boolean): boolean {
	return checked && !isTaskDone(parsed) && !isTaskCancelled(parsed) && parsed.recurrence !== null;
}

/**
 * What a recurring task's completion turns into: the line as completed
 * (checked, stamped ✅), and the fresh next occurrence to insert above it.
 * `null` when `parsed.recurrence` is absent or doesn't parse — the caller
 * completes the task with no rollover in that case.
 *
 * `next` deliberately does not carry `parsed.blockId`: block ids are how this
 * plugin's Google sync identifies a task, and copying it onto the new
 * occurrence would make an unrelated future task look like the one already
 * synced. The conservative choice is that sync opt-in never propagates across
 * a rollover — a still-recurring task simply has to be re-synced by hand if
 * that's wanted. `next` also carries no ✅ (it isn't done) and keeps every
 * other field — priority, description, recurrence itself — unchanged.
 */
export function rollover(
	parsed: ParsedTask,
	doneDateISO: string,
): { completed: ParsedTask; next: ParsedTask } | null {
	if (parsed.recurrence === null) {
		return null;
	}
	const rec = parseRecurrence(parsed.recurrence);
	if (rec === null) {
		return null;
	}

	const completed: ParsedTask = {
		...parsed,
		checked: "x",
		done: doneDateISO,
	};

	const base: RecurrenceBase = {
		...(parsed.due !== null ? { due: parsed.due } : {}),
		...(parsed.scheduled !== null ? { scheduled: parsed.scheduled } : {}),
		...(parsed.reminder !== null ? { reminder: parsed.reminder.date } : {}),
	};
	const advanced = nextOccurrence(rec, base, doneDateISO);

	const next: ParsedTask = {
		...parsed,
		checked: " ",
		done: null,
		cancelled: null,
		blockId: null,
		due: advanced?.due ?? null,
		scheduled: advanced?.scheduled ?? null,
		reminder: advanced?.reminder !== undefined ? { date: advanced.reminder, time: parsed.reminder!.time } : null,
	};

	return { completed, next };
}
