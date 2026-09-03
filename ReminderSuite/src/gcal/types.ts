/**
 * Hand-written minimal types for the Google Calendar REST v3 fields this
 * plugin actually reads or writes. Not generated from Google's discovery
 * document — extend as later tasks need more fields.
 *
 * Pure module: no `obsidian` import, so it can be unit-tested directly.
 */

/** Roles Google's calendarList endpoint returns for the signed-in account. */
export type GCalAccessRole = "none" | "freeBusyReader" | "reader" | "writer" | "owner";

export interface GCalCalendarListEntry {
	id: string;
	summary: string;
	backgroundColor?: string;
	primary?: boolean;
	accessRole: GCalAccessRole;
}

/** Exactly one of `date` (all-day) or `dateTime` is present, per the Calendar API. */
export interface GCalEventDateTime {
	date?: string;
	dateTime?: string;
	timeZone?: string;
}

export interface GCalEventReminderOverride {
	method: string;
	minutes: number;
}

export interface GCalEventReminders {
	useDefault: boolean;
	overrides?: GCalEventReminderOverride[];
}

export interface GCalEventExtendedProperties {
	private?: Record<string, string>;
}

export interface GCalEvent {
	id: string;
	status: "confirmed" | "tentative" | "cancelled";
	etag: string;
	summary?: string;
	description?: string;
	start?: GCalEventDateTime;
	end?: GCalEventDateTime;
	updated?: string;
	reminders?: GCalEventReminders;
	extendedProperties?: GCalEventExtendedProperties;
	/** Link to the event in the Google Calendar web UI. */
	htmlLink?: string;
	/** Present on an instance of a recurring series (as fetched with singleEvents=true). */
	recurringEventId?: string;
	/** RRULE/RDATE lines; present on a series parent. */
	recurrence?: string[];
}

/** The subset of `GCalEvent` fields this plugin sends on create/patch. */
export interface GCalEventInput {
	summary?: string;
	description?: string;
	start?: GCalEventDateTime;
	end?: GCalEventDateTime;
	reminders?: GCalEventReminders;
	extendedProperties?: GCalEventExtendedProperties;
}

/** One page of `events.list`. Only the final page of a sync carries `nextSyncToken`. */
export interface EventsListPage {
	items: GCalEvent[];
	nextPageToken?: string;
	nextSyncToken?: string;
}
