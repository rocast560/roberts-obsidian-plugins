/**
 * The in-memory record of what sync did, and why. Deliberately not a file: a
 * log that writes to the vault would itself be a change the vault has to sync,
 * and the questions this answers ("what happened to my task just now?") are
 * about the current session.
 *
 * A fixed-size ring buffer, so a plugin left running for a week can't grow it
 * without bound. Pure apart from the timestamp it stamps on each entry.
 */

export interface SyncLogEntry {
	/** ISO 8601, stamped when the entry was added. */
	timestamp: string;
	/** What happened, as a short stable slug: "conflict", "remote-applied", "push", … */
	action: string;
	/** The block id or event id the entry is about, when it's about one thing. */
	id?: string;
	detail?: string;
}

/** How many entries are kept. Older ones fall off the front. */
export const SYNC_LOG_LIMIT = 50;

export class SyncLog {
	private entries: SyncLogEntry[] = [];

	add(action: string, id?: string, detail?: string): void {
		this.entries.push({
			timestamp: new Date().toISOString(),
			action,
			...(id !== undefined ? { id } : {}),
			...(detail !== undefined && detail !== "" ? { detail } : {}),
		});
		if (this.entries.length > SYNC_LOG_LIMIT) {
			this.entries.splice(0, this.entries.length - SYNC_LOG_LIMIT);
		}
	}

	/** Oldest first. */
	all(): readonly SyncLogEntry[] {
		return this.entries;
	}
}

/** `HH:MM:SS` of an entry's timestamp, or the raw value if it isn't a timestamp. */
function clockTime(timestamp: string): string {
	const parsed = new Date(timestamp);
	return Number.isNaN(parsed.getTime()) ? timestamp : parsed.toTimeString().slice(0, 8);
}

const ACTION_COLUMN = 18;
const ID_COLUMN = 12;

/** One fixed-width line per entry, newest last — what the sync-log modal shows. */
export function formatSyncLog(entries: readonly SyncLogEntry[]): string {
	return entries
		.map((entry) => {
			const columns = [
				clockTime(entry.timestamp),
				entry.action.padEnd(ACTION_COLUMN),
				(entry.id ?? "").padEnd(ID_COLUMN),
				entry.detail ?? "",
			];
			return columns.join(" ").trimEnd();
		})
		.join("\n");
}
