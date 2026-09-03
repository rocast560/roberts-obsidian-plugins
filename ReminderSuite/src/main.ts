import { Notice, Platform, Plugin, TFile } from "obsidian";
import type { App, PluginManifest } from "obsidian";
import { TokenStore } from "./auth/tokenStore.ts";
import type { StoredTokens } from "./auth/tokenStore.ts";
import { DEFAULT_SETTINGS, ReminderSuiteSettingTab, resolvedTaskSourcePath } from "./settings.ts";
import type { ReminderSuiteSettings } from "./settings.ts";
import { GCalClient } from "./gcal/client.ts";
import { CALENDAR_VIEW_TYPE, CalendarView } from "./views/calendarView.ts";
import { SIDEBAR_VIEW_TYPE, SidebarView } from "./views/sidebarView.ts";
import { SyncLogModal } from "./views/syncLogModal.ts";
import { VaultTaskIndex } from "./tasks/index.ts";
import { MappingStore } from "./sync/mappings.ts";
import { SyncEngine } from "./sync/engine.ts";
import type { SyncStatus } from "./sync/engine.ts";
import { REMINDER_TICK_MS, ReminderScheduler } from "./reminders/scheduler.ts";

const MS_PER_MINUTE = 60 * 1000;
/** How long task edits settle before a push; a burst of typing shouldn't be a burst of API calls. */
const PUSH_DEBOUNCE_MS = 3000;

