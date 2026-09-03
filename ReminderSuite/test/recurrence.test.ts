import assert from "node:assert/strict";
import { test } from "node:test";
import { nextOccurrence, parseRecurrence, rollover, shouldRollover } from "../src/reminders/recurrence.ts";
import type { Recurrence } from "../src/reminders/recurrence.ts";
import type { ParsedTask } from "../src/tasks/parser.ts";

/** A minimal open task with no metadata; override fields per test. */
function blank(overrides: Partial<ParsedTask> = {}): ParsedTask {
	return {
		indent: "",
		listMarker: "-",
		checked: " ",
		description: "Water the plants",
		priority: "normal",
		recurrence: null,
		reminder: null,
		start: null,
		scheduled: null,
		due: null,
		created: null,
		done: null,
		cancelled: null,
		blockId: null,
		...overrides,
	};
}

// ---- parseRecurrence ----------------------------------------------------

test("parseRecurrence: every day", () => {
	assert.deepStrictEqual(parseRecurrence("every day"), { interval: 1, unit: "day", whenDone: false, weekday: null });
});

test("parseRecurrence: every week", () => {
	assert.deepStrictEqual(parseRecurrence("every week"), { interval: 1, unit: "week", whenDone: false, weekday: null });
});

test("parseRecurrence: every 2 weeks", () => {
	assert.deepStrictEqual(parseRecurrence("every 2 weeks"), {
		interval: 2,
		unit: "week",
		whenDone: false,
		weekday: null,
	});
});

test("parseRecurrence: every month", () => {
	assert.deepStrictEqual(parseRecurrence("every month"), {
		interval: 1,
		unit: "month",
		whenDone: false,
		weekday: null,
	});
});

test("parseRecurrence: every year", () => {
	assert.deepStrictEqual(parseRecurrence("every year"), {
		interval: 1,
		unit: "year",
		whenDone: false,
		weekday: null,
	});
});

test("parseRecurrence: trailing 'when done'", () => {
	assert.deepStrictEqual(parseRecurrence("every week when done"), {
		interval: 1,
		unit: "week",
		whenDone: true,
		weekday: null,
	});
});

test("parseRecurrence: weekday form", () => {
	assert.deepStrictEqual(parseRecurrence("every monday"), {
		interval: 1,
		unit: "week",
		whenDone: false,
		weekday: 1,
	});
});

test("parseRecurrence: weekday form with 'when done'", () => {
	assert.deepStrictEqual(parseRecurrence("every sunday when done"), {
		interval: 1,
		unit: "week",
		whenDone: true,
		weekday: 0,
	});
});

test("parseRecurrence: case-insensitive and tolerant of extra whitespace", () => {
	assert.deepStrictEqual(parseRecurrence("  Every   2   Months  When Done "), {
		interval: 2,
		unit: "month",
		whenDone: true,
		weekday: null,
	});
});

test("parseRecurrence: unsupported grammar returns null", () => {
	assert.strictEqual(parseRecurrence("every month on the 15th"), null);
	assert.strictEqual(parseRecurrence("every other week"), null);
	assert.strictEqual(parseRecurrence("monthly"), null);
	assert.strictEqual(parseRecurrence(""), null);
	assert.strictEqual(parseRecurrence("every fortnight"), null);
	assert.strictEqual(parseRecurrence("every 0 weeks"), null);
});

// ---- nextOccurrence -------------------------------------------------------

const DAY: Recurrence = { interval: 1, unit: "day", whenDone: false, weekday: null };
const WEEK: Recurrence = { interval: 1, unit: "week", whenDone: false, weekday: null };
const TWO_WEEKS: Recurrence = { interval: 2, unit: "week", whenDone: false, weekday: null };
const MONTH: Recurrence = { interval: 1, unit: "month", whenDone: false, weekday: null };
const YEAR: Recurrence = { interval: 1, unit: "year", whenDone: false, weekday: null };
const MONDAY: Recurrence = { interval: 1, unit: "week", whenDone: false, weekday: 1 };
const FRIDAY: Recurrence = { interval: 1, unit: "week", whenDone: false, weekday: 5 };
const MONTH_WHEN_DONE: Recurrence = { interval: 1, unit: "month", whenDone: true, weekday: null };

test("nextOccurrence: every day advances due by 1", () => {
	assert.deepStrictEqual(nextOccurrence(DAY, { due: "2026-08-20" }, "2026-08-15"), { due: "2026-08-21" });
});

test("nextOccurrence: every week advances due by 7", () => {
	assert.deepStrictEqual(nextOccurrence(WEEK, { due: "2026-08-20" }, "2026-08-15"), { due: "2026-08-27" });
});

test("nextOccurrence: every 2 weeks advances due by 14", () => {
	assert.deepStrictEqual(nextOccurrence(TWO_WEEKS, { due: "2026-08-20" }, "2026-08-15"), { due: "2026-09-03" });
});

test("nextOccurrence: every month clamps into a shorter month (Jan 31 -> Feb 28, non-leap)", () => {
	assert.deepStrictEqual(nextOccurrence(MONTH, { due: "2026-01-31" }, "2026-01-31"), { due: "2026-02-28" });
});

test("nextOccurrence: every month clamps into a leap February (Jan 31 -> Feb 29)", () => {
	assert.deepStrictEqual(nextOccurrence(MONTH, { due: "2024-01-31" }, "2024-01-31"), { due: "2024-02-29" });
});

test("nextOccurrence: every year clamps Feb 29 out of a non-leap year", () => {
	assert.deepStrictEqual(nextOccurrence(YEAR, { due: "2028-02-29" }, "2028-02-29"), { due: "2029-02-28" });
});

