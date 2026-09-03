/**
 * The sync engine: vault tasks ↔ Google Calendar events, both directions.
 *
 * Push (`pushDirty`) and pull (`pullChanges`) ride one serialized queue, so a
 * pull can never interleave with a push mid-flight, and `syncCycle` runs them
 * in the only safe order: read what Google has, then write what we have.
 *
 * Three rules shape everything here:
 *
 * 1. **Never clobber.** Every write carries the etag we last saw. A 412 means
 *    Google's copy moved on without us, so the write is skipped and left for
 *    the pull to reconcile — never retried without the etag.
 * 2. **Never delete on a guess.** A mapping whose task is missing from the
 *    index is confirmed against the file on disk before its event is deleted;
 *    an unbuilt index or a `taskFilterTag` change looks identical to a
 *    deletion from the index alone.
 * 3. **Never write to a remembered line number.** Lines move. Every edit to a
 *    task line locates it by its `^blockId` first and gives up rather than
 *    guessing.
 */

import type { App } from "obsidian";
import { GCalApiError, GoneError, PreconditionFailedError, RateLimitError } from "../gcal/errors.ts";
import type { GCalClient } from "../gcal/client.ts";
import type { GCalEvent } from "../gcal/types.ts";
import { ReauthRequiredError } from "../auth/tokenStore.ts";
import { findTaskLine } from "../tasks/index.ts";
import type { IndexedTask, VaultTaskIndex } from "../tasks/index.ts";
import { isTaskDone, parseTaskLine, serializeTask } from "../tasks/parser.ts";
import type { ParsedTask } from "../tasks/parser.ts";
import type { ReminderSuiteSettings } from "../settings.ts";
import { resolveConflict, taskContentHash } from "./mappings.ts";
import type { MappingStore, TaskMapping } from "./mappings.ts";
import { SyncLog } from "./syncLog.ts";
import { drainTombstoneQueue } from "./tombstones.ts";
import type { SyncLogEntry } from "./syncLog.ts";
import { applyEventToTask, isEventWorthy, taskToEventInput } from "./taskEvent.ts";
import type { CompletedTaskStrategy, TaskEventDefaults } from "./taskEvent.ts";

export interface SyncEngineDeps {
	app: App;
	settings: ReminderSuiteSettings;
	client: GCalClient;
	index: VaultTaskIndex;
	mappings: MappingStore;
	/** Persists `settings` — the engine owns `calendarSyncTokens` and has to write them through. */
	saveSettings: () => Promise<void>;
}

/** What the status bar shows. "syncing" is a cycle in flight; "error" survives until the next clean cycle. */
export interface SyncStatus {
	state: "idle" | "syncing" | "error";
	/** When the last cycle that finished without error completed. */
	lastSync?: Date;
	/** Present when `state` is "error": what went wrong, in a form fit for a tooltip. */
	message?: string;
	/** True when the fix is "sign in to Google again" rather than "wait and retry". */
	authRequired?: boolean;
}

/** How far back and forward a calendar with no sync token yet is read. */
const FULL_SYNC_PAST_DAYS = 90;
const FULL_SYNC_FUTURE_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * Cap on pages read from one calendar in one pull. A capped run leaves the old
 * sync token in place, so the next cycle resumes where this one stopped rather
 * than skipping what it didn't read.
 */
const MAX_SYNC_PAGES = 20;

/** Generated block ids are `rs-` + this many base36 characters. */
const BLOCK_ID_CHARS = 6;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
/** Retries before giving up on finding a block id unused in the file. */
const BLOCK_ID_ATTEMPTS = 20;
/** A block id at the very end of a line — matches Obsidian's own block reference syntax. */
const BLOCK_ID_IN_LINE = /\^([A-Za-z0-9-]+)\s*$/u;

function randomBlockId(): string {
	const bytes = new Uint8Array(BLOCK_ID_CHARS);
	crypto.getRandomValues(bytes);
	let id = "";
	for (const byte of bytes) {
		id += BASE36[byte % BASE36.length];
	}
	return `rs-${id}`;
}

/** Every `^id` already used anywhere in the file — block ids must be unique per file, not just per task. */
function blockIdsIn(content: string): Set<string> {
	const ids = new Set<string>();
	for (const line of content.split("\n")) {
		const match = BLOCK_ID_IN_LINE.exec(line);
		if (match !== null) {
			ids.add(match[1]);
		}
	}
	return ids;
}

