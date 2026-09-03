/**
 * Parses and serializes single markdown checkbox lines in the
 * Tasks-plugin emoji format (https://publish.obsidian.md/tasks), plus the
 * Reminder-plugin extension (⏰ date-time).
 *
 * Pure module: no `obsidian` import. This is the single most reused module
 * in the plugin — the sync engine (Task 6) and reminders (Task 8) both build
 * on `ParsedTask`/`parseTaskLine`/`serializeTask`, so its field names and
 * round-trip stability are load-bearing.
 */

/** Absent priority is "normal", which serializes to no emoji at all. */
export type TaskPriority = "highest" | "high" | "medium" | "low" | "lowest" | "normal";

export interface TaskReminder {
	/** YYYY-MM-DD */
	date: string;
	/** HH:mm, 24h */
	time: string;
}

/**
 * One parsed checkbox line. Every field is always present — never
 * `undefined` — so `parseTaskLine(serializeTask(t))` can be compared to `t`
 * with `assert.deepStrictEqual`: a missing key and a key explicitly set to
 * `undefined` are NOT the same thing under Node's deep-equal, so optional
 * metadata uses `null` rather than `?:` to keep parse output and hand-built
 * test fixtures structurally identical.
 */
export interface ParsedTask {
	/** Leading whitespace before the list marker. */
	indent: string;
	/** "-" | "*" | "+" */
	listMarker: string;
	/** Raw character between `[` and `]`. 'x'/'X' is done, ' ' is open; anything else ("-", "/", …) is preserved as-is. */
	checked: string;
	/** Everything that isn't recognized trailing metadata. Unknown emoji/junk stays here — never dropped. */
	description: string;
	priority: TaskPriority;
	/** Raw text after "🔁 ", e.g. "every week", "every month when done". Interpretation is Task 8's job. */
	recurrence: string | null;
	/** ⏰ — the Reminder-plugin extension. */
	reminder: TaskReminder | null;
	/** 🛫 YYYY-MM-DD */
	start: string | null;
	/** ⏳ YYYY-MM-DD */
	scheduled: string | null;
	/** 📅 YYYY-MM-DD */
	due: string | null;
	/** ➕ YYYY-MM-DD */
	created: string | null;
	/** ✅ YYYY-MM-DD */
	done: string | null;
	/** ❌ YYYY-MM-DD */
	cancelled: string | null;
	/** Text after `^` at the very end of the line, without the caret. */
	blockId: string | null;
}

const CHECKBOX_LINE = /^(\s*)([-*+]) \[(.)\] (.*)$/u;

const BLOCK_ID = /\^([A-Za-z0-9-]+)$/u;
const REMINDER = /⏰\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/u;
const DATE_TOKEN = /([📅⏳🛫➕✅❌])\s*(\d{4}-\d{2}-\d{2})/gu;
const RECURRENCE = /🔁\s*(every[^📅⏳🛫➕✅❌⏰🔺⏫🔼🔽⏬]*)/u;
const PRIORITY_TOKEN = /[🔺⏫🔼🔽⏬]/u;

type DateField = "due" | "scheduled" | "start" | "created" | "done" | "cancelled";

const DATE_FIELD_BY_EMOJI: Record<string, DateField> = {
	"📅": "due",
	"⏳": "scheduled",
	"🛫": "start",
	"➕": "created",
	"✅": "done",
	"❌": "cancelled",
};

const PRIORITY_BY_EMOJI: Record<string, TaskPriority> = {
	"🔺": "highest",
	"⏫": "high",
	"🔼": "medium",
	"🔽": "low",
	"⏬": "lowest",
};

const PRIORITY_EMOJI: Record<Exclude<TaskPriority, "normal">, string> = {
	highest: "🔺",
	high: "⏫",
	medium: "🔼",
	low: "🔽",
	lowest: "⏬",
};

/** Emoji shown before a task's description in UI; "" for normal priority. */
export function priorityEmoji(priority: TaskPriority): string {
	return priority === "normal" ? "" : PRIORITY_EMOJI[priority];
}

