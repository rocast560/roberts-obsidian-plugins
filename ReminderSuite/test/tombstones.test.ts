import assert from "node:assert/strict";
import { test } from "node:test";
import { drainTombstoneQueue } from "../src/sync/tombstones.ts";
import type { TombstoneDrainDeps, TombstoneOutcome } from "../src/sync/tombstones.ts";
import type { Tombstone } from "../src/sync/mappings.ts";

class ReauthRequired extends Error {}
class Unrecoverable extends Error {}
class Transient extends Error {}

function tombstone(n: number): Tombstone {
	return { calendarId: "cal1", eventId: `evt-${n}`, etag: `"etag-${n}"`, deletedAt: "2026-08-16T09:00:00.000Z" };
}

/**
 * A drain harness whose store is a plain array: `requeued` is what the engine's
 * `addTombstone` would have written back, in call order.
 */
function harness(deleteEvent: (t: Tombstone) => Promise<void>): {
	deps: TombstoneDrainDeps;
	requeued: string[];
	recorded: Array<[TombstoneOutcome, string]>;
	deleted: string[];
} {
	const requeued: string[] = [];
	const recorded: Array<[TombstoneOutcome, string]> = [];
	const deleted: string[] = [];
	const deps: TombstoneDrainDeps = {
		deleteEvent: async (t) => {
			await deleteEvent(t);
			deleted.push(t.eventId);
		},
		requeue: async (t) => {
			requeued.push(t.eventId);
		},
		isUnrecoverable: (error) => error instanceof Unrecoverable,
		isAborting: (error) => error instanceof ReauthRequired,
		record: (outcome, t) => {
			recorded.push([outcome, t.eventId]);
		},
	};
	return { deps, requeued, recorded, deleted };
}

test("a clean drain deletes every tombstone and re-queues none", async () => {
	const h = harness(async () => {});
	await drainTombstoneQueue([tombstone(0), tombstone(1), tombstone(2)], h.deps);
	assert.deepStrictEqual(h.deleted, ["evt-0", "evt-1", "evt-2"]);
	assert.deepStrictEqual(h.requeued, []);
	assert.deepStrictEqual(h.recorded, [
		["deleted", "evt-0"],
		["deleted", "evt-1"],
		["deleted", "evt-2"],
	]);
});

test("an aborting error at index 1 puts the failing tombstone and the whole untried remainder back", async () => {
	const queue = [tombstone(0), tombstone(1), tombstone(2), tombstone(3)];
	const h = harness(async (t) => {
		if (t.eventId === "evt-1") {
			throw new ReauthRequired("sign in again");
		}
	});

	await assert.rejects(drainTombstoneQueue(queue, h.deps), ReauthRequired);

	// takeTombstones emptied the store, so anything not settled here is lost
	// forever unless it goes back: 1 is the failure, 2 and 3 were never tried.
	assert.deepStrictEqual(h.requeued, ["evt-1", "evt-2", "evt-3"]);
	assert.deepStrictEqual(h.deleted, ["evt-0"]);
	assert.deepStrictEqual(h.recorded, [["deleted", "evt-0"]]);
});

test("an aborting error on the first tombstone puts the entire queue back", async () => {
	const h = harness(async () => {
		throw new ReauthRequired("sign in again");
	});
	await assert.rejects(drainTombstoneQueue([tombstone(0), tombstone(1)], h.deps), ReauthRequired);
	assert.deepStrictEqual(h.requeued, ["evt-0", "evt-1"]);
});

test("an aborting error on the last tombstone puts only that one back", async () => {
	const h = harness(async (t) => {
		if (t.eventId === "evt-2") {
			throw new ReauthRequired("sign in again");
		}
	});
	await assert.rejects(drainTombstoneQueue([tombstone(0), tombstone(1), tombstone(2)], h.deps), ReauthRequired);
	assert.deepStrictEqual(h.requeued, ["evt-2"]);
	assert.deepStrictEqual(h.deleted, ["evt-0", "evt-1"]);
});

test("a transient failure re-queues just its own tombstone and the drain carries on", async () => {
	const h = harness(async (t) => {
		if (t.eventId === "evt-1") {
			throw new Transient("network hiccup");
		}
	});
	await drainTombstoneQueue([tombstone(0), tombstone(1), tombstone(2)], h.deps);
	assert.deepStrictEqual(h.requeued, ["evt-1"]);
	assert.deepStrictEqual(h.deleted, ["evt-0", "evt-2"]);
	assert.deepStrictEqual(h.recorded, [
		["deleted", "evt-0"],
		["requeued", "evt-1"],
		["deleted", "evt-2"],
	]);
});

test("an unrecoverable failure drops its tombstone rather than re-queueing it forever", async () => {
	const h = harness(async (t) => {
		if (t.eventId === "evt-0") {
			throw new Unrecoverable("412 precondition failed");
		}
	});
	await drainTombstoneQueue([tombstone(0), tombstone(1)], h.deps);
	assert.deepStrictEqual(h.requeued, []);
	assert.deepStrictEqual(h.recorded, [
		["dropped", "evt-0"],
		["deleted", "evt-1"],
	]);
});

test("an unrecoverable error is dropped even when it would also count as aborting", async () => {
	// isUnrecoverable is consulted first: a 4xx no retry can fix must not stall
	// the whole queue behind a re-auth that wouldn't fix it either.
	const h = harness(async () => {
		throw new Unrecoverable("403 on a calendar we lost");
	});
	const deps: TombstoneDrainDeps = { ...h.deps, isAborting: () => true };
	await drainTombstoneQueue([tombstone(0), tombstone(1)], deps);
	assert.deepStrictEqual(h.requeued, []);
	assert.deepStrictEqual(h.recorded, [
		["dropped", "evt-0"],
		["dropped", "evt-1"],
	]);
});

test("an empty queue is a no-op", async () => {
	const h = harness(async () => {
		throw new Error("should never be called");
	});
	await drainTombstoneQueue([], h.deps);
	assert.deepStrictEqual(h.requeued, []);
	assert.deepStrictEqual(h.recorded, []);
});

test("a store write that fails costs its own tombstone, not the untried remainder", async () => {
	// Re-queueing is a store write and can fail too. When it does, the rest of
	// the queue must still get put back rather than going down with it.
	const requeued: string[] = [];
	const recorded: Array<[TombstoneOutcome, string]> = [];
	const deps: TombstoneDrainDeps = {
		deleteEvent: async (t) => {
			if (t.eventId === "evt-1") {
				throw new Transient("network hiccup");
			}
		},
		requeue: async (t) => {
			if (t.eventId === "evt-1") {
				throw new Error("disk full");
			}
			requeued.push(t.eventId);
		},
		isUnrecoverable: () => false,
		isAborting: () => false,
		record: (outcome, t) => {
			recorded.push([outcome, t.eventId]);
		},
	};

	await assert.rejects(drainTombstoneQueue([tombstone(0), tombstone(1), tombstone(2)], deps), /disk full/u);
	assert.deepStrictEqual(requeued, ["evt-2"]);
	assert.deepStrictEqual(recorded, [
		["deleted", "evt-0"],
		["dropped", "evt-1"],
	]);
});
