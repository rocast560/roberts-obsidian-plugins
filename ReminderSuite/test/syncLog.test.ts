import assert from "node:assert/strict";
import { test } from "node:test";
import { SYNC_LOG_LIMIT, SyncLog, formatSyncLog } from "../src/sync/syncLog.ts";

test("entries come back oldest first", () => {
	const log = new SyncLog();
	log.add("push", "rs-aaa");
	log.add("conflict", "rs-bbb");
	assert.deepStrictEqual(
		log.all().map((entry) => entry.action),
		["push", "conflict"],
	);
});

test("the ring buffer keeps exactly the newest entries once it overflows", () => {
	const log = new SyncLog();
	for (let i = 0; i < SYNC_LOG_LIMIT + 10; i++) {
		log.add("push", `rs-${i}`);
	}
	const ids = log.all().map((entry) => entry.id);
	assert.strictEqual(ids.length, SYNC_LOG_LIMIT);
	assert.strictEqual(ids[0], "rs-10");
	assert.strictEqual(ids[ids.length - 1], `rs-${SYNC_LOG_LIMIT + 9}`);
});

test("the buffer holds its full limit before dropping anything", () => {
	const log = new SyncLog();
	for (let i = 0; i < SYNC_LOG_LIMIT; i++) {
		log.add("push", `rs-${i}`);
	}
	assert.strictEqual(log.all().length, SYNC_LOG_LIMIT);
	assert.strictEqual(log.all()[0].id, "rs-0");
});

test("an empty detail is left off the entry rather than stored blank", () => {
	const log = new SyncLog();
	log.add("push", "rs-aaa", "");
	assert.strictEqual(log.all()[0].detail, undefined);
});

test("formatting lines up the columns and keeps one line per entry", () => {
	const lines = formatSyncLog([
		{ timestamp: "2026-08-15T10:00:00.000Z", action: "conflict", id: "rs-abc123", detail: "remote won" },
		{ timestamp: "2026-08-15T10:00:01.000Z", action: "push", id: "rs-abc123" },
	]).split("\n");
	assert.strictEqual(lines.length, 2);
	assert.match(lines[0], /conflict\s+rs-abc123\s+remote won$/u);
	// No detail means no trailing padding left dangling.
	assert.match(lines[1], /push\s+rs-abc123$/u);
});

test("formatting an empty log is an empty string", () => {
	assert.strictEqual(formatSyncLog([]), "");
});
