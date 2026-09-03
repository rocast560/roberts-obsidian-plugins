import assert from "node:assert/strict";
import { test } from "node:test";
import { toCalendarEvent } from "../src/views/eventMapping.ts";
import type { GCalEvent } from "../src/gcal/types.ts";

function timedEvent(overrides: Partial<GCalEvent> = {}): GCalEvent {
	return {
		id: "evt1",
		status: "confirmed",
		etag: "\"abc\"",
		summary: "Standup",
		start: { dateTime: "2026-08-20T10:00:00-07:00" },
		end: { dateTime: "2026-08-20T10:30:00-07:00" },
		...overrides,
	};
}

test("toCalendarEvent maps a timed event's dateTime start/end and marks it not all-day", () => {
	const mapped = toCalendarEvent("cal1", timedEvent());
	assert.strictEqual(mapped.start, "2026-08-20T10:00:00-07:00");
	assert.strictEqual(mapped.end, "2026-08-20T10:30:00-07:00");
	assert.strictEqual(mapped.allDay, false);
});

test("toCalendarEvent maps an all-day event's date start/end and marks it all-day", () => {
	const event: GCalEvent = {
		id: "evt2",
		status: "confirmed",
		etag: "\"def\"",
		summary: "Conference",
		start: { date: "2026-08-20" },
		end: { date: "2026-08-22" },
	};
	const mapped = toCalendarEvent("cal1", event);
	assert.strictEqual(mapped.allDay, true);
	assert.strictEqual(mapped.start, "2026-08-20");
	// GCal's all-day end date is exclusive; it passes through unchanged.
	assert.strictEqual(mapped.end, "2026-08-22");
});

test("toCalendarEvent namespaces the id with the calendar id", () => {
	const mapped = toCalendarEvent("work@example.com", timedEvent({ id: "abc123" }));
	assert.strictEqual(mapped.id, "work@example.com::abc123");
});

test("toCalendarEvent uses the event summary as the title", () => {
	const mapped = toCalendarEvent("cal1", timedEvent({ summary: "Standup" }));
	assert.strictEqual(mapped.title, "Standup");
});

test("toCalendarEvent falls back to (untitled) when summary is missing", () => {
	const mapped = toCalendarEvent("cal1", timedEvent({ summary: undefined }));
	assert.strictEqual(mapped.title, "(untitled)");
});

test("toCalendarEvent falls back to (untitled) when summary is an empty string", () => {
	const mapped = toCalendarEvent("cal1", timedEvent({ summary: "" }));
	assert.strictEqual(mapped.title, "(untitled)");
});

test("toCalendarEvent applies the given calendar color as backgroundColor", () => {
	const mapped = toCalendarEvent("cal1", timedEvent(), "#ff0000");
	assert.strictEqual(mapped.backgroundColor, "#ff0000");
});

test("toCalendarEvent omits backgroundColor when no color is given", () => {
	const mapped = toCalendarEvent("cal1", timedEvent());
	assert.strictEqual(mapped.backgroundColor, undefined);
});
