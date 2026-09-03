import assert from "node:assert/strict";
import { test } from "node:test";
import { isEventWorthy, taskToEventInput } from "../src/sync/taskEvent.ts";
import type { ParsedTask } from "../src/tasks/parser.ts";

const TZ = "America/Los_Angeles";

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

const DEFAULTS = { reminderMinutes: null, timeZone: TZ };

test("a task with only a due date maps to an all-day event with an exclusive end", () => {
	const input = taskToEventInput(task({ due: "2026-08-20" }), "rs-abc123", DEFAULTS, "retitle");
	assert.notStrictEqual(input, null);
	assert.deepStrictEqual(input!.start, { date: "2026-08-20" });
	// Google's all-day end is exclusive: a one-day event ends the next day.
	assert.deepStrictEqual(input!.end, { date: "2026-08-21" });
});

test("an all-day event's exclusive end rolls over a year boundary", () => {
	const input = taskToEventInput(task({ due: "2026-12-31" }), "rs-abc123", DEFAULTS, "retitle");
	assert.deepStrictEqual(input!.end, { date: "2027-01-01" });
});

test("a task with a reminder maps to a timed event one hour long in the given time zone", () => {
	const input = taskToEventInput(
		task({ due: "2026-08-20", reminder: { date: "2026-08-20", time: "14:00" } }),
		"rs-abc123",
		DEFAULTS,
		"retitle",
	);
	assert.deepStrictEqual(input!.start, { dateTime: "2026-08-20T14:00:00", timeZone: TZ });
	assert.deepStrictEqual(input!.end, { dateTime: "2026-08-20T15:00:00", timeZone: TZ });
});

test("a reminder wins over the due date when both are present", () => {
	const input = taskToEventInput(
		task({ due: "2026-08-20", reminder: { date: "2026-09-01", time: "09:30" } }),
		"rs-abc123",
		DEFAULTS,
		"retitle",
	);
	assert.deepStrictEqual(input!.start, { dateTime: "2026-09-01T09:30:00", timeZone: TZ });
	assert.deepStrictEqual(input!.end, { dateTime: "2026-09-01T10:30:00", timeZone: TZ });
});

test("a late-night reminder's one-hour end rolls into the next day", () => {
	const input = taskToEventInput(
		task({ reminder: { date: "2026-08-20", time: "23:30" } }),
		"rs-abc123",
		DEFAULTS,
		"retitle",
	);
	assert.deepStrictEqual(input!.end, { dateTime: "2026-08-21T00:30:00", timeZone: TZ });
});

test("a task with neither a due date nor a reminder maps to null", () => {
	assert.strictEqual(taskToEventInput(task(), "rs-abc123", DEFAULTS, "retitle"), null);
});

test("a scheduled-only task maps to null (only due and reminder are event-worthy)", () => {
	assert.strictEqual(
		taskToEventInput(task({ scheduled: "2026-08-20" }), "rs-abc123", DEFAULTS, "retitle"),
		null,
	);
});

test("the summary is the task description", () => {
	const input = taskToEventInput(task({ due: "2026-08-20" }), "rs-abc123", DEFAULTS, "retitle");
	assert.strictEqual(input!.summary, "Write the report");
});

test("the summary strips trailing whitespace from the description", () => {
	const input = taskToEventInput(
		task({ due: "2026-08-20", description: "Write the report   " }),
		"rs-abc123",
		DEFAULTS,
		"retitle",
	);
	assert.strictEqual(input!.summary, "Write the report");
});

test("a completed task gets a check prefix under the retitle strategy", () => {
	const input = taskToEventInput(
		task({ due: "2026-08-20", checked: "x", done: "2026-08-21" }),
		"rs-abc123",
		DEFAULTS,
		"retitle",
	);
	assert.strictEqual(input!.summary, "✓ Write the report");
});

test("an uppercase X counts as completed for the retitle prefix", () => {
	const input = taskToEventInput(
		task({ due: "2026-08-20", checked: "X" }),
		"rs-abc123",
		DEFAULTS,
		"retitle",
	);
	assert.strictEqual(input!.summary, "✓ Write the report");
});

test("a completed task is not retitled under the delete strategy", () => {
	const input = taskToEventInput(
		task({ due: "2026-08-20", checked: "x" }),
		"rs-abc123",
		DEFAULTS,
		"delete",
	);
	assert.strictEqual(input!.summary, "Write the report");
});

test("an open task is never given the completed prefix", () => {
	const input = taskToEventInput(task({ due: "2026-08-20" }), "rs-abc123", DEFAULTS, "retitle");
	assert.strictEqual(input!.summary, "Write the report");
});

test("a reminder-minutes default becomes a popup override", () => {
	const input = taskToEventInput(
		task({ due: "2026-08-20" }),
		"rs-abc123",
		{ reminderMinutes: 10, timeZone: TZ },
		"retitle",
	);
	assert.deepStrictEqual(input!.reminders, {
		useDefault: false,
		overrides: [{ method: "popup", minutes: 10 }],
	});
});

test("a zero-minute reminder default is an override, not a fall-through to Google's default", () => {
	const input = taskToEventInput(
		task({ due: "2026-08-20" }),
		"rs-abc123",
		{ reminderMinutes: 0, timeZone: TZ },
		"retitle",
	);
	assert.deepStrictEqual(input!.reminders, {
		useDefault: false,
		overrides: [{ method: "popup", minutes: 0 }],
	});
});

test("a null reminder-minutes default defers to the calendar's own defaults", () => {
	const input = taskToEventInput(task({ due: "2026-08-20" }), "rs-abc123", DEFAULTS, "retitle");
	assert.deepStrictEqual(input!.reminders, { useDefault: true });
});

test("the block id is stamped into private extended properties for round-tripping", () => {
	const input = taskToEventInput(task({ due: "2026-08-20" }), "rs-abc123", DEFAULTS, "retitle");
	assert.deepStrictEqual(input!.extendedProperties, {
		private: { reminderSuite: "1", blockId: "rs-abc123" },
	});
});

test("isEventWorthy agrees with taskToEventInput on every combination of dates", () => {
	const cases: ParsedTask[] = [
		task(),
		task({ due: "2026-08-20" }),
		task({ reminder: { date: "2026-08-20", time: "09:00" } }),
		task({ due: "2026-08-20", reminder: { date: "2026-08-20", time: "09:00" } }),
		task({ scheduled: "2026-08-20" }),
		task({ start: "2026-08-20", created: "2026-08-01" }),
	];
	for (const candidate of cases) {
		assert.strictEqual(
			isEventWorthy(candidate),
			taskToEventInput(candidate, "rs-abc123", DEFAULTS, "retitle") !== null,
			`disagreement for ${JSON.stringify(candidate)}`,
		);
	}
});
