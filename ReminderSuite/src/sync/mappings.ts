/**
 * The task↔event mapping ledger: which vault task line owns which Google
 * Calendar event, and what we last pushed for it.
 *
 * Pure module: no `obsidian` import. The store is constructed over a plain
 * object (in production, the plugin's settings) plus an injected `save`, so it
 * is unit-testable without a vault. Every mutation writes through to that
 * object's arrays — they ARE the persisted state — and then saves.
 *
 * Task 6 uses this for the local→remote push; Task 7's pull consumes the same
 * store, plus the tombstones a local deletion leaves behind.
 */

import { serializeTask } from "../tasks/parser.ts";
import type { ParsedTask } from "../tasks/parser.ts";

/** One synced task line. `blockId` is the task's `^id`, the stable identity across edits and file moves. */
export interface TaskMapping {
	blockId: string;
	filePath: string;
	calendarId: string;
	eventId: string;
	/** Etag of the last version we wrote or saw; sent as `If-Match` so a remote edit can't be clobbered. */
	etag: string;
	/** `taskContentHash` of the task as last pushed — the dirty check. */
	lastSyncedHash: string;
	/** The remote event's `updated` timestamp as last seen. Task 7 uses it to order conflicting edits. */
	updatedRemote?: string;
}

/**
 * A remote event this plugin deleted because its task disappeared locally.
 * Recorded so Task 7's pull doesn't mistake the deletion for a remote event
 * it has never seen and re-create the task. `deletedAt` is stamped by the
 * caller — nothing in this module reads the clock.
 */
export interface Tombstone {
	calendarId: string;
	eventId: string;
	etag?: string;
	/** ISO 8601, stamped by the caller. */
	deletedAt: string;
}

/** The persisted slice `MappingStore` owns. `ReminderSuiteSettings` structurally satisfies this. */
export interface MappingStoreData {
	syncMappings: TaskMapping[];
	syncTombstones: Tombstone[];
}

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * A stable content hash of everything about a task that a synced event
 * reflects — description, dates, priority, completion — deliberately EXCLUDING
 * the block id, which is sync bookkeeping rather than content. Adding the id
 * to a task (which the engine does on opt-in) therefore doesn't mark it dirty.
 *
 * FNV-1a over the task's canonical serialization: no crypto dependency, and
 * the canonical form already normalizes field order and spacing, so two
 * equivalent lines hash the same.
 */
export function taskContentHash(parsed: ParsedTask): string {
	const canonical = serializeTask({ ...parsed, blockId: null });
	let hash = FNV_OFFSET_BASIS;
	for (let i = 0; i < canonical.length; i++) {
		hash ^= canonical.charCodeAt(i);
		hash = Math.imul(hash, FNV_PRIME);
	}
	return (hash >>> 0).toString(36);
}

/**
 * Which copy of a task wins when both sides changed since the last sync:
 * newest edit wins, comparing the file's mtime (epoch ms) against the event's
 * `updated` timestamp.
 *
 * A tie goes to the remote. A file mtime comes from the user's machine while
 * `updated` comes from Google's servers, and letting the local clock win a tie
 * would hand every close race to a machine whose clock runs fast.
 *
 * An unparseable remote timestamp means the two edits can't be ordered at all.
 * The local file wins by default there: overwriting the vault is the
 * destructive direction, since the local copy is the one a user would lose.
 */
export function resolveConflict(localMtimeMs: number, remoteUpdatedISO: string): "local" | "remote" {
	const remoteMs = Date.parse(remoteUpdatedISO);
	if (Number.isNaN(remoteMs)) {
		return "local";
	}
	return localMtimeMs > remoteMs ? "local" : "remote";
}

/**
 * Indexed read/write access to the mapping arrays. The arrays stay the source
 * of truth (they're what gets persisted); the maps are lookup indexes rebuilt
 * in lockstep with every mutation.
 */
export class MappingStore {
	private data: MappingStoreData;
	private save: () => Promise<void>;
	private byBlockId = new Map<string, TaskMapping>();
	private byEvent = new Map<string, TaskMapping>();

	constructor(data: MappingStoreData, save: () => Promise<void>) {
		this.data = data;
		this.save = save;
		this.reindex();
	}

	get(blockId: string): TaskMapping | null {
		return this.byBlockId.get(blockId) ?? null;
	}

	/**
	 * Looks up by remote event id. Event ids are unique within a calendar; a
	 * copy of an event in another calendar keeps its id, so a vault synced to
	 * two calendars could in principle collide here — vanishingly unlikely for
	 * events this plugin creates, and Task 7 can narrow by calendar if needed.
	 */
	byEventId(eventId: string): TaskMapping | null {
		return this.byEvent.get(eventId) ?? null;
	}

	all(): readonly TaskMapping[] {
		return this.data.syncMappings;
	}

	/** Inserts, or replaces the existing mapping for the same block id. */
	async upsert(mapping: TaskMapping): Promise<void> {
		const index = this.data.syncMappings.findIndex((m) => m.blockId === mapping.blockId);
		if (index === -1) {
			this.data.syncMappings.push(mapping);
		} else {
			this.data.syncMappings[index] = mapping;
		}
		this.reindex();
		await this.save();
	}

	async remove(blockId: string): Promise<void> {
		const index = this.data.syncMappings.findIndex((m) => m.blockId === blockId);
		if (index === -1) {
			return;
		}
		this.data.syncMappings.splice(index, 1);
		this.reindex();
		await this.save();
	}

	/**
	 * Follows a task to its new file. Called on a vault rename, and self-healed
	 * during a sync.
	 *
	 * Mutates the stored mapping in place. The lookup maps and the persisted
	 * array hold the same object, so one write updates every view of it — but
	 * callers must not *rely* on that: anything holding a mapping it fetched
	 * earlier should re-read it through `get` afterwards, so that replacing this
	 * implementation with a copy-on-write one can't silently hand callers a
	 * stale path.
	 */
	async updateFilePath(blockId: string, newPath: string): Promise<void> {
		const mapping = this.byBlockId.get(blockId);
		if (mapping === undefined || mapping.filePath === newPath) {
			return;
		}
		mapping.filePath = newPath;
		await this.save();
	}

	async addTombstone(tombstone: Tombstone): Promise<void> {
		this.data.syncTombstones.push(tombstone);
		await this.save();
	}

	/** Returns the pending tombstones and clears them in one step, so a consumer can't process the same one twice. */
	async takeTombstones(): Promise<Tombstone[]> {
		const taken = [...this.data.syncTombstones];
		this.data.syncTombstones.length = 0;
		await this.save();
		return taken;
	}

	private reindex(): void {
		this.byBlockId = new Map(this.data.syncMappings.map((m) => [m.blockId, m]));
		this.byEvent = new Map(this.data.syncMappings.map((m) => [m.eventId, m]));
	}
}