/** 'x' or 'X' — the Tasks-plugin convention for a completed task. */
export function isTaskDone(task: ParsedTask): boolean {
	return task.checked === "x" || task.checked === "X";
}

/** '-' — the Tasks-plugin convention for a cancelled task. */
export function isTaskCancelled(task: ParsedTask): boolean {
	return task.checked === "-";
}

/**
 * Parses one line. Returns `null` unless the line matches
 * `^\s*[-*+] \[(.)\] ` — headers, plain bullets, and other non-checkbox text
 * all return `null`. Tolerates a trailing `\r` (CRLF files).
 */
export function parseTaskLine(rawLine: string): ParsedTask | null {
	const line = rawLine.replace(/\r$/u, "");
	const match = CHECKBOX_LINE.exec(line);
	if (match === null) {
		return null;
	}
	const [, indent, listMarker, checked, rest] = match;

	let text = rest;
	let blockId: string | null = null;
	let reminder: TaskReminder | null = null;
	let start: string | null = null;
	let scheduled: string | null = null;
	let due: string | null = null;
	let created: string | null = null;
	let done: string | null = null;
	let cancelled: string | null = null;
	let recurrence: string | null = null;
	let priority: TaskPriority = "normal";

	// Block ID is anchored at the very end, so it's extracted first — nothing
	// downstream needs to worry about a "^" showing up mid-line.
	const blockIdMatch = BLOCK_ID.exec(text);
	if (blockIdMatch !== null) {
		blockId = blockIdMatch[1];
		text = text.slice(0, blockIdMatch.index).trimEnd();
	}

	text = text.replace(REMINDER, (_all, date: string, time: string) => {
		reminder = { date, time };
		return "";
	});

	text = text.replace(DATE_TOKEN, (_all, emoji: string, date: string) => {
		const field = DATE_FIELD_BY_EMOJI[emoji];
		switch (field) {
			case "due":
				due = date;
				break;
			case "scheduled":
				scheduled = date;
				break;
			case "start":
				start = date;
				break;
			case "created":
				created = date;
				break;
			case "done":
				done = date;
				break;
			case "cancelled":
				cancelled = date;
				break;
		}
		return "";
	});

	text = text.replace(RECURRENCE, (_all, rec: string) => {
		recurrence = rec.trim();
		return "";
	});

	text = text.replace(PRIORITY_TOKEN, (emoji: string) => {
		priority = PRIORITY_BY_EMOJI[emoji];
		return "";
	});

	const description = text.replace(/\s+/gu, " ").trim();

	return {
		indent,
		listMarker,
		checked,
		description,
		priority,
		recurrence,
		reminder,
		start,
		scheduled,
		due,
		created,
		done,
		cancelled,
		blockId,
	};
}

/** Serializes a `ParsedTask` back to a checkbox line in canonical field order. */
export function serializeTask(t: ParsedTask): string {
	const parts: string[] = [];
	if (t.description !== "") {
		parts.push(t.description);
	}
	if (t.priority !== "normal") {
		parts.push(PRIORITY_EMOJI[t.priority]);
	}
	if (t.recurrence !== null) {
		parts.push(`🔁 ${t.recurrence}`);
	}
	if (t.reminder !== null) {
		parts.push(`⏰ ${t.reminder.date} ${t.reminder.time}`);
	}
	if (t.start !== null) {
		parts.push(`🛫 ${t.start}`);
	}
	if (t.scheduled !== null) {
		parts.push(`⏳ ${t.scheduled}`);
	}
	if (t.due !== null) {
		parts.push(`📅 ${t.due}`);
	}
	if (t.created !== null) {
		parts.push(`➕ ${t.created}`);
	}
	if (t.done !== null) {
		parts.push(`✅ ${t.done}`);
	}
	if (t.cancelled !== null) {
		parts.push(`❌ ${t.cancelled}`);
	}
	if (t.blockId !== null) {
		parts.push(`^${t.blockId}`);
	}
	return `${t.indent}${t.listMarker} [${t.checked}] ${parts.join(" ")}`;
}