test("nextOccurrence: every year on a plain date", () => {
	assert.deepStrictEqual(nextOccurrence(YEAR, { due: "2026-08-20" }, "2026-08-20"), { due: "2027-08-20" });
});

test("nextOccurrence: weekday form when the base date already falls on that weekday advances a full week", () => {
	// 2026-08-17 is itself a Monday.
	assert.deepStrictEqual(nextOccurrence(MONDAY, { due: "2026-08-17" }, "2026-08-17"), { due: "2026-08-24" });
});

test("nextOccurrence: weekday form advances to the nearer matching weekday", () => {
	// 2026-08-18 is a Tuesday; the next Friday is 3 days later.
	assert.deepStrictEqual(nextOccurrence(FRIDAY, { due: "2026-08-18" }, "2026-08-18"), { due: "2026-08-21" });
});

test("nextOccurrence: 'when done' anchors on the completion date, not the base date", () => {
	const base = { due: "2026-01-31" };
	// Anchored on due (2026-01-31): +1 month clamps to 2026-02-28, a 28-day delta.
	assert.deepStrictEqual(nextOccurrence(MONTH, base, "2026-01-05"), { due: "2026-02-28" });
	// Anchored on doneDateISO (2026-01-05) instead: +1 month is 2026-02-05, a 31-day
	// delta (January has 31 days) — applied to the *original* due date, not doneDate.
	assert.deepStrictEqual(nextOccurrence(MONTH_WHEN_DONE, base, "2026-01-05"), { due: "2026-03-03" });
});

test("nextOccurrence: every date field present shifts by the same delta, preserving relative offsets", () => {
	assert.deepStrictEqual(nextOccurrence(WEEK, { due: "2026-08-20", scheduled: "2026-08-18" }, "2026-08-15"), {
		due: "2026-08-27",
		scheduled: "2026-08-25",
	});
});

test("nextOccurrence: reminder-only base (no due/scheduled) anchors on the reminder's own date", () => {
	assert.deepStrictEqual(nextOccurrence(WEEK, { reminder: "2026-08-20" }, "2026-08-15"), { reminder: "2026-08-27" });
});

test("nextOccurrence: null when base carries no dates at all", () => {
	assert.strictEqual(nextOccurrence(WEEK, {}, "2026-08-15"), null);
});

// ---- rollover ---------------------------------------------------------

test("rollover: null when the task has no recurrence", () => {
	assert.strictEqual(rollover(blank({ due: "2026-08-20" }), "2026-08-20"), null);
});

test("rollover: null when the recurrence string doesn't parse", () => {
	const task = blank({ due: "2026-08-20", recurrence: "every month on the 15th" });
	assert.strictEqual(rollover(task, "2026-08-20"), null);
});

test("rollover: completed line is checked, stamped done, and otherwise unchanged", () => {
	const task = blank({ due: "2026-08-20", recurrence: "every week", blockId: "abc123" });
	const result = rollover(task, "2026-08-20")!;
	assert.deepStrictEqual(result.completed, {
		...task,
		checked: "x",
		done: "2026-08-20",
	});
});

test("rollover: next occurrence is unchecked, has no done/cancelled/blockId, and has advanced dates", () => {
	const task = blank({ due: "2026-08-20", recurrence: "every week", blockId: "abc123", priority: "high" });
	const result = rollover(task, "2026-08-20")!;
	assert.deepStrictEqual(result.next, {
		...task,
		checked: " ",
		done: null,
		cancelled: null,
		blockId: null,
		due: "2026-08-27",
	});
});

test("rollover: a ⏰ reminder keeps its HH:mm while its date advances", () => {
	const task = blank({
		due: "2026-08-20",
		reminder: { date: "2026-08-20", time: "09:30" },
		recurrence: "every week",
	});
	const result = rollover(task, "2026-08-20")!;
	assert.deepStrictEqual(result.next.reminder, { date: "2026-08-27", time: "09:30" });
	assert.strictEqual(result.completed.reminder?.time, "09:30");
	assert.strictEqual(result.completed.reminder?.date, "2026-08-20");
});

test("rollover: 'when done' recurrence anchors the next occurrence on a late completion date", () => {
	const task = blank({ due: "2026-01-15", recurrence: "every month when done" });
	// Completed 10 days late: anchored on doneDate (2026-01-25), +1 month = 2026-02-25,
	// a 31-day delta (January has 31 days) applied to the original due date
	// (2026-01-15 + 31 days = 2026-02-15).
	const result = rollover(task, "2026-01-25")!;
	assert.strictEqual(result.next.due, "2026-02-15");
	assert.strictEqual(result.completed.done, "2026-01-25");
});

// ---- shouldRollover ----------------------------------------------------

test("shouldRollover: true for an open recurring task being checked", () => {
	const task = blank({ checked: " ", recurrence: "every week" });
	assert.strictEqual(shouldRollover(task, true), true);
});

test("shouldRollover: false when un-checking, regardless of recurrence", () => {
	const task = blank({ checked: " ", recurrence: "every week" });
	assert.strictEqual(shouldRollover(task, false), false);
});

test("shouldRollover: false when the task has no recurrence", () => {
	const task = blank({ checked: " ", recurrence: null });
	assert.strictEqual(shouldRollover(task, true), false);
});

test("shouldRollover: false when the task is already done", () => {
	const task = blank({ checked: "x", recurrence: "every week", done: "2026-08-10" });
	assert.strictEqual(shouldRollover(task, true), false);
});

test("shouldRollover: false when the task is cancelled ('-' is not recognized by isTaskDone)", () => {
	const task = blank({ checked: "-", recurrence: "every week", cancelled: "2026-08-10" });
	assert.strictEqual(shouldRollover(task, true), false);
});
