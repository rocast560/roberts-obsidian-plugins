import assert from "node:assert/strict";
import { test } from "node:test";
import {
	GCalApiError,
	GoneError,
	PreconditionFailedError,
	RateLimitError,
	backoffDelayMs,
	classifyError,
} from "../src/gcal/errors.ts";
import { buildEventsQuery } from "../src/gcal/query.ts";

test("classifyError maps 410 to GoneError", () => {
	const error = classifyError(410, {
		error: { message: "Resource has been deleted" },
	});
	assert.ok(error instanceof GoneError);
	assert.ok(error instanceof GCalApiError);
	assert.strictEqual(error.status, 410);
});

test("classifyError maps 412 to PreconditionFailedError", () => {
	const error = classifyError(412, { error: { message: "Precondition Failed" } });
	assert.ok(error instanceof PreconditionFailedError);
	assert.strictEqual(error.status, 412);
});

test("classifyError maps 429 to RateLimitError", () => {
	const error = classifyError(429, { error: { message: "Too Many Requests" } });
	assert.ok(error instanceof RateLimitError);
	assert.strictEqual(error.status, 429);
});

test("classifyError maps 403 rateLimitExceeded to RateLimitError", () => {
	const error = classifyError(403, {
		error: {
			message: "Rate Limit Exceeded",
			errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }],
		},
	});
	assert.ok(error instanceof RateLimitError);
	assert.strictEqual(error.status, 403);
	assert.strictEqual(error.reason, "rateLimitExceeded");
});

test("classifyError maps 403 userRateLimitExceeded to RateLimitError", () => {
	const error = classifyError(403, {
		error: {
			message: "User Rate Limit Exceeded",
			errors: [{ domain: "usageLimits", reason: "userRateLimitExceeded" }],
		},
	});
	assert.ok(error instanceof RateLimitError);
	assert.strictEqual(error.reason, "userRateLimitExceeded");
});

test("classifyError maps other 403 reasons to plain GCalApiError, not RateLimitError", () => {
	const error = classifyError(403, {
		error: {
			message: "Forbidden",
			errors: [{ domain: "global", reason: "forbidden" }],
		},
	});
	assert.ok(!(error instanceof RateLimitError));
	assert.ok(!(error instanceof GoneError));
	assert.ok(!(error instanceof PreconditionFailedError));
	assert.ok(error instanceof GCalApiError);
	assert.strictEqual(error.status, 403);
	assert.strictEqual(error.reason, "forbidden");
});

test("classifyError maps unrelated statuses to plain GCalApiError", () => {
	const error = classifyError(500, { error: { message: "Internal error" } });
	assert.ok(!(error instanceof GoneError));
	assert.ok(!(error instanceof PreconditionFailedError));
	assert.ok(!(error instanceof RateLimitError));
	assert.ok(error instanceof GCalApiError);
	assert.strictEqual(error.status, 500);
});

test("classifyError tolerates a missing/malformed body", () => {
	const error = classifyError(500, undefined);
	assert.ok(error instanceof GCalApiError);
	assert.strictEqual(error.status, 500);
	assert.strictEqual(error.reason, undefined);
	assert.ok(error.message.length > 0);
});

test("classifyError falls back to error.status when errors[] is absent", () => {
	const error = classifyError(429, { error: { message: "Too Many Requests", status: "RESOURCE_EXHAUSTED" } });
	assert.ok(error instanceof RateLimitError);
	assert.strictEqual(error.reason, "RESOURCE_EXHAUSTED");
});

test("backoffDelayMs doubles the base delay across attempts 1-3", () => {
	assert.strictEqual(backoffDelayMs(1, () => 0), 1000);
	assert.strictEqual(backoffDelayMs(2, () => 0), 2000);
	assert.strictEqual(backoffDelayMs(3, () => 0), 4000);
});

test("backoffDelayMs caps the base delay at 4s beyond attempt 3", () => {
	assert.strictEqual(backoffDelayMs(4, () => 0), 4000);
	assert.strictEqual(backoffDelayMs(10, () => 0), 4000);
});

test("backoffDelayMs adds jitter no larger than 250ms", () => {
	assert.strictEqual(backoffDelayMs(1, () => 1), 1250);
	assert.strictEqual(backoffDelayMs(1, () => 0.5), 1125);
	assert.strictEqual(backoffDelayMs(1, () => 0), 1000);
});

// ---- buildEventsQuery --------------------------------------------------

test("buildEventsQuery sends the time window and expanded recurrences on a full read", () => {
	const query = buildEventsQuery({ timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-12-31T00:00:00Z" });
	assert.strictEqual(query.singleEvents, "true");
	assert.strictEqual(query.timeMin, "2026-01-01T00:00:00Z");
	assert.strictEqual(query.timeMax, "2026-12-31T00:00:00Z");
});

test("buildEventsQuery never sends orderBy — it would suppress nextSyncToken", () => {
	const full = buildEventsQuery({ timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-12-31T00:00:00Z" });
	assert.ok(!("orderBy" in full));
	const incremental = buildEventsQuery({ syncToken: "tok-1" });
	assert.ok(!("orderBy" in incremental));
});

test("buildEventsQuery sends a sync token with no time window", () => {
	const query = buildEventsQuery({ syncToken: "tok-1", timeMin: "2026-01-01T00:00:00Z", timeMax: "2026-12-31T00:00:00Z" });
	assert.strictEqual(query.syncToken, "tok-1");
	assert.ok(!("timeMin" in query));
	assert.ok(!("timeMax" in query));
	assert.strictEqual(query.singleEvents, "true");
});

test("buildEventsQuery passes through paging options and omits absent ones", () => {
	const paged = buildEventsQuery({ syncToken: "tok-1", pageToken: "page-2", maxResults: 250 });
	assert.strictEqual(paged.pageToken, "page-2");
	assert.strictEqual(paged.maxResults, "250");

	const first = buildEventsQuery({ syncToken: "tok-1" });
	assert.strictEqual(first.pageToken, undefined);
	assert.strictEqual(first.maxResults, undefined);
	assert.strictEqual(first.syncToken, "tok-1");
});
