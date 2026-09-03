import assert from "node:assert/strict";
import { test } from "node:test";
import { isTaskCancelled, isTaskDone, parseTaskLine, priorityEmoji, serializeTask } from "../src/tasks/parser.ts";
import type { ParsedTask } from "../src/tasks/parser.ts";

/** A minimal open task with no metadata; override fields per test. */
function blank(overrides: Partial<ParsedTask> = {}): ParsedTask {
	return {
		indent: "",
		listMarker: "-",
		checked: " ",
		description: "Buy milk",
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

/** parse(serialize(t)) must deep-equal t for every case — the round-trip contract. */
function assertRoundTrip(t: ParsedTask): void {
	const line = serializeTask(t);
	assert.deepStrictEqual(parseTaskLine(line), t);
}

test("parses a plain task with no metadata", () => {
	const parsed = parseTaskLine("- [ ] Buy milk");
	assert.deepStrictEqual(parsed, blank());
	assertRoundTrip(blank());
});

test("due date (📅) alone", () => {
	const expected = blank({ due: "2026-08-20" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk 📅 2026-08-20"), expected);
	assertRoundTrip(expected);
});

test("scheduled date (⏳) alone", () => {
	const expected = blank({ scheduled: "2026-08-19" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk ⏳ 2026-08-19"), expected);
	assertRoundTrip(expected);
});

test("start date (🛫) alone", () => {
	const expected = blank({ start: "2026-08-18" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk 🛫 2026-08-18"), expected);
	assertRoundTrip(expected);
});

test("created date (➕) alone", () => {
	const expected = blank({ created: "2026-08-01" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk ➕ 2026-08-01"), expected);
	assertRoundTrip(expected);
});

test("done date (✅) alone", () => {
	const expected = blank({ checked: "x", done: "2026-08-15" });
	assert.deepStrictEqual(parseTaskLine("- [x] Buy milk ✅ 2026-08-15"), expected);
	assertRoundTrip(expected);
});

test("cancelled date (❌) alone", () => {
	const expected = blank({ checked: "-", cancelled: "2026-08-15" });
	assert.deepStrictEqual(parseTaskLine("- [-] Buy milk ❌ 2026-08-15"), expected);
	assertRoundTrip(expected);
});

test("reminder (⏰) date-time alone", () => {
	const expected = blank({ reminder: { date: "2026-08-20", time: "09:30" } });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk ⏰ 2026-08-20 09:30"), expected);
	assertRoundTrip(expected);
});

test("priority highest (🔺)", () => {
	const expected = blank({ priority: "highest" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk 🔺"), expected);
	assertRoundTrip(expected);
});

test("priority high (⏫)", () => {
	const expected = blank({ priority: "high" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk ⏫"), expected);
	assertRoundTrip(expected);
});

test("priority medium (🔼)", () => {
	const expected = blank({ priority: "medium" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk 🔼"), expected);
	assertRoundTrip(expected);
});

test("priority low (🔽)", () => {
	const expected = blank({ priority: "low" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk 🔽"), expected);
	assertRoundTrip(expected);
});

test("priority lowest (⏬)", () => {
	const expected = blank({ priority: "lowest" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk ⏬"), expected);
	assertRoundTrip(expected);
});

test("absent priority parses as normal and serializes with no emoji", () => {
	const expected = blank();
	assert.strictEqual(expected.priority, "normal");
	assert.strictEqual(serializeTask(expected), "- [ ] Buy milk");
});

test("simple recurrence (🔁 every day)", () => {
	const expected = blank({ recurrence: "every day" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk 🔁 every day"), expected);
	assertRoundTrip(expected);
});

test("multi-word recurrence with trailing modifier (🔁 every month when done)", () => {
	const expected = blank({ recurrence: "every month when done" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk 🔁 every month when done"), expected);
	assertRoundTrip(expected);
});

test("block ID capture at end of line", () => {
	const expected = blank({ blockId: "abc123" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk ^abc123"), expected);
	assertRoundTrip(expected);
});

test("all metadata fields combined in canonical order", () => {
	const full = blank({
		description: "Buy milk #errand",
		priority: "high",
		recurrence: "every week",
		reminder: { date: "2026-08-20", time: "09:30" },
		start: "2026-08-18",
		scheduled: "2026-08-19",
		due: "2026-08-20",
		created: "2026-08-01",
		blockId: "abc123",
	});
	const canonical =
		"- [ ] Buy milk #errand ⏫ 🔁 every week ⏰ 2026-08-20 09:30 🛫 2026-08-18 ⏳ 2026-08-19 📅 2026-08-20 ➕ 2026-08-01 ^abc123";
	assert.strictEqual(serializeTask(full), canonical);
	assert.deepStrictEqual(parseTaskLine(canonical), full);
	assertRoundTrip(full);
});

test("all metadata fields combined in shuffled order parses to the same object (block ID stays anchored at the end)", () => {
	const full = blank({
		description: "Buy milk #errand",
		priority: "high",
		recurrence: "every week",
		reminder: { date: "2026-08-20", time: "09:30" },
		start: "2026-08-18",
		scheduled: "2026-08-19",
		due: "2026-08-20",
		created: "2026-08-01",
		blockId: "abc123",
	});
	const shuffled =
		"- [ ] Buy milk #errand 📅 2026-08-20 ⏰ 2026-08-20 09:30 🔁 every week ➕ 2026-08-01 ⏫ 🛫 2026-08-18 ⏳ 2026-08-19 ^abc123";
	assert.deepStrictEqual(parseTaskLine(shuffled), full);
	// Re-serializing always produces the same canonical order regardless of source order.
	assert.strictEqual(serializeTask(parseTaskLine(shuffled)!), serializeTask(full));
});

test("all-day due date (no ⏰) vs a due date with a reminder time are distinct", () => {
	const allDay = blank({ due: "2026-08-20" });
	const timed = blank({ due: "2026-08-20", reminder: { date: "2026-08-20", time: "14:00" } });
	assert.notDeepStrictEqual(allDay, timed);
	assert.strictEqual(parseTaskLine("- [ ] Buy milk 📅 2026-08-20")!.reminder, null);
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk ⏰ 2026-08-20 14:00 📅 2026-08-20")!.reminder, {
		date: "2026-08-20",
		time: "14:00",
	});
	assertRoundTrip(allDay);
	assertRoundTrip(timed);
});

test("unchecked task ([ ]) is open", () => {
	const expected = blank({ checked: " " });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk"), expected);
	assertRoundTrip(expected);
});

test("checked task ([x]) is done", () => {
	const expected = blank({ checked: "x" });
	assert.deepStrictEqual(parseTaskLine("- [x] Buy milk"), expected);
	assert.strictEqual(isTaskDone(expected), true);
	assertRoundTrip(expected);
});

test("checked task ([X], uppercase) is also done", () => {
	const expected = blank({ checked: "X" });
	assert.deepStrictEqual(parseTaskLine("- [X] Buy milk"), expected);
	assert.strictEqual(isTaskDone(expected), true);
	assertRoundTrip(expected);
});

test("custom status ([/]) is preserved raw and is neither done nor cancelled", () => {
	const expected = blank({ checked: "/" });
	assert.deepStrictEqual(parseTaskLine("- [/] Buy milk"), expected);
	assert.strictEqual(isTaskDone(expected), false);
	assert.strictEqual(isTaskCancelled(expected), false);
	assertRoundTrip(expected);
});

test("cancelled status ([-]) is recognized by isTaskCancelled", () => {
	const expected = blank({ checked: "-" });
	assert.strictEqual(isTaskCancelled(expected), true);
	assert.strictEqual(isTaskDone(expected), false);
	assertRoundTrip(expected);
});

test("a markdown heading is not a task", () => {
	assert.strictEqual(parseTaskLine("# Heading"), null);
});

test("a plain bullet without a checkbox is not a task", () => {
	assert.strictEqual(parseTaskLine("- just a plain bullet"), null);
});

test("indented code (no checkbox) is not a task", () => {
	assert.strictEqual(parseTaskLine("    const x = 1;"), null);
});

test("list marker '*' is preserved", () => {
	const expected = blank({ listMarker: "*" });
	assert.deepStrictEqual(parseTaskLine("* [ ] Buy milk"), expected);
	assertRoundTrip(expected);
});

test("list marker '+' is preserved", () => {
	const expected = blank({ listMarker: "+" });
	assert.deepStrictEqual(parseTaskLine("+ [ ] Buy milk"), expected);
	assertRoundTrip(expected);
});

test("leading indent is preserved for a nested list item", () => {
	const expected = blank({ indent: "  " });
	assert.deepStrictEqual(parseTaskLine("  - [ ] Buy milk"), expected);
	assertRoundTrip(expected);
});

test("unknown emoji and trailing junk are preserved in the description, never dropped", () => {
	const expected = blank({ description: "Buy milk 🚀 with extra unrecognized junk !!" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk 🚀 with extra unrecognized junk !!"), expected);
	assertRoundTrip(expected);
});

test("tags in the description stay in the description", () => {
	const expected = blank({ description: "Buy milk #errand #home" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk #errand #home"), expected);
	assertRoundTrip(expected);
});

test("CRLF line endings are tolerated (trailing \\r stripped)", () => {
	const expected = blank({ due: "2026-08-20" });
	assert.deepStrictEqual(parseTaskLine("- [ ] Buy milk 📅 2026-08-20\r"), expected);
});

test("priorityEmoji returns the canonical emoji for each priority and '' for normal", () => {
	assert.strictEqual(priorityEmoji("highest"), "🔺");
	assert.strictEqual(priorityEmoji("high"), "⏫");
	assert.strictEqual(priorityEmoji("medium"), "🔼");
	assert.strictEqual(priorityEmoji("low"), "🔽");
	assert.strictEqual(priorityEmoji("lowest"), "⏬");
	assert.strictEqual(priorityEmoji("normal"), "");
});