/** `HH:MM` of the last successful sync, for the status bar. */
function clockTime(date: Date): string {
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export default class ReminderSuitePlugin extends Plugin {
	settings: ReminderSuiteSettings = { ...DEFAULT_SETTINGS };
	tokenStore: TokenStore;
	gcalClient: GCalClient;
	/** Assigned in onload, after settings are loaded — see the comment there for why. */
	taskIndex!: VaultTaskIndex;
	mappings!: MappingStore;
	syncEngine!: SyncEngine;
	/** Desktop only — stays `null` on mobile, where reminders for synced tasks come from the Google Calendar app instead. */
	reminderScheduler: ReminderScheduler | null = null;
	private pushTimer: ReturnType<typeof setTimeout> | null = null;
	/** Previous sync state, so a Notice fires on the transition into an error rather than on every poll. */
	private lastSyncState: SyncStatus["state"] = "idle";

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		this.tokenStore = new TokenStore({
			getClientId: () => this.settings.googleClientId,
			getClientSecret: () => this.settings.googleClientSecret,
			getTokens: () => this.settings.tokens,
			setTokens: (tokens: StoredTokens | null) => {
				this.settings.tokens = tokens;
			},
			save: () => this.saveSettings(),
		});
		this.gcalClient = new GCalClient(this.tokenStore);
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		// VaultTaskIndex holds `this.settings` directly (not a getter, unlike
		// tokenStore's deps above) — it must be built with the final loaded
		// object, since loadSettings() reassigns `this.settings` to a new
		// object and nothing after this point ever reassigns it again.
		this.taskIndex = new VaultTaskIndex(this.app, this.settings);
		// The settings object doubles as the mapping store's persisted state.
		this.mappings = new MappingStore(this.settings, () => this.saveSettings());
		this.syncEngine = new SyncEngine({
			app: this.app,
			settings: this.settings,
			client: this.gcalClient,
			index: this.taskIndex,
			mappings: this.mappings,
			saveSettings: () => this.saveSettings(),
		});
		// Mobile has no background timers worth running here: the reminder card
		// and OS notification are both desktop-only, and a synced task's reminder
		// already reaches the user through the Google Calendar app.
		if (Platform.isDesktopApp) {
			this.reminderScheduler = new ReminderScheduler({
				app: this.app,
				index: this.taskIndex,
				settings: this.settings,
				saveSettings: () => this.saveSettings(),
			});
			this.registerInterval(
				window.setInterval(() => this.reminderScheduler?.tick(), REMINDER_TICK_MS),
			);
		}

		this.addSettingTab(new ReminderSuiteSettingTab(this.app, this));

		this.registerView(CALENDAR_VIEW_TYPE, (leaf) => new CalendarView(leaf, this));
		this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new SidebarView(leaf, this));

		this.addRibbonIcon("calendar-days", "Open ReminderSuite calendar", () => {
			void this.activateCalendarView();
		});
		this.addRibbonIcon("list-todo", "Open ReminderSuite sidebar", () => {
			void this.activateSidebarView();
		});

		this.addCommand({
			id: "open-calendar",
			name: "Open calendar",
			callback: () => {
				void this.activateCalendarView();
			},
		});
		this.addCommand({
			id: "open-sidebar",
			name: "Open sidebar",
			callback: () => {
				void this.activateSidebarView();
			},
		});
		this.addCommand({
			id: "sync-now",
			name: "Sync with Google now",
			callback: () => {
				if (!this.tokenStore.isSignedIn()) {
					new Notice("ReminderSuite: sign in to Google in settings first.");
					return;
				}
				void this.syncNow();
			},
		});
		this.addCommand({
			id: "show-sync-log",
			name: "Show sync log",
			callback: () => {
				new SyncLogModal(this.app, this.syncEngine.logEntries()).open();
			},
		});

		this.setUpStatusBar();

		this.registerEvent(
			this.app.metadataCache.on("changed", (file, _data, cache) => {
				this.taskIndex.handleFileChanged(file, cache);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) {
					this.taskIndex.handleFileDeleted(file.path);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) {
					// Follow the single task-source note if it's what moved,
					// before the index re-reads under the new path.
					if (resolvedTaskSourcePath(this.settings) === oldPath) {
						this.settings.taskSourcePath = file.path;
						void this.saveSettings();
					}
					this.taskIndex.handleFileRenamed(file, oldPath);
					void this.syncEngine.handleFileRenamed(oldPath, file.path);
				}
			}),
		);

		this.register(this.taskIndex.onChange(() => this.scheduleSyncPush()));

		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				await this.taskIndex.rebuild();
				// Only now can a mapping with no task in the index be read as a
				// deleted task rather than an index that hasn't loaded yet.
				this.syncEngine.markIndexReady();
				if (this.settings.openSidebarOnStartup) {
					await this.activateSidebarView();
				}
			})();
		});

		this.registerInterval(
			window.setInterval(() => void this.syncNow(), this.settings.pollIntervalMinutes * MS_PER_MINUTE),
		);
	}

	onunload(): void {
		if (this.pushTimer !== null) {
			clearTimeout(this.pushTimer);
			this.pushTimer = null;
		}
		// The 30s tick itself is torn down by registerInterval; this just drops
		// the scheduler's own index subscription.
		this.reminderScheduler?.destroy();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// The sync collections are mutated in place (the arrays by MappingStore,
		// the token map by SyncEngine), so they must never be the shared objects
		// inside DEFAULT_SETTINGS — which is what Object.assign leaves behind for
		// a vault that has never synced. The nullish guards cover a hand-edited
		// data.json.
		this.settings.syncMappings = [...(this.settings.syncMappings ?? [])];
		this.settings.syncTombstones = [...(this.settings.syncTombstones ?? [])];
		this.settings.calendarSyncTokens = { ...(this.settings.calendarSyncTokens ?? {}) };
		this.settings.notifiedReminders = [...(this.settings.notifiedReminders ?? [])];
	}

	/**
	 * A one-item status bar reflecting the engine's own state — the item renders
	 * what it's told and knows nothing about syncing. Clicking it syncs, which
	 * is what a user pokes a sync indicator for.
	 */
	private setUpStatusBar(): void {
		const item = this.addStatusBarItem();
		item.addClass("mod-clickable");
		item.addClass("reminder-suite-status");
		item.addEventListener("click", () => {
			if (!this.tokenStore.isSignedIn()) {
				new Notice("ReminderSuite: sign in to Google in settings first.");
				return;
			}
			void this.syncNow();
		});
		this.register(this.syncEngine.onStatus((status) => this.renderSyncStatus(item, status)));
	}

	private renderSyncStatus(item: HTMLElement, status: SyncStatus): void {
		if (status.state === "syncing") {
			item.setText("GCal ⟳");
			item.setAttribute("aria-label", "ReminderSuite: syncing with Google…");
		} else if (status.state === "error") {
			item.setText("GCal ⚠");
			item.setAttribute("aria-label", `ReminderSuite: ${status.message ?? "sync failed"}`);
		} else {
			const last = status.lastSync;
			item.setText(last === undefined ? "GCal" : `GCal ✓ ${clockTime(last)}`);
			item.setAttribute(
				"aria-label",
				last === undefined
					? "ReminderSuite: not synced yet — click to sync"
					: `ReminderSuite: last synced at ${clockTime(last)} — click to sync`,
			);
		}

		// Only re-authentication is worth interrupting for, and only as it
		// happens: a background cycle that keeps failing shouldn't keep saying so.
		if (
			status.state === "error" &&
			status.authRequired === true &&
			this.lastSyncState !== "error"
		) {
			new Notice("ReminderSuite: sign in to Google again to keep syncing.", 10000);
		}
		this.lastSyncState = status.state;
	}

	/**
	 * A full sync cycle followed by a view refresh — what the poll tick, the
	 * "Sync now" command, the status bar and the sidebar's refresh button all
	 * run. Signed out, it's just the refresh, so those controls still do the
	 * visible half of their job.
	 */
	async syncNow(): Promise<void> {
		if (this.tokenStore.isSignedIn()) {
			await this.syncEngine.syncCycle();
		}
		this.refreshOpenViews();
	}

	/**
	 * Coalesces the task index's change notifications into one push. Edits
	 * arrive in bursts (every keystroke in a task line is a metadata change),
	 * and each push walks the whole ledger.
	 */
	private scheduleSyncPush(): void {
		if (this.pushTimer !== null) {
			clearTimeout(this.pushTimer);
		}
		this.pushTimer = setTimeout(() => {
			this.pushTimer = null;
			this.runSyncPush();
		}, PUSH_DEBOUNCE_MS);
	}

	/** Pushes local task changes to Google, unless there's no account to push to. */
	private runSyncPush(): void {
		if (!this.tokenStore.isSignedIn()) {
			return;
		}
		void this.syncEngine.pushDirty();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Reveals the calendar view, creating it in a new main-area leaf if none is open yet. */
	private async activateCalendarView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)[0];
		const leaf = existing ?? this.app.workspace.getLeaf(true);
		if (existing === undefined) {
			await leaf.setViewState({ type: CALENDAR_VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Reveals the sidebar view in the right leaf, creating it if none is open yet. */
	private async activateSidebarView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)[0];
		if (existing !== undefined) {
			await this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf === null) {
			return;
		}
		await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Tells every open calendar and sidebar view to refresh. Calendar refetch is
	 * gated on signed-in + enabled calendars; the sidebar's own `refreshAgenda`
	 * self-guards the same way, so it's always safe to call.
	 */
	private refreshOpenViews(): void {
		if (this.tokenStore.isSignedIn() && this.settings.enabledCalendarIds.length > 0) {
			for (const leaf of this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)) {
				if (leaf.view instanceof CalendarView) {
					void leaf.view.refetch();
				}
			}
		}
		for (const leaf of this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)) {
			if (leaf.view instanceof SidebarView) {
				void leaf.view.refreshAgenda();
			}
		}
	}
}
