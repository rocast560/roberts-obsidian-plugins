import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEventToTask, taskToEventInput } from "../src/sync/taskEvent.ts";
import type { GCalEvent } from "../src/gcal/types.ts";
import type { ParsedTask } from "../src/tasks/parser.ts";

const TZ = "America/Los_Angeles";
const TODAY = "2026-08-15";
const RETITLE = { strategy: "retitle" as const, todayISO: TODAY, fallbackTimeZone: TZ };
const DELETE = { strategy: "delete" as const, todayISO: TODAY, fallbackTimeZone: TZ };
/** The same options with a different zone standing in for the user's machine. */
function inZone(fallbackTimeZone: string) {
	return { ...RETITLE, fallbackTimeZone };
}

function task(overrides: Partial<ParsedTask> = {}): ParsedTask {
	return {
		indent: "",
		listMarker: "-",
		checked: " ",
		description: "Write the report",
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

function event(overrides: Partial<GCalEvent> = {}): GCalEvent {
	return {
		id: "evt1",
		status: "confirmed",
		etag: "\"etag-1\"",
		summary: "Write the report",
		updated: "2026-08-15T10:00:00.000Z",
		...overrides,
	};
}

// ---- Dates -------------------------------------------------------------

test("a timed event becomes a ⏰ reminder plus a 📅 due date on the same day", () => {
	const next = applyEventToTask(
		task({ due: "2026-08-01" }),
		event({ start: { dateTime: "2026-08-20T14:00:00-07:00", timeZone: TZ } }),
		RETITLE,
	);
	assert.deepStrictEqual(next.reminder, { date: "2026-08-20", time: "14:00" });
	assert.strictEqual(next.due, "2026-08-20");
});

test("an all-day event sets the due date and drops the reminder", () => {
	const next = applyEventToTask(
		task({ due: "2026-08-01", reminder: { date: "2026-08-01", time: "09:00" } }),
		event({ start: { date: "2026-08-20" } }),
		RETITLE,
	);
	assert.strictEqual(next.due, "2026-08-20");
	assert.strictEqual(next.reminder, null);
});

test("an offset matching the event's own zone yields that same wall-clock time", () => {
	const next = applyEventToTask(
		task(),
		event({ start: { dateTime: "2026-08-20T23:30:00+02:00", timeZone: "Europe/Berlin" } }),
		RETITLE,
	);
	assert.deepStrictEqual(next.reminder, { date: "2026-08-20", time: "23:30" });
});

test("a dateTime with no zone designator is already a wall clock and is taken as written", () => {
	// What this plugin itself writes: a bare wall clock plus an explicit timeZone.
	const next = applyEventToTask(
		task(),
		event({ start: { dateTime: "2026-08-20T14:00:00", timeZone: "Europe/Berlin" } }),
		RETITLE,
	);
	assert.deepStrictEqual(next.reminder, { date: "2026-08-20", time: "14:00" });
});

test("a UTC dateTime is converted into the event's own zone in winter", () => {
	// 14:00 UTC is 09:00 in New York while it's on EST.
	const next = applyEventToTask(
		task(),
		event({ start: { dateTime: "2026-01-15T14:00:00Z", timeZone: "America/New_York" } }),
		RETITLE,
	);
	assert.deepStrictEqual(next.reminder, { date: "2026-01-15", time: "09:00" });
});

test("a UTC dateTime is converted into the event's own zone in summer", () => {
	// The same 14:00 UTC is 10:00 once New York is on EDT — the offset is not fixed.
	const next = applyEventToTask(
		task(),
		event({ start: { dateTime: "2026-07-15T14:00:00Z", timeZone: "America/New_York" } }),
		RETITLE,
	);
	assert.deepStrictEqual(next.reminder, { date: "2026-07-15", time: "10:00" });
});

test("an offset from a different zone is converted into the event's own zone", () => {
	// 14:00−07:00 is 21:00 UTC, which is 17:00 in New York on EDT.
	const next = applyEventToTask(
		task(),
		event({ start: { dateTime: "2026-08-20T14:00:00-07:00", timeZone: "America/New_York" } }),
		RETITLE,
	);
	assert.deepStrictEqual(next.reminder, { date: "2026-08-20", time: "17:00" });
});

test("converting across zones moves the date as well as the time", () => {
	// 02:00 UTC on the 16th is still the evening of the 15th in New York, and the
	// 📅 has to follow the ⏰ onto that day.
	const next = applyEventToTask(
		task(),
		event({ start: { dateTime: "2026-01-16T02:00:00Z", timeZone: "America/New_York" } }),
		RETITLE,
	);
	assert.deepStrictEqual(next.reminder, { date: "2026-01-15", time: "21:00" });
	assert.strictEqual(next.due, "2026-01-15");
});

test("midnight is 00:00, never 24:00", () => {
	// Some ICU builds render midnight as hour 24 under hour12:false, which would
	// put an unparseable "24:00" into the user's note.
	const next = applyEventToTask(
		task(),
		event({ start: { dateTime: "2026-01-15T05:00:00Z", timeZone: "America/New_York" } }),
		RETITLE,
	);
	assert.deepStrictEqual(next.reminder, { date: "2026-01-15", time: "00:00" });
});

test("an event that declares no zone is read in the user's own zone", () => {
	// Google often returns only an offset. The instant is unambiguous, and a
	// task's ⏰ is a time the user will act on, so it belongs in their zone.
	const next = applyEventToTask(
		task(),
		event({ start: { dateTime: "2026-01-15T14:00:00Z" } }),
		inZone("Europe/Berlin"),
	);
	assert.deepStrictEqual(next.reminder, { date: "2026-01-15", time: "15:00" });
});

test("a zone Intl doesn't know falls back to the wall clock as written", () => {
	const next = applyEventToTask(
		task(),
		event({ start: { dateTime: "2026-01-15T14:00:00Z", timeZone: "Mars/Olympus_Mons" } }),
		RETITLE,
	);
	assert.deepStrictEqual(next.reminder, { date: "2026-01-15", time: "14:00" });
});

test("an event with no start leaves the task's dates alone", () => {
	const source = task({ due: "2026-08-01", reminder: { date: "2026-08-01", time: "09:00" } });
	const next = applyEventToTask(source, event(), RETITLE);
	assert.strictEqual(next.due, "2026-08-01");
	assert.deepStrictEqual(next.reminder, { date: "2026-08-01", time: "09:00" });
});

// ---- Summary and completion --------------------------------------------

test("a ✓-prefixed summary completes the task under the retitle strategy", () => {
	const next = applyEventToTask(task(), event({ summary: "✓ Write the report" }), RETITLE);
	assert.strictEqual(next.checked, "x");
	assert.strictEqual(next.done, TODAY);
	assert.strictEqual(next.description, "Write the report");
});

test("the ✓ prefix is stripped from the description under the delete strategy too, but nothing is completed", () => {
	const next = applyEventToTask(task(), event({ summary: "✓ Write the report" }), DELETE);
	assert.strictEqual(next.description, "Write the report");
	assert.strictEqual(next.checked, " ");
	assert.strictEqual(next.done, null);
});

test("a task already completed keeps its original done date", () => {
	const next = applyEventToTask(
		task({ checked: "x", done: "2026-08-01" }),
		event({ summary: "✓ Write the report" }),
		RETITLE,
	);
	assert.strictEqual(next.done, "2026-08-01");
});

test("dropping the ✓ from a summary never un-completes a task", () => {
	// Completion travels vault → Google only. A retitle in Google is not a claim
	// about whether the work got done.
	const next = applyEventToTask(
		task({ checked: "x", done: "2026-08-10" }),
		event({ summary: "Write the report" }),
		RETITLE,
	);
	assert.strictEqual(next.checked, "x");
	assert.strictEqual(next.done, "2026-08-10");
});

test("a renamed event renames the task", () => {
	const next = applyEventToTask(task(), event({ summary: "Write the quarterly report" }), RETITLE);
	assert.strictEqual(next.description, "Write the quarterly report");
});

test("an event with no summary leaves the description alone", () => {
	const next = applyEventToTask(task(), event({ summary: undefined }), RETITLE);
	assert.strictEqual(next.description, "Write the report");
});

test("an event with a blank summary leaves the description alone", () => {
	// An untitled event would otherwise erase the task's text entirely.
	const next = applyEventToTask(task(), event({ summary: "   " }), RETITLE);
	assert.strictEqual(next.description, "Write the report");
});

// ---- What a remote edit must never touch -------------------------------

test("priority, recurrence, block id, indent and the other dates survive a remote edit", () => {
	const source = task({
		indent: "\t",
		listMarker: "*",
		priority: "high",
		recurrence: "every week",
		blockId: "rs-abc123",
		start: "2026-08-01",
		scheduled: "2026-08-02",
		created: "2026-07-01",
		cancelled: null,
	});
	const next = applyEventToTask(source, event({ summary: "New title", start: { date: "2026-08-20" } }), RETITLE);
	assert.strictEqual(next.indent, "\t");
	assert.strictEqual(next.listMarker, "*");
	assert.strictEqual(next.priority, "high");
	assert.strictEqual(next.recurrence, "every week");
	assert.strictEqual(next.blockId, "rs-abc123");
	assert.strictEqual(next.start, "2026-08-01");
	assert.strictEqual(next.scheduled, "2026-08-02");
	assert.strictEqual(next.created, "2026-07-01");
});

test("tags the renamed event dropped are kept on the task", () => {
	// Tags live inside a task's description, so a rename in Google would
	// otherwise silently delete them — and a vault filtered by #task would lose
	// the task from its index entirely.
	const next = applyEventToTask(
		task({ description: "Write the report #work #q3" }),
		event({ summary: "Write the quarterly report" }),
		RETITLE,
	);
	assert.strictEqual(next.description, "Write the quarterly report #work #q3");
});

test("a tag the event still carries is not duplicated", () => {
	const next = applyEventToTask(
		task({ description: "Write the report #work" }),
		event({ summary: "Write the quarterly report #work" }),
		RETITLE,
	);
	assert.strictEqual(next.description, "Write the quarterly report #work");
});

test("the source task is not mutated", () => {
	const source = task({ due: "2026-08-01" });
	applyEventToTask(source, event({ summary: "New title", start: { date: "2026-08-20" } }), RETITLE);
	assert.strictEqual(source.description, "Write the report");
	assert.strictEqual(source.due, "2026-08-01");
});

// ---- Round trip --------------------------------------------------------

const DEFAULTS = { reminderMinutes: null, timeZone: TZ };

/** The event Google would hold for `source`, as this plugin would have pushed it. */
function pushed(source: ParsedTask): GCalEvent {
	const input = taskToEventInput(source, "rs-abc123", DEFAULTS, "retitle");
	assert.notStrictEqual(input, null);
	return event({ summary: input!.summary, start: input!.start, end: input!.end });
}

test("an all-day task survives a task → event → task round trip unchanged", () => {
	const source = task({ due: "2026-08-20", priority: "high", blockId: "rs-abc123" });
	assert.deepStrictEqual(applyEventToTask(source, pushed(source), RETITLE), source);
});

test("a timed task survives a task → event → task round trip unchanged", () => {
	const source = task({
		due: "2026-08-20",
		reminder: { date: "2026-08-20", time: "14:00" },
		recurrence: "every week",
		blockId: "rs-abc123",
	});
	assert.deepStrictEqual(applyEventToTask(source, pushed(source), RETITLE), source);
});

test("a completed task survives a round trip without a doubled ✓ or a moved done date", () => {
	const source = task({ due: "2026-08-20", checked: "x", done: "2026-08-19", blockId: "rs-abc123" });
	assert.deepStrictEqual(applyEventToTask(source, pushed(source), RETITLE), source);
});

test("a timed event pulls the due date onto the event's own day", () => {
	// Documented lossiness: one event carries one date, so a task whose 📅 and ⏰
	// disagreed converges on the ⏰ once Google is the source.
	const source = task({ due: "2026-09-01", reminder: { date: "2026-08-20", time: "14:00" } });
	const next = applyEventToTask(source, pushed(source), RETITLE);
	assert.strictEqual(next.due, "2026-08-20");
});