function generateBlockId(taken: Set<string>): string {
	for (let attempt = 0; attempt < BLOCK_ID_ATTEMPTS; attempt++) {
		const id = randomBlockId();
		if (!taken.has(id)) {
			return id;
		}
	}
	throw new Error("ReminderSuite: could not generate an unused block id for this file");
}

/** What a task is called in a console warning: its text, or its id when it has none. */
function taskLabel(task: IndexedTask): string {
	return task.parsed.description !== "" ? task.parsed.description : (task.parsed.blockId ?? "untitled task");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Today in the machine's own zone, as the ✅ date a completed task carries. */
function todayISO(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * 4xx statuses a retry can still fix: an expired credential (401) and a timed
 * out request (408). Everything else in the 4xx range is a statement about the
 * request itself — a 412 from an event that moved on, a 403 on a calendar we
 * lost access to — and repeating it verbatim will keep failing.
 */
const RECOVERABLE_CLIENT_STATUSES = new Set([401, 408]);

/**
 * Whether retrying this failure later could plausibly succeed. Used to decide
 * whether a pending deletion is worth keeping; the alternative to dropping one
 * is re-queuing it forever.
 */
function isUnrecoverable(error: unknown): boolean {
	if (!(error instanceof GCalApiError) || error instanceof RateLimitError) {
		return false;
	}
	return error.status >= 400 && error.status < 500 && !RECOVERABLE_CLIENT_STATUSES.has(error.status);
}

/** The outcome of an edit to one task line: whether the line was found, and what it became. */
interface TaskLineEdit {
	found: boolean;
	/** The rewritten task, or null when the line was removed — or never found. */
	parsed: ParsedTask | null;
}

export class SyncEngine {
	private deps: SyncEngineDeps;
	/**
	 * Tail of the network queue. Every remote call goes through `enqueue`, so
	 * pushes never overlap each other (or, from Task 7 on, a pull) and can't
	 * race two writes onto the same event.
	 */
	private queue: Promise<unknown> = Promise.resolve();
	/**
	 * Set once the task index has completed its first full build. Until then a
	 * push would read an empty index and conclude every synced task was
	 * deleted, so pushes are refused.
	 */
	private indexReady = false;
	private status: SyncStatus = { state: "idle" };
	private statusListeners = new Set<(status: SyncStatus) => void>();
	private syncLog = new SyncLog();
	/** The cycle currently running, so concurrent callers join it instead of starting a second one. */
	private cycleInFlight: Promise<void> | null = null;

	constructor(deps: SyncEngineDeps) {
		this.deps = deps;
	}

	/** Called by main.ts after the first `taskIndex.rebuild()` resolves. */
	markIndexReady(): void {
		this.indexReady = true;
	}

	/**
	 * Subscribes to sync status changes, firing once immediately with the
	 * current status so a subscriber never has to render a guess. Returns an
	 * unsubscribe function.
	 */
	onStatus(cb: (status: SyncStatus) => void): () => void {
		this.statusListeners.add(cb);
		cb(this.status);
		return () => {
			this.statusListeners.delete(cb);
		};
	}

	/** This session's sync log, oldest entry first. */
	logEntries(): readonly SyncLogEntry[] {
		return this.syncLog.all();
	}

	private setStatus(status: SyncStatus): void {
		this.status = status;
		for (const cb of this.statusListeners) {
			cb(status);
		}
	}

	/** Chains `work` onto the single network queue. A rejected job doesn't break the chain for the next one. */
	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.queue.then(work, work);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private eventDefaults(): TaskEventDefaults {
		return {
			reminderMinutes: this.deps.settings.defaultReminderMinutes,
			timeZone: this.localTimeZone(),
		};
	}

	/** The zone a task's bare wall-clock ⏰ means, on both sides of the sync: the user's own. */
	private localTimeZone(): string {
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	}

	private strategy(): CompletedTaskStrategy {
		return this.deps.settings.completedTaskStrategy;
	}

	/** True when this task currently has a mapping — what the UI branches on to offer sync vs. stop-syncing. */
	isSynced(task: IndexedTask): boolean {
		return task.parsed.blockId !== null && this.deps.mappings.get(task.parsed.blockId) !== null;
	}

	/**
	 * Returns the task's block id, stamping a fresh one onto the line first if
	 * it has none. The write goes through `vault.process` and re-locates the
	 * line by its canonical serialization, so a file edited since the index
	 * last saw it never gets the wrong line rewritten.
	 *
	 * Not queued: this is vault work, not network work, and `optIn` calls it
	 * from inside the queue.
	 */
	async ensureBlockId(task: IndexedTask): Promise<string> {
		if (task.parsed.blockId !== null) {
			return task.parsed.blockId;
		}
		const file = this.deps.app.vault.getFileByPath(task.filePath);
		if (file === null) {
			throw new Error(`ReminderSuite: file not found for task: ${task.filePath}`);
		}

		const expectedCanonical = serializeTask(task.parsed);
		let assigned: string | null = null;
		let updatedLine: number | null = null;

		await this.deps.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			const targetLine = findTaskLine(lines, task.line, expectedCanonical);
			if (targetLine === null) {
				throw new Error(
					`ReminderSuite: could not find task to sync (file changed): ${task.filePath}:${task.line}`,
				);
			}
			const rawLine = lines[targetLine];
			const hadCR = rawLine.endsWith("\r");
			const parsed = parseTaskLine(rawLine);
			if (parsed === null) {
				throw new Error(`ReminderSuite: line ${targetLine} in ${task.filePath} is no longer a task`);
			}
			updatedLine = targetLine;
			if (parsed.blockId !== null) {
				// Something added an id between indexing and now — adopt it rather than writing a second one.
				assigned = parsed.blockId;
				return content;
			}
			const id = generateBlockId(blockIdsIn(content));
			lines[targetLine] = serializeTask({ ...parsed, blockId: id }) + (hadCR ? "\r" : "");
			assigned = id;
			return lines.join("\n");
		});

		if (assigned === null) {
			throw new Error(`ReminderSuite: failed to assign a block id in ${task.filePath}`);
		}
		task.parsed.blockId = assigned;
		if (updatedLine !== null) {
			task.line = updatedLine;
		}
		return assigned;
	}

	/** Creates the task's Google event and records the mapping. Throws (for the caller to surface) on failure. */
	async optIn(task: IndexedTask, calendarId: string): Promise<void> {
		if (calendarId === "") {
			throw new Error("Choose a default calendar for tasks in ReminderSuite settings first.");
		}
		// Checked before ensureBlockId: opting in edits the user's note, and a
		// task that can't become an event shouldn't be marked up for nothing.
		if (!isEventWorthy(task.parsed)) {
			throw new Error("Add a due date (📅) or a reminder time (⏰) before syncing this task to Google.");
		}
		return this.enqueue(async () => {
			const blockId = await this.ensureBlockId(task);
			if (this.deps.mappings.get(blockId) !== null) {
				return;
			}
			const input = taskToEventInput(task.parsed, blockId, this.eventDefaults(), this.strategy());
			if (input === null) {
				throw new Error("Add a due date (📅) or a reminder time (⏰) before syncing this task to Google.");
			}
			const event = await this.deps.client.createEvent(calendarId, input);
			await this.deps.mappings.upsert({
				blockId,
				filePath: task.filePath,
				calendarId,
				eventId: event.id,
				etag: event.etag,
				lastSyncedHash: taskContentHash(task.parsed),
				...(event.updated !== undefined ? { updatedRemote: event.updated } : {}),
			});
		});
	}

	/**
	 * Deletes the task's Google event and drops the mapping. The task line —
	 * block id included — is left untouched: the id is harmless, and keeping it
	 * means re-syncing later reuses the same identity.
	 */
	async optOut(task: IndexedTask): Promise<void> {
		const blockId = task.parsed.blockId;
		if (blockId === null) {
			return;
		}
		return this.enqueue(async () => {
			const mapping = this.deps.mappings.get(blockId);
			if (mapping === null) {
				return;
			}
			try {
				await this.deps.client.deleteEvent(mapping.calendarId, mapping.eventId, mapping.etag);
			} catch (error) {
				if (!(error instanceof PreconditionFailedError)) {
					throw error;
				}
				// The event changed in Google since we last saw it. Deleting it now
				// would throw away an edit we've never read, so it stays — only the
				// link goes.
				console.warn(
					`ReminderSuite: "${taskLabel(task)}" changed in Google since the last sync; unlinked it but left the event in place.`,
				);
			}
			await this.deps.mappings.remove(blockId);
		});
	}

	/**
	 * One full sync cycle: pull Google's changes in, then push ours out. That
	 * order matters — pulling first means a local edit is pushed on top of the
	 * remote state we just read, rather than racing it.
	 *
	 * Not itself queued (its two halves are), so it can't deadlock waiting on
	 * work it queued itself. Callers that arrive while a cycle is running join
	 * that cycle instead of starting a second one, and it never rejects: a
	 * failure becomes the error status.
	 */
	async syncCycle(): Promise<void> {
		const running = this.cycleInFlight;
		if (running !== null) {
			return running;
		}
		const cycle = this.runCycle().finally(() => {
			this.cycleInFlight = null;
		});
		this.cycleInFlight = cycle;
		return cycle;
	}

	private async runCycle(): Promise<void> {
		this.setStatus({ state: "syncing", lastSync: this.status.lastSync });
		let failure: unknown = null;
		try {
			await this.pullChanges();
		} catch (error) {
			failure = error;
		}
		// A failed pull doesn't cancel the push: every push carries an If-Match
		// etag, so an unread remote change can only ever skip a push, never be
		// overwritten by one. Re-authentication is the exception — nothing will
		// reach Google until the user signs in again.
		if (!(failure instanceof ReauthRequiredError)) {
			try {
				await this.pushDirty();
			} catch (error) {
				failure ??= error;
			}
		}

		if (failure === null) {
			this.setStatus({ state: "idle", lastSync: new Date() });
			return;
		}
		const message = errorMessage(failure);
		console.warn("ReminderSuite: sync cycle failed.", failure);
		this.syncLog.add("cycle-failed", undefined, message);
		this.setStatus({
			state: "error",
			lastSync: this.status.lastSync,
			message,
			authRequired: failure instanceof ReauthRequiredError,
		});
	}

	/** Pushes every mapping whose task has changed since its last sync. Safe to call often; a clean ledger is a no-op. */
	async pushDirty(): Promise<void> {
		if (!this.indexReady || this.deps.mappings.all().length === 0) {
			return;
		}
		return this.enqueue(async () => {
			// Snapshot: the ledger mutates as mappings are removed mid-run.
			for (const mapping of [...this.deps.mappings.all()]) {
				try {
					await this.pushOne(mapping);
				} catch (error) {
					if (error instanceof ReauthRequiredError) {
						console.warn("ReminderSuite: sync paused — sign in to Google again.", error);
						return;
					}
					console.warn(`ReminderSuite: failed to sync task ${mapping.blockId} to Google.`, error);
				}
			}
		});
	}

	/** Moves mappings with the old path onto the new one, so a moved note's tasks stay linked. */
	async handleFileRenamed(oldPath: string, newPath: string): Promise<void> {
		for (const mapping of this.deps.mappings.all().filter((m) => m.filePath === oldPath)) {
			await this.deps.mappings.updateFilePath(mapping.blockId, newPath);
		}
	}

	private async pushOne(mapping: TaskMapping): Promise<void> {
		const task = this.deps.index.byBlockId(mapping.blockId);
		if (task === null) {
			await this.handleMissingTask(mapping);
			return;
		}
		if (task.filePath !== mapping.filePath) {
			await this.deps.mappings.updateFilePath(mapping.blockId, task.filePath);
		}

		const hash = taskContentHash(task.parsed);
		if (hash === mapping.lastSyncedHash) {
			return;
		}

		if (isTaskDone(task.parsed) && this.strategy() === "delete") {
			await this.deleteRemote(mapping, `"${taskLabel(task)}" was completed`);
			await this.deps.mappings.remove(mapping.blockId);
			this.syncLog.add("push-deleted", mapping.blockId, "task completed");
			return;
		}

		const input = taskToEventInput(task.parsed, mapping.blockId, this.eventDefaults(), this.strategy());
		if (input === null) {
			// The task lost its date, so there's nothing to place on a calendar.
			// Deleting the event on the user's behalf would be destructive, so it
			// stays as-is; the hash advances only to keep this from warning on
			// every subsequent push.
			console.warn(
				`ReminderSuite: "${taskLabel(task)}" no longer has a due date or reminder; its Google event was left unchanged. Stop syncing the task to remove it.`,
			);
			await this.deps.mappings.upsert({ ...mapping, lastSyncedHash: hash });
			return;
		}

		let updated: GCalEvent;
		try {
			updated = await this.deps.client.patchEvent(
				mapping.calendarId,
				mapping.eventId,
				input,
				mapping.etag,
			);
		} catch (error) {
			if (error instanceof PreconditionFailedError) {
				// Both sides changed. The pull resolves that with the timestamps in
				// hand; pushing over it here would silently discard the Google edit.
				console.warn(
					`ReminderSuite: "${taskLabel(task)}" changed in both places — conflict, deferred to pull.`,
				);
				this.syncLog.add("push-deferred", mapping.blockId, "changed in both places");
				return;
			}
			if (error instanceof GCalApiError && (error.status === 404 || error.status === 410)) {
				console.warn(
					`ReminderSuite: the Google event for "${taskLabel(task)}" no longer exists; stopped syncing that task.`,
				);
				await this.deps.mappings.remove(mapping.blockId);
				this.syncLog.add("push-unlinked", mapping.blockId, "event no longer exists");
				return;
			}
			throw error;
		}

		await this.deps.mappings.upsert({
			...mapping,
			filePath: task.filePath,
			etag: updated.etag,
			lastSyncedHash: hash,
			...(updated.updated !== undefined ? { updatedRemote: updated.updated } : {}),
		});
		this.syncLog.add("push", mapping.blockId, task.parsed.description);
	}

	/**
	 * A mapping with no task in the index. Usually the task line was deleted —
	 * but an unbuilt index or a newly set `taskFilterTag` looks the same from
	 * here, so the file on disk gets the deciding vote before anything is
	 * deleted in Google.
	 */
	private async handleMissingTask(mapping: TaskMapping): Promise<void> {
		if (await this.blockIdStillOnDisk(mapping)) {
			return;
		}
		const deleted = await this.deleteRemote(mapping, `the task for ${mapping.blockId} was deleted`);
		this.syncLog.add("push-deleted", mapping.blockId, deleted ? "task deleted" : "task deleted, event kept");
		if (deleted) {
			// Recorded before the mapping goes, so the pull can tell "we deleted
			// this" apart from "an event we've never seen".
			await this.deps.mappings.addTombstone({
				calendarId: mapping.calendarId,
				eventId: mapping.eventId,
				etag: mapping.etag,
				deletedAt: new Date().toISOString(),
			});
		}
		await this.deps.mappings.remove(mapping.blockId);
	}

	/** True when the mapped file still contains the block id — i.e. the task exists but isn't indexed. */
	private async blockIdStillOnDisk(mapping: TaskMapping): Promise<boolean> {
		const file = this.deps.app.vault.getFileByPath(mapping.filePath);
		if (file === null) {
			return false;
		}
		try {
			const content = await this.deps.app.vault.cachedRead(file);
			return content.includes(`^${mapping.blockId}`);
		} catch (error) {
			// Unreadable file: assume the task is still there rather than deleting its event.
			console.warn(`ReminderSuite: could not read ${mapping.filePath} while syncing.`, error);
			return true;
		}
	}

	/**
	 * Deletes the mapped event. Returns false when a 412 left it in place —
	 * the remote copy has changes we've never read, and unlinking is the safe
	 * half of the operation.
	 */
	private async deleteRemote(mapping: TaskMapping, reason: string): Promise<boolean> {
		try {
			await this.deps.client.deleteEvent(mapping.calendarId, mapping.eventId, mapping.etag);
			return true;
		} catch (error) {
			if (error instanceof PreconditionFailedError) {
				console.warn(
					`ReminderSuite: ${reason}, but its Google event changed since the last sync; unlinked it and left the event in place.`,
				);
				return false;
			}
			throw error;
		}
	}

	// ---- Pull: Google → vault ---------------------------------------------

	/**
	 * Reads what changed in Google and applies it to the mapped tasks: pending
	 * deletions first, then each calendar's changes since its sync token.
	 *
	 * Enqueued on the same serialized queue as `pushDirty`, so a pull and a push
	 * can never be in flight at once. One calendar's failure doesn't stop the
	 * others — but the first of them is rethrown at the end, so a partial pull
	 * still reads as a failed cycle rather than a silent one.
	 */
	async pullChanges(): Promise<void> {
		if (!this.indexReady) {
			// Without an index there's no way to tell a locally edited task from an
			// untouched one, and every conflict would resolve as "remote wins".
			this.syncLog.add("pull-skipped", undefined, "task index not built yet");
			return;
		}
		return this.enqueue(async () => {
			await this.drainTombstones();
			let firstError: unknown = null;
			for (const calendarId of this.calendarsToPull()) {
				try {
					await this.pullCalendar(calendarId);
				} catch (error) {
					if (error instanceof ReauthRequiredError) {
						throw error;
					}
					console.warn(`ReminderSuite: could not pull changes from calendar ${calendarId}.`, error);
					this.syncLog.add("pull-failed", calendarId, errorMessage(error));
					firstError ??= error;
				}
			}
			if (firstError !== null) {
				throw firstError;
			}
		});
	}

	/**
	 * Calendars worth reading: the ones on display, plus any calendar holding a
	 * mapping. A task keeps syncing after its calendar is switched off in the
	 * view — hiding a calendar is about what's drawn, not about what's synced.
	 */
	private calendarsToPull(): string[] {
		const ids = new Set(this.deps.settings.enabledCalendarIds);
		for (const mapping of this.deps.mappings.all()) {
			ids.add(mapping.calendarId);
		}
		return [...ids];
	}

	/**
	 * Deletions this plugin recorded but never got to confirm with Google. The
	 * queue is taken in one step, so `drainTombstoneQueue` owns putting back
	 * whatever it couldn't settle — including everything left untried when a
	 * re-auth demand cuts the pass short. A 4xx that a retry can't fix (a 412
	 * from an event that changed, a 403 on a calendar we lost access to) is
	 * dropped rather than re-queued forever.
	 */
	private async drainTombstones(): Promise<void> {
		const pending = await this.deps.mappings.takeTombstones();
		await drainTombstoneQueue(pending, {
			deleteEvent: (tombstone) =>
				this.deps.client.deleteEvent(tombstone.calendarId, tombstone.eventId, tombstone.etag),
			requeue: (tombstone) => this.deps.mappings.addTombstone(tombstone),
			isUnrecoverable,
			isAborting: (error) => error instanceof ReauthRequiredError,
			record: (outcome, tombstone, error) => {
				if (outcome === "dropped") {
					console.warn(`ReminderSuite: gave up deleting Google event ${tombstone.eventId}.`, error);
				}
				this.syncLog.add(
					`tombstone-${outcome}`,
					tombstone.eventId,
					error !== undefined ? errorMessage(error) : undefined,
				);
			},
		});
	}

	/**
	 * One calendar's changes. With a sync token that's an incremental read;
	 * without one it's a windowed full read that establishes the token.
	 *
	 * A 410 means Google expired the token and wants us to start over. That
	 * earns exactly one immediate full re-sync — if the retry 410s too,
	 * something is wrong beyond a stale cursor and the error surfaces.
	 */
	private async pullCalendar(calendarId: string): Promise<void> {
		const token = this.deps.settings.calendarSyncTokens[calendarId];
		if (token === undefined || token === "") {
			await this.fullSyncCalendar(calendarId);
			return;
		}
		try {
			await this.incrementalSyncCalendar(calendarId, token);
		} catch (error) {
			if (!(error instanceof GoneError)) {
				throw error;
			}
			console.warn(`ReminderSuite: the sync token for ${calendarId} expired; re-reading that calendar.`);
			this.syncLog.add("sync-token-expired", calendarId);
			await this.setSyncToken(calendarId, undefined);
			await this.fullSyncCalendar(calendarId);
		}
	}

	private async fullSyncCalendar(calendarId: string): Promise<void> {
		const now = Date.now();
		const { events, nextSyncToken } = await this.deps.client.listEventsWindow(
			calendarId,
			new Date(now - FULL_SYNC_PAST_DAYS * MS_PER_DAY).toISOString(),
			new Date(now + FULL_SYNC_FUTURE_DAYS * MS_PER_DAY).toISOString(),
		);
		for (const event of events) {
			await this.applyRemoteEvent(calendarId, event);
		}
		if (nextSyncToken === undefined) {
			// Correct but wasteful: the next cycle reads the whole window again.
			this.syncLog.add("no-sync-token", calendarId, "full read returned no token");
			return;
		}
		await this.setSyncToken(calendarId, nextSyncToken);
	}

	private async incrementalSyncCalendar(calendarId: string, syncToken: string): Promise<void> {
		let pageToken: string | undefined;
		for (let page = 0; page < MAX_SYNC_PAGES; page++) {
			const result = await this.deps.client.listEventsPage(calendarId, { syncToken, pageToken });
			for (const event of result.items) {
				await this.applyRemoteEvent(calendarId, event);
			}
			if (result.nextPageToken === undefined) {
				// Only the last page of a sync carries the next token.
				if (result.nextSyncToken !== undefined) {
					await this.setSyncToken(calendarId, result.nextSyncToken);
				}
				return;
			}
			pageToken = result.nextPageToken;
		}
		console.warn(
			`ReminderSuite: stopped reading ${calendarId} after ${MAX_SYNC_PAGES} pages; the rest arrives next sync.`,
		);
	}

	private async setSyncToken(calendarId: string, token: string | undefined): Promise<void> {
		const tokens = this.deps.settings.calendarSyncTokens;
		if (token === undefined) {
			delete tokens[calendarId];
		} else {
			tokens[calendarId] = token;
		}
		await this.deps.saveSettings();
	}

	/**
	 * One pulled event. Only events with a mapping are acted on: an event this
	 * plugin didn't create belongs to Google alone — calendar-born events stay
	 * virtual, and there is no task for them to change.
	 */
	private async applyRemoteEvent(calendarId: string, event: GCalEvent): Promise<void> {
		const stored = this.deps.mappings.byEventId(event.id);
		if (stored === null || stored.calendarId !== calendarId) {
			return;
		}
		// Everything below reads or writes `mapping.filePath`, and the index knows
		// where the task lives now — a note moved while the plugin was off never
		// reached `handleFileRenamed`.
		const task = this.deps.index.byBlockId(stored.blockId);
		let mapping = stored;
		if (task !== null && task.filePath !== stored.filePath) {
			await this.deps.mappings.updateFilePath(stored.blockId, task.filePath);
			// Re-read rather than assuming the store healed the object we're holding.
			// It does today (`updateFilePath` mutates in place), but nothing below
			// should depend on that: a store that replaced the mapping instead would
			// leave this path stale, and a stale path reads as "file not found" —
			// which silently sends every conflict here to "local wins" and buries the
			// remote edit for good.
			mapping = this.deps.mappings.get(stored.blockId) ?? { ...stored, filePath: task.filePath };
		}

		if (event.status === "cancelled") {
			await this.handleRemoteDeletion(mapping);
			return;
		}
		if (event.updated !== undefined && event.updated === mapping.updatedRemote) {
			// Already applied. Incremental reads rarely repeat, but a full window
			// read hands back everything, most of it ours and already current.
			return;
		}

		if (task !== null && taskContentHash(task.parsed) !== mapping.lastSyncedHash) {
			await this.resolveTwoSidedEdit(mapping, event, task);
			return;
		}
		await this.applyRemoteToTask(mapping, event);
	}

	/**
	 * Both copies changed since the last sync, so one of them is about to lose
	 * changes. Newest wins, comparing the file's mtime against the event's
	 * `updated`; when either timestamp is missing the local file keeps its
	 * changes, that being the copy the user would notice losing.
	 *
	 * This is the one path that always warns — something is being overwritten
	 * either way, and the user deserves to be able to find out which.
	 */
	private async resolveTwoSidedEdit(mapping: TaskMapping, event: GCalEvent, task: IndexedTask): Promise<void> {
		const mtime = this.fileMtime(mapping.filePath);
		const winner =
			event.updated !== undefined && mtime !== null ? resolveConflict(mtime, event.updated) : "local";
		console.warn(
			`ReminderSuite: "${taskLabel(task)}" (^${mapping.blockId}) changed in both places since the last sync; the ${winner} version won.`,
		);
		this.syncLog.add("conflict", mapping.blockId, `${winner} version won`);

		if (winner === "remote") {
			await this.applyRemoteToTask(mapping, event);
			return;
		}
		// The event we just read carries a current etag, so pushing the local
		// version over it can't fail the If-Match on the change we already know
		// about — this is a decision, not a race.
		const refreshed: TaskMapping = {
			...mapping,
			etag: event.etag,
			...(event.updated !== undefined ? { updatedRemote: event.updated } : {}),
		};
		await this.deps.mappings.upsert(refreshed);
		await this.pushOne(refreshed);
	}

	/** Rewrites the mapped task line from the event, then records what we now hold. */
	private async applyRemoteToTask(mapping: TaskMapping, event: GCalEvent): Promise<void> {
		const edit = await this.editTaskLine(mapping, (parsed) =>
			applyEventToTask(parsed, event, {
				strategy: this.strategy(),
				todayISO: todayISO(),
				fallbackTimeZone: this.localTimeZone(),
			}),
		);
		if (!edit.found || edit.parsed === null) {
			console.warn(
				`ReminderSuite: couldn't find the task for ^${mapping.blockId} in ${mapping.filePath}; its Google event was left alone.`,
			);
			this.syncLog.add("apply-failed", mapping.blockId, "task line not found");
			return;
		}
		await this.deps.mappings.upsert({
			...mapping,
			etag: event.etag,
			lastSyncedHash: taskContentHash(edit.parsed),
			...(event.updated !== undefined ? { updatedRemote: event.updated } : {}),
		});
		this.syncLog.add("remote-applied", mapping.blockId, event.summary);
	}

	/**
	 * The event is gone from Google. What that means for the task is the user's
	 * call (`remoteDeleteBehavior`); the mapping goes either way, because there
	 * is no longer an event on the other end of it.
	 */
	private async handleRemoteDeletion(mapping: TaskMapping): Promise<void> {
		const behavior = this.deps.settings.remoteDeleteBehavior;
		if (behavior === "complete") {
			await this.completeTask(mapping);
		} else if (behavior === "delete-line") {
			const edit = await this.editTaskLine(mapping, () => null);
			if (!edit.found) {
				this.syncLog.add("apply-failed", mapping.blockId, "task line not found");
			}
		}
		await this.deps.mappings.remove(mapping.blockId);
		this.syncLog.add("remote-deleted", mapping.blockId, behavior);
	}

	/** Ticks a task off after its event was deleted in Google. */
	private async completeTask(mapping: TaskMapping): Promise<void> {
		const task = this.deps.index.byBlockId(mapping.blockId);
		if (task !== null && isTaskDone(task.parsed)) {
			return;
		}
		if (task !== null) {
			try {
				// The index's own writeback stamps the ✅ date and notifies the views.
				await this.deps.index.setTaskChecked(task, true);
				return;
			} catch (error) {
				console.warn(`ReminderSuite: couldn't tick off ^${mapping.blockId} the usual way.`, error);
			}
		}
		// Not indexed, or the line drifted beyond what setTaskChecked searches:
		// fall back to finding it by block id anywhere in the file.
		const edit = await this.editTaskLine(mapping, (parsed) =>
			isTaskDone(parsed) ? parsed : { ...parsed, checked: "x", done: parsed.done ?? todayISO() },
		);
		if (!edit.found) {
			this.syncLog.add("apply-failed", mapping.blockId, "task line not found");
		}
	}

	/**
	 * Replaces the task line carrying `^blockId` with `transform`'s result, or
	 * removes the line when that result is null.
	 *
	 * The line is located by searching the whole file for the block id, never by
	 * a stored line number — a mapping can be days old and lines move. Nothing
	 * is written when the rewritten line is identical to the old one: a
	 * pointless write would bump the file's mtime and make the task look locally
	 * edited to the very next cycle.
	 */
	private async editTaskLine(
		mapping: TaskMapping,
		transform: (parsed: ParsedTask) => ParsedTask | null,
	): Promise<TaskLineEdit> {
		const file = this.deps.app.vault.getFileByPath(mapping.filePath);
		if (file === null) {
			return { found: false, parsed: null };
		}
		const marker = `^${mapping.blockId}`;
		let edit: TaskLineEdit = { found: false, parsed: null };

		await this.deps.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			let target = -1;
			let parsed: ParsedTask | null = null;
			for (let i = 0; i < lines.length; i++) {
				if (!lines[i].includes(marker)) {
					continue;
				}
				const candidate = parseTaskLine(lines[i]);
				if (candidate !== null && candidate.blockId === mapping.blockId) {
					target = i;
					parsed = candidate;
					break;
				}
			}
			if (target === -1 || parsed === null) {
				return content;
			}

			const next = transform(parsed);
			if (next === null) {
				lines.splice(target, 1);
				edit = { found: true, parsed: null };
				return lines.join("\n");
			}
			const raw = lines[target];
			const rewritten = serializeTask(next) + (raw.endsWith("\r") ? "\r" : "");
			edit = { found: true, parsed: next };
			if (rewritten === raw) {
				return content;
			}
			lines[target] = rewritten;
			return lines.join("\n");
		});

		if (edit.found) {
			// The index has to see this before the push half of the same cycle does.
			// The metadata cache lags a write by its own debounce, and a push that
			// read the pre-pull task would send it straight back to Google, undoing
			// the change just applied.
			await this.deps.index.refreshFile(file);
			// Belt and braces, and it has to come second: refreshFile builds fresh
			// IndexedTask objects, so anything written onto the old ones is thrown
			// away. This pins the re-read to what was actually written, in case the
			// file cache handed refreshFile a stale copy.
			const indexed = this.deps.index.byBlockId(mapping.blockId);
			if (indexed !== null && edit.parsed !== null) {
				indexed.parsed = edit.parsed;
			}
		}
		return edit;
	}

	/** The mapped file's last-modified time in epoch ms, or null when there's no such file. */
	private fileMtime(filePath: string): number | null {
		return this.deps.app.vault.getFileByPath(filePath)?.stat.mtime ?? null;
	}
}
