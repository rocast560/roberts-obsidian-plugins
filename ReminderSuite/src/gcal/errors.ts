/**
 * Error classification for the Google Calendar REST API, plus the pure
 * backoff-delay math used to retry rate-limited requests.
 *
 * Pure module: no `obsidian` import, so it can be unit-tested directly.
 */

/** Shape of Google's JSON error body, as much of it as this plugin reads. */
interface GoogleErrorBody {
	error?: {
		message?: string;
		status?: string;
		errors?: { reason?: string }[];
	};
}

export class GCalApiError extends Error {
	status: number;
	reason?: string;

	constructor(message: string, status: number, reason?: string) {
		super(message);
		this.name = "GCalApiError";
		this.status = status;
		this.reason = reason;
	}
}

/** 410 Gone — a sync token (or event) has expired; callers must resync from scratch. */
export class GoneError extends GCalApiError {
	constructor(message: string, reason?: string) {
		super(message, 410, reason);
		this.name = "GoneError";
	}
}

/** 412 Precondition Failed — an `If-Match` etag no longer matches; callers handle the conflict. */
export class PreconditionFailedError extends GCalApiError {
	constructor(message: string, reason?: string) {
		super(message, 412, reason);
		this.name = "PreconditionFailedError";
	}
}

/** 429, or 403 with a rate-limit reason — retried inside the client with backoff. */
export class RateLimitError extends GCalApiError {
	constructor(message: string, status: number, reason?: string) {
		super(message, status, reason);
		this.name = "RateLimitError";
	}
}

function extractReason(body: unknown): string | undefined {
	const details = body as GoogleErrorBody | undefined;
	const fromErrors = details?.error?.errors?.[0]?.reason;
	if (typeof fromErrors === "string") {
		return fromErrors;
	}
	const status = details?.error?.status;
	return typeof status === "string" ? status : undefined;
}

function extractMessage(body: unknown, status: number): string {
	const details = body as GoogleErrorBody | undefined;
	const message = details?.error?.message;
	return typeof message === "string" && message !== ""
		? message
		: `Google Calendar API request failed with status ${status}`;
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/** Maps an HTTP status + JSON error body from the Calendar API to a typed error. */
export function classifyError(status: number, body: unknown): GCalApiError {
	const reason = extractReason(body);
	const message = extractMessage(body, status);

	if (status === 410) {
		return new GoneError(message, reason);
	}
	if (status === 412) {
		return new PreconditionFailedError(message, reason);
	}
	if (status === 429 || (status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason))) {
		return new RateLimitError(message, status, reason);
	}
	return new GCalApiError(message, status, reason);
}

/** Cap on the exponential backoff base delay (attempt 3 and beyond stay at 4s). */
const BACKOFF_MAX_BASE_MS = 4000;
/** Backoff base delay for the first retry. */
const BACKOFF_BASE_MS = 1000;
/** Upper bound on the random jitter added to each backoff delay. */
const BACKOFF_JITTER_MAX_MS = 250;

/**
 * Exponential backoff with jitter for retrying a rate-limited request:
 * 1s, 2s, 4s (capped) plus up to 250ms of jitter. `attempt` is the 1-based
 * attempt number that just failed. `random` defaults to `Math.random` and is
 * injectable so the delay is deterministically testable.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
	const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_BASE_MS);
	const jitter = Math.floor(random() * BACKOFF_JITTER_MAX_MS);
	return base + jitter;
}
