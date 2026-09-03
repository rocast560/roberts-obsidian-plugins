import assert from "node:assert/strict";
import { test } from "node:test";
import { PLUGIN_ID } from "../src/lib/version.ts";

test("PLUGIN_ID matches manifest id", () => {
	assert.strictEqual(PLUGIN_ID, "reminder-suite");
});
