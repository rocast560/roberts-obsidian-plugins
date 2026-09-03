import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import type { TokenStore } from "../auth/tokenStore.ts";
import { GCalApiError, RateLimitError, backoffDelayMs, classifyError } from "./errors.ts";
import { buildEventsQuery } from "./query.ts";
import type { EventsListQuery } from "./query.ts";
import type {
	EventsListPage,
	GCalCalendarListEntry,
	GCalEvent,
	GCalEventInput,
} from "./types.ts";

const BASE_URL = "https://www.googleapis.com/calendar/v3";
/** Total attempts (1 initial + up to 3 retries) for a rate-limited request. */
const MAX_ATTEMPTS = 4;

interface RequestOptions {
	query?: Record<string, string | undefined>;
	body?: unknown;
	etag?: string;
}

interface ListCalendarsResponse {
	items?: GCalCalendarListEntry[];
	nextPageToken?: string;
}

interface ListEventsResponse {
	items?: GCalEvent[];
	nextPageToken?: string;
	nextSyncToken?: string;
}

function buildUrl(path: string, query?: Record<string, string | undefined>): string {
	const url = new URL(`${BASE_URL}${path}`);
	if (query !== undefined) {
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined) {
				url.searchParams.set(key, value);
			}
		}
	}
	return url.toString();
}

function buildHeaders(accessToken: string, opts: RequestOptions): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
	};
	if (opts.body !== undefined) {
		headers["Content-Type"] = "application/json";
	}
	if (opts.etag !== undefined) {
		headers["If-Match"] = opts.etag;
	}
	return headers;
}

/** Parses a response body as JSON, tolerating an empty body (e.g. a 204 delete). */
function parseJsonBody(response: RequestUrlResponse): unknown {
	if (response.text === "") {
		return undefined;
	}
	try {
		return response.json;
	} catch {
		return undefined;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Typed, dependency-free client for the Google Calendar REST v3 API, built on
 * Obsidian's `requestUrl`. Every method funnels through the private
 * `request()`, which owns auth injection, 401-refresh-and-retry, and
 * rate-limit backoff — callers never see those concerns.
 */
export class GCalClient {
	private tokenStore: TokenStore;

	constructor(tokenStore: TokenStore) {
		this.tokenStore = tokenStore;
	}

	/**
	 * Issues one Calendar API call and returns its parsed JSON body (or
	 * `undefined` for an empty body, e.g. a successful delete).
	 *
	 * - Injects `Authorization: Bearer <token>` from the token store, and
	 *   `If-Match: <etag>` when `opts.etag` is given.
	 * - On a 401, forces exactly one token refresh and retries once; a second
	 *   401 propagates as a plain `GCalApiError`.
	 * - On a rate-limit error (429, or 403 with a rate-limit reason), retries
	 *   with exponential backoff + jitter, up to `MAX_ATTEMPTS` total tries.
	 *   410/412 are never retried — callers branch on those.
	 */
	private async request<T>(
		method: string,
		path: string,
		opts: RequestOptions = {},
		forceTokenRefresh = false,
	): Promise<T> {
		const accessToken = await this.tokenStore.getAccessToken(forceTokenRefresh);
		const headers = buildHeaders(accessToken, opts);
		const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
		const url = buildUrl(path, opts.query);

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const response = await requestUrl({
				url,
				method,
				headers,
				body,
				throw: false,
			});

			if (response.status >= 200 && response.status < 300) {
				return parseJsonBody(response) as T;
			}

			if (response.status === 401 && !forceTokenRefresh) {
				return this.request<T>(method, path, opts, true);
			}

			const error = classifyError(response.status, parseJsonBody(response));

			if (error instanceof RateLimitError && attempt < MAX_ATTEMPTS) {
				const delayMs = backoffDelayMs(attempt);
				console.warn(
					`ReminderSuite: Google Calendar API rate limited, retrying in ${delayMs}ms (attempt ${attempt} of ${MAX_ATTEMPTS})`,
				);
				await sleep(delayMs);
				continue;
			}

			throw error;
		}

		// Unreachable: the loop above always returns or throws.
		throw new GCalApiError("Google Calendar API request exhausted retries", 0);
	}

	/** GET /users/me/calendarList, paginated. Includes reader calendars — callers filter by accessRole. */
	async listCalendars(): Promise<GCalCalendarListEntry[]> {
		const results: GCalCalendarListEntry[] = [];
		let pageToken: string | undefined;

		do {
			const page = await this.request<ListCalendarsResponse>(
				"GET",
				"/users/me/calendarList",
				{ query: { pageToken } },
			);
			results.push(...(page.items ?? []));
			pageToken = page.nextPageToken;
		} while (pageToken !== undefined);

		return results;
	}

	/**
	 * GET /calendars/{id}/events for one page. `buildEventsQuery` owns which
	 * parameters go out — notably that a sync token travels without a time
	 * window, and that `orderBy` is never sent because it would suppress the
	 * `nextSyncToken` incremental sync depends on.
	 *
	 * A 410 (expired sync token) is not caught here; callers handle it.
	 */
	async listEventsPage(calendarId: string, opts: EventsListQuery = {}): Promise<EventsListPage> {
		const page = await this.request<ListEventsResponse>(
			"GET",
			`/calendars/${encodeURIComponent(calendarId)}/events`,
			{ query: buildEventsQuery(opts) },
		);

		return {
			items: page.items ?? [],
			nextPageToken: page.nextPageToken,
			nextSyncToken: page.nextSyncToken,
		};
	}

	/**
	 * Pages `listEventsPage` over a time window until exhausted, collecting
	 * every item and returning the last page's `nextSyncToken` (only the
	 * final page of a listing carries one).
	 */
	async listEventsWindow(
		calendarId: string,
		timeMinISO: string,
		timeMaxISO: string,
	): Promise<{ events: GCalEvent[]; nextSyncToken?: string }> {
		const events: GCalEvent[] = [];
		let pageToken: string | undefined;
		let nextSyncToken: string | undefined;

		do {
			const page = await this.listEventsPage(calendarId, {
				timeMin: timeMinISO,
				timeMax: timeMaxISO,
				pageToken,
			});
			events.push(...page.items);
			pageToken = page.nextPageToken;
			nextSyncToken = page.nextSyncToken;
		} while (pageToken !== undefined);

		return { events, nextSyncToken };
	}

	/** POST /calendars/{id}/events. */
	async createEvent(calendarId: string, input: GCalEventInput): Promise<GCalEvent> {
		return this.request<GCalEvent>(
			"POST",
			`/calendars/${encodeURIComponent(calendarId)}/events`,
			{ body: input },
		);
	}

	/** PATCH /calendars/{id}/events/{eventId}, with `If-Match` when `etag` is given. */
	async patchEvent(
		calendarId: string,
		eventId: string,
		patch: GCalEventInput,
		etag?: string,
	): Promise<GCalEvent> {
		return this.request<GCalEvent>(
			"PATCH",
			`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
			{ body: patch, etag },
		);
	}

	/**
	 * DELETE /calendars/{id}/events/{eventId}. A 404 or 410 means the event is
	 * already gone (e.g. deleted elsewhere) — treated as success, not an error.
	 */
	async deleteEvent(calendarId: string, eventId: string, etag?: string): Promise<void> {
		try {
			await this.request<void>(
				"DELETE",
				`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
				{ etag },
			);
		} catch (error) {
			if (error instanceof GCalApiError && (error.status === 404 || error.status === 410)) {
				return;
			}
			throw error;
		}
	}
}
