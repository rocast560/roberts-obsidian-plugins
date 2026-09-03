/**
 * Index of Tasks-emoji-format checkbox lines — vault-wide by default, or a
 * single note when `taskSourcePath` is set.
 *
 * Built from `metadataCache.listItems` (never a whole-file regex scan) and
 * kept current via the `metadataCache` "changed" event with a per-file
 * debounce. No unit tests here (obsidian-coupled; the project's tests don't
 * mock obsidian) — the pure parsing logic this builds on is fully covered in
 * test/parser.test.ts.
 */

import type { App, CachedMetadata, TFile } from "obsidian";
import { isTaskCancelled, isTaskDone, parseTaskLine, serializeTask } from "./parser.ts";
import type { ParsedTask } from "./parser.ts";
import { rollover, shouldRollover } from "../reminders/recurrence.ts";
import { resolvedTaskSourcePath } from "../settings.ts";
import type { ReminderSuiteSettings } from "../settings.ts";

/** One indexed task line. Carries its own `parsed.blockId` so a later sync mapping can key off it (Task 6). */
export interface IndexedTask {
	filePath: string;
	line: number;
	parsed: ParsedTask;
}

export interface TaskBuckets {
	overdue: IndexedTask[];
	today: IndexedTask[];
	upcoming: IndexedTask[];
	someday: IndexedTask[];
}

type ChangeListener = () => void;

/** Per-file "changed" debounce, and the cross-file onChange coalescing window. */
const DEBOUNCE_MS = 500;
/** How far to search around a task's last-known line when it may have drifted before a writeback. */
const DRIFT_SEARCH_LINES = 10;

