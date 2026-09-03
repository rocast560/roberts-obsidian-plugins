import assert from "node:assert/strict";
import { test } from "node:test";
import { MappingStore, resolveConflict, taskContentHash } from "../src/sync/mappings.ts";
import type { MappingStoreData, TaskMapping } from "../src/sync/mappings.ts";
import type { ParsedTask } from "../src/tasks/parser.ts";

function task(overrides: Partial<ParsedTask> = {}): ParsedTask {
	return {
		indent: "",
		listMarker: "-",
		checked: " ",
		description: "Write the report",
		priority: "normal",
		recurrence: null,
		reminder: null,
		start: null,
		scheduled: null,
		due: "2026-08-20",
		created: null,
		done: null,
		cancelled: null,
		blockId: null,
		...overrides,
	};
}

function mapping(overrides: Partial<TaskMapping> = {}): TaskMapping {
	return {
		blockId: "rs-abc123",
		filePath: "Inbox.md",
		calendarId: "cal1",
		eventId: "evt1",
		etag: "\"etag-1\"",
		lastSyncedHash: "hash-1",
		...overrides,
	};
}

function emptyData(): MappingStoreData {
	return { syncMappings: [], syncTombstones: [] };
}

// ---- taskContentHash ---------------------------------------------------

test("taskContentHash is stable across calls for the same task", () => {
	assert.strictEqual(taskContentHash(task()), taskContentHash(task()));
});

test("taskContentHash ignores the block id", () => {
	assert.strictEqual(
		taskContentHash(task({ blockId: "rs-aaaaaa" })),
		taskContentHash(task({ blockId: "rs-zzzzzz" })),
	);
	assert.strictEqual(taskContentHash(task({ blockId: null })), taskContentHash(task({ blockId: "rs-aaaaaa" })));
});

test("taskContentHash changes when the description changes", () => {
	assert.notStrictEqual(taskContentHash(task()), taskContentHash(task({ description: "Something else" })));
});

test("taskContentHash changes when the due date changes", () => {
	assert.notStrictEqual(taskContentHash(task()), taskContentHash(task({ due: "2026-08-21" })));
});

test("taskContentHash changes when the reminder changes", () => {
	assert.notStrictEqual(
		taskContentHash(task({ reminder: { date: "2026-08-20", time: "09:00" } })),
		taskContentHash(task({ reminder: { date: "2026-08-20", time: "10:00" } })),
	);
});

test("taskContentHash changes when the task is completed", () => {
	assert.notStrictEqual(
		taskContentHash(task()),
		taskContentHash(task({ checked: "x", done: "2026-08-21" })),
	);
});

test("taskContentHash returns a short non-empty string", () => {
	const hash = taskContentHash(task());
	assert.strictEqual(typeof hash, "string");
	assert.ok(hash.length > 0 && hash.length <= 16, `unexpected hash length: ${hash}`);
});

// ---- MappingStore ------------------------------------------------------

test("upsert then get round-trips a mapping", async () => {
	const data = emptyData();
	const store = new MappingStore(data, async () => {});
	await store.upsert(mapping());

	assert.deepStrictEqual(store.get("rs-abc123"), mapping());
	assert.deepStrictEqual(data.syncMappings, [mapping()]);
});

test("get returns null for an unknown block id", () => {
	const store = new MappingStore(emptyData(), async () => {});
	assert.strictEqual(store.get("rs-nope00"), null);
});

test("upsert replaces an existing mapping instead of duplicating it", async () => {
	const data = emptyData();
	const store = new MappingStore(data, async () => {});
	await store.upsert(mapping());
	await store.upsert(mapping({ etag: "\"etag-2\"", lastSyncedHash: "hash-2" }));

	assert.strictEqual(data.syncMappings.length, 1);
	assert.strictEqual(store.get("rs-abc123")?.etag, "\"etag-2\"");
	assert.strictEqual(store.get("rs-abc123")?.lastSyncedHash, "hash-2");
});

test("remove drops the mapping from lookups and from the persisted array", async () => {
	const data = emptyData();
	const store = new MappingStore(data, async () => {});
	await store.upsert(mapping());
	await store.remove("rs-abc123");

	assert.strictEqual(store.get("rs-abc123"), null);
	assert.strictEqual(store.byEventId("evt1"), null);
	assert.deepStrictEqual(data.syncMappings, []);
});

test("remove of an unknown block id is a no-op", async () => {
	const data = emptyData();
	const store = new MappingStore(data, async () => {});
	await store.upsert(mapping());
	await store.remove("rs-nope00");
	assert.strictEqual(data.syncMappings.length, 1);
});

