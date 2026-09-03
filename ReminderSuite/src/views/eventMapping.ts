/**
 * Maps Google Calendar events to the plain objects @event-calendar/core's
 * `events` option expects.
 *
 * Pure module: no `obsidian` import, so it is unit-testable directly. Reused
 * by later tasks (sync engine, event editing) — keep this mapping the single
 * source of truth for GCalEvent -> calendar-lib event shape.
 */

import type { GCalEvent } from "../gcal/types.ts";

/** The subset of @event-calendar/core's `EventInput` this plugin populates. */
export interface CalendarLibEvent {
	id: string;
	title: string;
	start: string;
	end: string;
	allDay: boolean;
	backgroundColor?: string;
	/** Omitted for GCal events, which are draggable; vault-task events set this false. */
	editable?: boolean;
	/**
	 * Set false (with `durationEditable`) to pin an event. `editable` alone is
	 * not enough: @event-calendar/core resolves draggability as
	 * `event.startEditable ?? options.eventStartEditable ?? event.editable ?? options.editable`,
	 * and `eventStartEditable` defaults to true — so it wins over a per-event
	 * `editable: false`.
	 */
	startEditable?: boolean;
	durationEditable?: boolean;
}

/**
 * Maps one Google Calendar event to a calendar-lib event object.
 *
 * - `id` is namespaced with `calendarId` so events from different calendars
 *   never collide.
 * - All-day events (`start.date` present) map to `allDay: true`; GCal's
 *   `end.date` is exclusive, and the lib expects the same, so it passes
 *   through unchanged.
 * - Timed events use `start.dateTime`/`end.dateTime` as-is (already ISO
 *   strings with an offset).
 * - Skipping cancelled events is the caller's responsibility — this function
 *   only maps, it does not filter.
 */
export function toCalendarEvent(calendarId: string, ev: GCalEvent, color?: string): CalendarLibEvent {
	const allDay = ev.start?.date !== undefined;
	const start = allDay ? (ev.start?.date ?? "") : (ev.start?.dateTime ?? "");
	const end = allDay ? (ev.end?.date ?? "") : (ev.end?.dateTime ?? "");
	const title = ev.summary !== undefined && ev.summary !== "" ? ev.summary : "(untitled)";

	return {
		id: `${calendarId}::${ev.id}`,
		title,
		start,
		end,
		allDay,
		...(color !== undefined ? { backgroundColor: color } : {}),
	};
}
