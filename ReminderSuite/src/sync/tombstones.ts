/**
 * Draining the tombstone queue: the deletions this plugin recorded locally but
 * never got to confirm with Google.
 *
 * Lives apart from the engine because the interesting behaviour is what happens
 * when the drain *stops* early, and that needs a test. The queue is taken from
 * the store in one step, so while a drain is running this array is the only
 * copy of those deletions — anything the drain doesn't settle has to go back
 * before the error leaves, or the event lingers in Google forever.
 *
 * Pure module: no `obsidian` import.
 */

import type { Tombstone } from "./mappings.ts";

/** What became of one tombstone, for the sync log. */
export type TombstoneOutcome = "deleted" | "dropped" | "requeued";

export interface TombstoneDrainDeps {
	/** Deletes the remote event. A 404/410 already counts as success inside the client: gone is gone. */
	deleteEvent: (tombstone: Tombstone) => Promise<void>;
	/** Puts a tombstone back in the store for a later cycle. */
	requeue: (tombstone: Tombstone) => Promise<void>;
	/** A failure no retry can fix, so its tombstone is dropped rather than re-queued forever. */
	isUnrecoverable: (error: unknown) => boolean;
	/** A failure that ends the whole drain rather than just this one deletion (re-auth). */
	isAborting: (error: unknown) => boolean;
	/** Records one tombstone's fate. Must not throw. */
	record: (outcome: TombstoneOutcome, tombstone: Tombstone, error?: unknown) => void;
}

/**
 * Works through `tombstones` in order, settling each one. Returns when every
 * tombstone has been deleted, dropped, or re-queued.
 *
 * If anything ends the pass early — a re-auth demand, or a store write that
 * failed — the entire untried remainder is re-queued before the error is
 * rethrown, including the tombstone that failed.
 */
export async function drainTombstoneQueue(
	tombstones: readonly Tombstone[],
	deps: TombstoneDrainDeps,
): Promise<void> {
	for (let index = 0; index < tombstones.length; index++) {
		try {
			await settleTombstone(tombstones[index], deps);
		} catch (error) {
			await requeueRemainder(tombstones.slice(index), deps);
			throw error;
		}
	}
}

/**
 * Puts back everything a cut-short pass never settled. Best-effort per
 * tombstone: a store write that fails costs that one tombstone rather than
 * stranding every tombstone behind it, which is the whole point of this pass.
 */
async function requeueRemainder(
	remainder: readonly Tombstone[],
	deps: TombstoneDrainDeps,
): Promise<void> {
	for (const tombstone of remainder) {
		try {
			await deps.requeue(tombstone);
		} catch (error) {
			// Nowhere left to put it: the deletion is lost, and saying so beats
			// letting one bad write take the rest of the queue down with it.
			deps.record("dropped", tombstone, error);
		}
	}
}

/**
 * One tombstone's fate. Throws only for a failure that should end the whole
 * drain — and re-queues nothing in that case, leaving it to the caller, which
 * has to re-queue the rest of the queue anyway.
 */
async function settleTombstone(tombstone: Tombstone, deps: TombstoneDrainDeps): Promise<void> {
	try {
		await deps.deleteEvent(tombstone);
	} catch (error) {
		if (deps.isUnrecoverable(error)) {
			deps.record("dropped", tombstone, error);
			return;
		}
		if (deps.isAborting(error)) {
			throw error;
		}
		await deps.requeue(tombstone);
		deps.record("requeued", tombstone, error);
		return;
	}
	deps.record("deleted", tombstone);
}