test("byEventId finds a mapping by its remote event id", async () => {
	const store = new MappingStore(emptyData(), async () => {});
	await store.upsert(mapping());
	assert.strictEqual(store.byEventId("evt1")?.blockId, "rs-abc123");
	assert.strictEqual(store.byEventId("other"), null);
});

test("all() lists every mapping", async () => {
	const store = new MappingStore(emptyData(), async () => {});
	await store.upsert(mapping());
	await store.upsert(mapping({ blockId: "rs-def456", eventId: "evt2" }));
	assert.deepStrictEqual(
		store.all().map((m) => m.blockId),
		["rs-abc123", "rs-def456"],
	);
});

test("a store built over existing data indexes it without an upsert", () => {
	const data: MappingStoreData = { syncMappings: [mapping()], syncTombstones: [] };
	const store = new MappingStore(data, async () => {});
	assert.strictEqual(store.get("rs-abc123")?.eventId, "evt1");
	assert.strictEqual(store.byEventId("evt1")?.blockId, "rs-abc123");
});

test("updateFilePath moves a mapping to its new file", async () => {
	const data = emptyData();
	const store = new MappingStore(data, async () => {});
	await store.upsert(mapping());
	await store.updateFilePath("rs-abc123", "Notes/Inbox.md");

	assert.strictEqual(store.get("rs-abc123")?.filePath, "Notes/Inbox.md");
	assert.strictEqual(data.syncMappings[0].filePath, "Notes/Inbox.md");
});

test("updateFilePath on an unknown block id is a no-op", async () => {
	const store = new MappingStore(emptyData(), async () => {});
	await store.updateFilePath("rs-nope00", "Elsewhere.md");
	assert.strictEqual(store.get("rs-nope00"), null);
});

test("tombstones accumulate and takeTombstones drains them", async () => {
	const data = emptyData();
	const store = new MappingStore(data, async () => {});
	await store.addTombstone({ calendarId: "cal1", eventId: "evt1", etag: "\"e\"", deletedAt: "2026-08-15T10:00:00.000Z" });
	await store.addTombstone({ calendarId: "cal1", eventId: "evt2", deletedAt: "2026-08-15T10:01:00.000Z" });

	assert.strictEqual(data.syncTombstones.length, 2);
	const taken = await store.takeTombstones();
	assert.deepStrictEqual(
		taken.map((t) => t.eventId),
		["evt1", "evt2"],
	);
	assert.deepStrictEqual(data.syncTombstones, []);
	assert.deepStrictEqual(await store.takeTombstones(), []);
});

test("every mutation persists through the injected save", async () => {
	let saves = 0;
	const store = new MappingStore(emptyData(), async () => {
		saves++;
	});
	await store.upsert(mapping());
	await store.updateFilePath("rs-abc123", "Other.md");
	await store.addTombstone({ calendarId: "cal1", eventId: "evt1", deletedAt: "2026-08-15T10:00:00.000Z" });
	await store.takeTombstones();
	await store.remove("rs-abc123");
	assert.strictEqual(saves, 5);
});

// ---- resolveConflict ---------------------------------------------------

const REMOTE_UPDATED = "2026-08-15T10:00:00.000Z";
const REMOTE_UPDATED_MS = Date.parse(REMOTE_UPDATED);

test("the side edited most recently wins a two-sided edit", () => {
	assert.strictEqual(resolveConflict(REMOTE_UPDATED_MS + 1000, REMOTE_UPDATED), "local");
	assert.strictEqual(resolveConflict(REMOTE_UPDATED_MS - 1000, REMOTE_UPDATED), "remote");
});

test("an exact tie goes to the remote, whose clock is the authoritative one", () => {
	// A file mtime comes from the user's machine; `updated` comes from Google's
	// servers. On a tie, trusting the local clock would let a skewed machine win
	// every race it should have lost.
	assert.strictEqual(resolveConflict(REMOTE_UPDATED_MS, REMOTE_UPDATED), "remote");
});

test("an unparseable remote timestamp leaves the local copy in place", () => {
	// The two edits can't be ordered at all, and overwriting the vault is the
	// destructive direction — the local file is the copy a user would lose.
	assert.strictEqual(resolveConflict(REMOTE_UPDATED_MS, "not a timestamp"), "local");
	assert.strictEqual(resolveConflict(REMOTE_UPDATED_MS, ""), "local");
});

test("sub-second differences still decide a conflict", () => {
	assert.strictEqual(resolveConflict(Date.parse("2026-08-15T10:00:00.500Z"), REMOTE_UPDATED), "local");
});