function todayISO(): string {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * Finds the line matching `expectedCanonical` (a task's own canonical
 * serialization), starting at `hintLine` and then searching outward up to
 * `DRIFT_SEARCH_LINES` lines in both directions. Returns `null` — never a
 * guess — when nothing matches, so a caller never writes to the wrong line.
 *
 * Exported for the sync engine, which does the same locate-then-rewrite dance
 * inside `vault.process` when stamping a block id onto a task.
 */
export function findTaskLine(lines: string[], hintLine: number, expectedCanonical: string): number | null {
	const matchesAt = (index: number): boolean => {
		const lineText = lines[index];
		if (lineText === undefined) {
			return false;
		}
		const parsed = parseTaskLine(lineText);
		return parsed !== null && serializeTask(parsed) === expectedCanonical;
	};
	if (matchesAt(hintLine)) {
		return hintLine;
	}
	for (let offset = 1; offset <= DRIFT_SEARCH_LINES; offset++) {
		if (matchesAt(hintLine - offset)) {
			return hintLine - offset;
		}
		if (matchesAt(hintLine + offset)) {
			return hintLine + offset;
		}
	}
	return null;
}

export class VaultTaskIndex {
	private app: App;
	private settings: ReminderSuiteSettings;
	private tasksByFile = new Map<string, IndexedTask[]>();
	private listeners = new Set<ChangeListener>();
	private fileDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private changeCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
	/** Lazily built blockId→task lookup for the sync engine; invalidated (set to null) by every index mutation. */
	private tasksByBlockId: Map<string, IndexedTask> | null = null;

	constructor(app: App, settings: ReminderSuiteSettings) {
		this.app = app;
		this.settings = settings;
	}

	/**
	 * Whether `path` is inside the configured task source: the single source
	 * note when `taskSourcePath` is set, any markdown file otherwise.
	 */
	private isSourceFile(path: string): boolean {
		const source = resolvedTaskSourcePath(this.settings);
		return source === "" || path === source;
	}

	/** Full scan of the task source. Replaces the entire index and fires `onChange` once, immediately. */
	async rebuild(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles().filter((file) => this.isSourceFile(file.path));
		const next = new Map<string, IndexedTask[]>();
		await Promise.all(
			files.map(async (file) => {
				const tasks = await this.readTasks(file);
				if (tasks.length > 0) {
					next.set(file.path, tasks);
				}
			}),
		);
		this.tasksByFile = next;
		this.tasksByBlockId = null;
		this.notifyChange();
	}

	/**
	 * Re-reads one file's tasks immediately, skipping the per-file debounce.
	 * The sidebar calls this after quick-add so a newly appended task shows up
	 * without waiting for the metadata cache round-trip.
	 */
	async refreshFile(file: TFile): Promise<void> {
		await this.setFileTasks(file);
		this.notifyChange();
	}

	/** Wire from `metadataCache.on("changed", ...)` in main.ts. Debounced per file path. */
	handleFileChanged(file: TFile, cache: CachedMetadata): void {
		if (!this.isSourceFile(file.path)) {
			return;
		}
		const existing = this.fileDebounceTimers.get(file.path);
		if (existing !== undefined) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.fileDebounceTimers.delete(file.path);
			void this.setFileTasks(file, cache).then(() => this.notifyChangeCoalesced());
		}, DEBOUNCE_MS);
		this.fileDebounceTimers.set(file.path, timer);
	}

	/** Wire from `vault.on("delete", ...)` in main.ts so a deleted file's tasks don't linger. */
	handleFileDeleted(filePath: string): void {
		if (this.tasksByFile.delete(filePath)) {
			this.tasksByBlockId = null;
			this.notifyChangeCoalesced();
		}
	}

	/** Wire from `vault.on("rename", ...)` in main.ts so a renamed file's tasks move with it. */
	handleFileRenamed(file: TFile, oldPath: string): void {
		this.tasksByFile.delete(oldPath);
		this.tasksByBlockId = null;
		void this.setFileTasks(file).then(() => this.notifyChangeCoalesced());
	}

	all(): IndexedTask[] {
		return [...this.tasksByFile.values()].flat();
	}

	/**
	 * The task carrying `^blockId`, or `null` if no indexed task has it. This
	 * is the sync engine's identity lookup: a mapping survives the task moving
	 * line or file, so nothing but the block id can be trusted to find it.
	 *
	 * `null` means "not in the index" — which is not the same as "deleted from
	 * the vault" (an unbuilt index or a `taskFilterTag`/`taskSourcePath` change
	 * also produce it), so callers acting destructively on the answer must
	 * confirm separately.
	 */
	byBlockId(id: string): IndexedTask | null {
		if (this.tasksByBlockId === null) {
			const map = new Map<string, IndexedTask>();
			for (const task of this.all()) {
				if (task.parsed.blockId !== null) {
					map.set(task.parsed.blockId, task);
				}
			}
			this.tasksByBlockId = map;
		}
		return this.tasksByBlockId.get(id) ?? null;
	}

	/**
	 * Buckets every non-done, non-cancelled task by its due date (falling back
	 * to scheduled when due is absent). `someday` holds tasks with neither.
	 * `overdue`/`upcoming` are sorted ascending by that date.
	 */
	byBucket(): TaskBuckets {
		const today = todayISO();
		const buckets: TaskBuckets = { overdue: [], today: [], upcoming: [], someday: [] };

		for (const task of this.all()) {
			if (isTaskDone(task.parsed) || isTaskCancelled(task.parsed)) {
				continue;
			}
			const date = task.parsed.due ?? task.parsed.scheduled;
			if (date === null) {
				buckets.someday.push(task);
			} else if (date < today) {
				buckets.overdue.push(task);
			} else if (date === today) {
				buckets.today.push(task);
			} else {
				buckets.upcoming.push(task);
			}
		}

		const byDate = (a: IndexedTask, b: IndexedTask): number => {
			const dateA = a.parsed.due ?? a.parsed.scheduled ?? "";
			const dateB = b.parsed.due ?? b.parsed.scheduled ?? "";
			return dateA.localeCompare(dateB);
		};
		buckets.overdue.sort(byDate);
		buckets.upcoming.sort(byDate);

		return buckets;
	}

	/** Subscribes to change notifications; returns an unsubscribe function. Coalesced to at most once per `DEBOUNCE_MS`. */
	onChange(cb: ChangeListener): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	/**
	 * Atomic writeback of a task's checked state via `vault.process`.
	 * Re-locates the line by its canonical serialized form — `task.line`
	 * first, then a ±`DRIFT_SEARCH_LINES` search — so a file edited since the
	 * last index update never gets the wrong line overwritten; throws instead
	 * of guessing. Sets/clears `✅ YYYY-MM-DD` on complete/un-complete.
	 *
	 * Completing (`checked: true`) a task that carries a 🔁 recurrence rolls
	 * it over (see `shouldRollover`): the line becomes the completed task, and
	 * a fresh next occurrence is inserted directly above it (the Tasks-plugin
	 * convention — the newest occurrence sits on top). `task` is updated to
	 * track the completed line, as before; the inserted line is picked up by
	 * the metadata-cache listener like any other external edit, the same way
	 * a second task typed by hand would be. Un-checking never retracts an
	 * already-inserted next occurrence; re-completing an already-done task or
	 * completing a cancelled one never rolls over — rollover only fires on the
	 * transition from open into done.
	 */
	async setTaskChecked(task: IndexedTask, checked: boolean): Promise<void> {
		const file = this.app.vault.getFileByPath(task.filePath);
		if (file === null) {
			throw new Error(`ReminderSuite: file not found for task: ${task.filePath}`);
		}
		const expectedCanonical = serializeTask(task.parsed);
		let updatedParsed: ParsedTask | null = null;
		let updatedLine: number | null = null;

		await this.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			const targetLine = findTaskLine(lines, task.line, expectedCanonical);
			if (targetLine === null) {
				throw new Error(
					`ReminderSuite: could not find task to update (file changed): ${task.filePath}:${task.line}`,
				);
			}
			const rawLine = lines[targetLine];
			const hadCR = rawLine.endsWith("\r");
			const parsed = parseTaskLine(rawLine);
			if (parsed === null) {
				throw new Error(`ReminderSuite: line ${targetLine} in ${task.filePath} is no longer a task`);
			}

			if (shouldRollover(parsed, checked)) {
				const rolled = rollover(parsed, todayISO());
				if (rolled !== null) {
					const nextLine = serializeTask(rolled.next) + (hadCR ? "\r" : "");
					const completedLine = serializeTask(rolled.completed) + (hadCR ? "\r" : "");
					lines.splice(targetLine, 1, nextLine, completedLine);
					updatedParsed = rolled.completed;
					updatedLine = targetLine + 1;
					return lines.join("\n");
				}
			}

			const next: ParsedTask = {
				...parsed,
				checked: checked ? "x" : " ",
				done: checked ? todayISO() : null,
			};
			lines[targetLine] = serializeTask(next) + (hadCR ? "\r" : "");
			updatedParsed = next;
			updatedLine = targetLine;
			return lines.join("\n");
		});

		if (updatedParsed !== null && updatedLine !== null) {
			task.parsed = updatedParsed;
			task.line = updatedLine;
		}
		this.notifyChange();
	}

	/** Reads listItems + line text for one file, filtered by `taskFilterTag` if set. Never throws — logs and returns []. */
	private async readTasks(file: TFile, cache?: CachedMetadata | null): Promise<IndexedTask[]> {
		const meta = cache ?? this.app.metadataCache.getFileCache(file);
		const listItems = meta?.listItems?.filter((item) => item.task !== undefined) ?? [];
		if (listItems.length === 0) {
			return [];
		}

		let content: string;
		try {
			content = await this.app.vault.cachedRead(file);
		} catch (error) {
			console.warn(`ReminderSuite: failed to read ${file.path} while indexing tasks`, error);
			return [];
		}
		const lines = content.split("\n");
		const filterTag = this.settings.taskFilterTag;

		const tasks: IndexedTask[] = [];
		for (const item of listItems) {
			const lineNo = item.position.start.line;
			const lineText = lines[lineNo];
			if (lineText === undefined) {
				continue;
			}
			if (filterTag !== "" && !lineText.includes(filterTag)) {
				continue;
			}
			const parsed = parseTaskLine(lineText);
			if (parsed === null) {
				continue;
			}
			tasks.push({ filePath: file.path, line: lineNo, parsed });
		}
		return tasks;
	}

	private async setFileTasks(file: TFile, cache?: CachedMetadata | null): Promise<void> {
		// Rename and refresh paths land here too, so the source check can't
		// live only in the event handlers.
		const tasks = this.isSourceFile(file.path) ? await this.readTasks(file, cache) : [];
		if (tasks.length > 0) {
			this.tasksByFile.set(file.path, tasks);
		} else {
			this.tasksByFile.delete(file.path);
		}
		this.tasksByBlockId = null;
	}

	private notifyChangeCoalesced(): void {
		if (this.changeCoalesceTimer !== null) {
			return;
		}
		this.changeCoalesceTimer = setTimeout(() => {
			this.changeCoalesceTimer = null;
			this.notifyChange();
		}, DEBOUNCE_MS);
	}

	private notifyChange(): void {
		for (const cb of this.listeners) {
			cb();
		}
	}
}
