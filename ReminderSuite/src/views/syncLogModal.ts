/**
 * The "Show sync log" command's window: this session's sync activity as plain
 * fixed-width text. Deliberately unstyled and uninteractive — it exists to
 * answer "what did sync just do to my task?", and anything more would be a
 * second UI to keep in step with the engine.
 */

import { Modal } from "obsidian";
import type { App } from "obsidian";
import { formatSyncLog } from "../sync/syncLog.ts";
import type { SyncLogEntry } from "../sync/syncLog.ts";

export class SyncLogModal extends Modal {
	private entries: readonly SyncLogEntry[];

	constructor(app: App, entries: readonly SyncLogEntry[]) {
		super(app);
		this.entries = entries;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "ReminderSuite sync log" });

		if (this.entries.length === 0) {
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: "Nothing has synced yet in this session.",
			});
			return;
		}

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: `The last ${this.entries.length} sync events, oldest first. Kept in memory only — restarting Obsidian clears it.`,
		});
		contentEl.createEl("pre", { cls: "reminder-suite-sync-log", text: formatSyncLog(this.entries) });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
