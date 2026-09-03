/**
 * Query construction for `events.list`, kept out of the client so the exact
 * parameters sent to Google can be asserted in a unit test.
 *
 * Pure module: no `obsidian` import.
 */

/** What one `events.list` page can be asked for. */
export interface EventsListQuery {
	timeMin?: string;
	timeMax?: string;
	syncToken?: string;
	pageToken?: string;
	maxResults?: number;
}

/**
 * The query parameters for one `events.list` page, always with
 * `singleEvents=true` so recurring events arrive already expanded.
 *
 * Two things are deliberately absent:
 *
 * - **`orderBy` is never sent.** Google refuses to return a `nextSyncToken` for
 *   an ordered listing, so asking for `orderBy=startTime` would leave every
 *   full read unable to establish the cursor that incremental sync needs — the
 *   plugin would re-read its whole time window forever. Nothing here depends on
 *   server-side order: the calendar grid places events by time itself, the
 *   sidebar agenda sorts client-side, and the sync engine applies events one by
 *   one in whatever order they arrive.
 * - **`timeMin`/`timeMax` are omitted when a `syncToken` is given.** The API
 *   400s if a time window is sent alongside a sync token; the token already
 *   carries the window the original listing used.
 */
export function buildEventsQuery(opts: EventsListQuery): Record<string, string | undefined> {
	const query: Record<string, string | undefined> = {
		singleEvents: "true",
		pageToken: opts.pageToken,
		maxResults: opts.maxResults !== undefined ? String(opts.maxResults) : undefined,
	};

	if (opts.syncToken !== undefined) {
		query.syncToken = opts.syncToken;
	} else {
		query.timeMin = opts.timeMin;
		query.timeMax = opts.timeMax;
	}

	return query;
}
