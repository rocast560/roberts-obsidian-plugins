import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type { ButtonComponent } from "obsidian";
import type ReminderSuitePlugin from "./main.ts";
import type { StoredTokens } from "./auth/tokenStore.ts";
import type { GCalCalendarListEntry } from "./gcal/types.ts";
import type { TaskMapping, Tombstone } from "./sync/mappings.ts";
import type { CompletedTaskStrategy } from "./sync/taskEvent.ts";

/**
 * What happens to a task when the Google event behind it is deleted. "complete"
 * reads a deletion as "done with it", which is what deleting a calendar entry
 * usually means; "delete-line" mirrors the deletion into the vault; "ignore"
 * only unlinks, leaving the task exactly as it is.
 */
export type RemoteDeleteBehavior = "complete" | "delete-line" | "ignore";

/** Everything ReminderSuite persists to the vault's plugin data. */
export interface ReminderSuiteSettings {
	googleClientId: string;
	googleClientSecret: string;
	tokens: StoredTokens | null;
	/** Google calendar IDs whose events the calendar view fetches and displays. */
	enabledCalendarIds: string[];
	/** How often an open calendar view refetches its current window, in minutes. */
	pollIntervalMinutes: number;
	/** Vault path where the sidebar's quick-add appends new tasks. Created (with a "# Inbox" header) if missing. */
	inboxNotePath: string;
	/** When non-empty, only checkbox lines containing this tag are indexed (Tasks-plugin convention, e.g. "#task"). */
	taskFilterTag: string;
	/**
	 * When non-empty, tasks are read from this single note only — no vault-wide
	 * scan — and the sidebar's quick-add appends there instead of the inbox
	 * note. Follows the note if it is renamed. Empty means index every note.
	 */
	taskSourcePath: string;
	/** Auto-reveal the ReminderSuite sidebar on startup. */
	openSidebarOnStartup: boolean;
	/** Calendar that quick-add and "Sync to Google Calendar" push tasks to. Empty until the user picks one. */
	defaultTaskCalendarId: string;
	/** What happens to a synced event when its task is completed: retitle it with a ✓, or delete it. */
	completedTaskStrategy: CompletedTaskStrategy;
	/** Popup reminder lead time for task events, in minutes; `null` uses the Google calendar's own default. */
	defaultReminderMinutes: number | null;
	/** What a task does when its Google event is deleted remotely. */
	remoteDeleteBehavior: RemoteDeleteBehavior;
	/** Task↔event links. Owned by MappingStore — never edited by hand from the settings tab. */
	syncMappings: TaskMapping[];
	/** Events this plugin deleted because their task was deleted; drained at the start of every pull. */
	syncTombstones: Tombstone[];
	/**
	 * Calendar ID → Google sync token: the cursor an incremental pull resumes
	 * from. Owned by SyncEngine. Dropping an entry costs a full re-sync of that
	 * calendar, never correctness.
	 */
	calendarSyncTokens: Record<string, string>;
	/** Also show an OS-level notification (in addition to the in-app reminder card) when a ⏰ comes due. Desktop only. */
	useSystemNotification: boolean;
	/** How many minutes past a ⏰ time ReminderSuite will still surface it, for reminders that came due while Obsidian was closed. */
	missedReminderGraceMinutes: number;
	/**
	 * Reminders already shown, so a restart does not re-fire an earlier one.
	 * Keyed by file path, line, and the reminder date/time (see
	 * ReminderScheduler.reminderKey), pruned to the last 7 days. Owned by
	 * ReminderScheduler — never edited by hand.
	 */
	notifiedReminders: string[];
}

export const DEFAULT_SETTINGS: ReminderSuiteSettings = {
	googleClientId: "",
	googleClientSecret: "",
	tokens: null,
	enabledCalendarIds: [],
	pollIntervalMinutes: 5,
	inboxNotePath: "ReminderSuite Inbox.md",
	taskFilterTag: "",
	taskSourcePath: "",
	openSidebarOnStartup: false,
	defaultTaskCalendarId: "",
	completedTaskStrategy: "retitle",
	defaultReminderMinutes: 10,
	remoteDeleteBehavior: "complete",
	syncMappings: [],
	syncTombstones: [],
	calendarSyncTokens: {},
	useSystemNotification: true,
	missedReminderGraceMinutes: 60,
	notifiedReminders: [],
};

const MIN_POLL_INTERVAL_MINUTES = 1;

/** Calendars this plugin may write to. Reader/freeBusy calendars can't hold a task event. */
export function writableCalendars(calendars: GCalCalendarListEntry[]): GCalCalendarListEntry[] {
	return calendars.filter((cal) => cal.accessRole === "writer" || cal.accessRole === "owner");
}

/**
 * The task source note path as matched against vault file paths: "" when
 * unset, otherwise the configured value with ".md" appended when the user
 * typed a bare note name — the Obsidian habit, since links and search never
 * use extensions.
 */
export function resolvedTaskSourcePath(settings: ReminderSuiteSettings): string {
	const raw = settings.taskSourcePath;
	if (raw === "" || raw.toLowerCase().endsWith(".md")) {
		return raw;
	}
	return `${raw}.md`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Narrows a dropdown's string back to the union, defaulting to the safest option. */
function toRemoteDeleteBehavior(value: string): RemoteDeleteBehavior {
	return value === "delete-line" || value === "ignore" ? value : "complete";
}

export class ReminderSuiteSettingTab extends PluginSettingTab {
	private plugin: ReminderSuitePlugin;
	/** Calendars fetched via "Load calendars"; null until the user loads them. */
	private loadedCalendars: GCalCalendarListEntry[] | null = null;

	constructor(app: App, plugin: ReminderSuitePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Google account").setHeading();

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "ReminderSuite connects with your own Google OAuth client. Create a project in the Google Cloud console, enable the Google Calendar API, and create an OAuth client of type \"Desktop app\", then paste its ID and secret below. See the plugin README for the full walkthrough.",
		});

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Your client secret and Google tokens are stored unencrypted in this vault's plugin data folder. Anyone with access to the vault (including its sync or backup copies) can read them.",
		});

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("OAuth 2.0 client ID from your Google Cloud project.")
			.addText((text) =>
				text
					.setPlaceholder("1234567890-abc.apps.googleusercontent.com")
					.setValue(this.plugin.settings.googleClientId)
					.onChange(async (value) => {
						this.plugin.settings.googleClientId = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("OAuth 2.0 client secret for the same client.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("GOCSPX-…")
					.setValue(this.plugin.settings.googleClientSecret)
					.onChange(async (value) => {
						this.plugin.settings.googleClientSecret = value.trim();
						await this.plugin.saveSettings();
					});
			});

		this.displayConnection(containerEl);
		this.displayCalendars(containerEl);
		this.displayTasks(containerEl);
		this.displaySync(containerEl);
		this.displayReminders(containerEl);
	}

	private displaySync(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Sync").setHeading();

		const calendarSetting = new Setting(containerEl)
			.setName("Default calendar for tasks")
			.setDesc("Where tasks you sync from the sidebar are created.");

		const writable = this.loadedCalendars === null ? null : writableCalendars(this.loadedCalendars);
		if (writable === null) {
			calendarSetting.setDesc(
				this.plugin.settings.defaultTaskCalendarId === ""
					? "Use \"Load calendars\" above to choose a calendar."
					: `Currently ${this.plugin.settings.defaultTaskCalendarId}. Use "Load calendars" above to change it.`,
			);
		} else {
			calendarSetting.addDropdown((dropdown) => {
				dropdown.addOption("", "None — task sync off");
				for (const calendar of writable) {
					dropdown.addOption(calendar.id, calendar.summary);
				}
				// A previously chosen calendar the account no longer writes to would
				// otherwise silently reset the dropdown to "None".
				const current = this.plugin.settings.defaultTaskCalendarId;
				if (current !== "" && !writable.some((cal) => cal.id === current)) {
					dropdown.addOption(current, `${current} (no write access)`);
				}
				dropdown.setValue(current).onChange(async (value) => {
					this.plugin.settings.defaultTaskCalendarId = value;
					await this.plugin.saveSettings();
				});
			});
		}

		new Setting(containerEl)
			.setName("When a task is completed")
			.setDesc("What happens to the Google event behind a task you tick off.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("retitle", "Keep it, prefixed with ✓")
					.addOption("delete", "Delete the event")
					.setValue(this.plugin.settings.completedTaskStrategy)
					.onChange(async (value) => {
						this.plugin.settings.completedTaskStrategy = value === "delete" ? "delete" : "retitle";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("When an event is deleted in Google")
			.setDesc("What happens to the task behind an event you delete from your calendar.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("complete", "Tick the task off")
					.addOption("delete-line", "Delete the task line")
					.addOption("ignore", "Leave the task alone")
					.setValue(this.plugin.settings.remoteDeleteBehavior)
					.onChange(async (value) => {
						this.plugin.settings.remoteDeleteBehavior = toRemoteDeleteBehavior(value);
						await this.plugin.saveSettings();
					}),
			);

		const syncedCount = this.plugin.settings.syncMappings.length;
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				syncedCount === 0
					? "No tasks are synced to Google yet. Right-click a task in the sidebar to sync it."
					: `${syncedCount} task${syncedCount === 1 ? "" : "s"} synced to Google.`,
		});
	}

	private displayReminders(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Reminders").setHeading();

		new Setting(containerEl)
			.setName("Reminder lead time")
			.setDesc("Minutes before a synced task's event that Google pops up a reminder. Leave blank to use the calendar's own default.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text
					.setPlaceholder("calendar default")
					.setValue(
						this.plugin.settings.defaultReminderMinutes === null
							? ""
							: String(this.plugin.settings.defaultReminderMinutes),
					)
					.onChange(async (value) => {
						const trimmed = value.trim();
						if (trimmed === "") {
							this.plugin.settings.defaultReminderMinutes = null;
						} else {
							const parsed = Number.parseInt(trimmed, 10);
							if (Number.isNaN(parsed) || parsed < 0) {
								return;
							}
							this.plugin.settings.defaultReminderMinutes = parsed;
						}
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Desktop notifications")
			.setDesc("Also show an OS notification (in addition to the in-app reminder card) when a task's ⏰ time arrives. Desktop only.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.useSystemNotification).onChange(async (value) => {
					this.plugin.settings.useSystemNotification = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Missed reminder grace period")
			.setDesc("Minutes after a ⏰ time ReminderSuite will still show the reminder, for one that came due while Obsidian wasn't open.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.setValue(String(this.plugin.settings.missedReminderGraceMinutes)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isNaN(parsed) || parsed < 0) {
						return;
					}
					this.plugin.settings.missedReminderGraceMinutes = parsed;
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "On mobile, reminders for synced tasks are delivered by the Google Calendar app.",
		});
	}

	private displayTasks(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Tasks").setHeading();

		new Setting(containerEl)
			.setName("Task source note")
			.setDesc(
				"Read tasks from this single note instead of scanning the whole vault. Quick-added tasks go here too (the inbox note is ignored while this is set). \".md\" is added automatically. Leave blank to index every note.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Tasks.md")
					.setValue(this.plugin.settings.taskSourcePath)
					.onChange(async (value) => {
						this.plugin.settings.taskSourcePath = value.trim();
						await this.plugin.saveSettings();
						await this.plugin.taskIndex.rebuild();
					}),
			);

		new Setting(containerEl)
			.setName("Inbox note")
			.setDesc("Vault path where the sidebar's quick-add appends new tasks. Created automatically if missing.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.inboxNotePath)
					.setValue(this.plugin.settings.inboxNotePath)
					.onChange(async (value) => {
						const trimmed = value.trim();
						this.plugin.settings.inboxNotePath = trimmed === "" ? DEFAULT_SETTINGS.inboxNotePath : trimmed;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Task filter tag")
			.setDesc(
				"Only checkbox lines containing this tag are indexed (e.g. \"#task\"). Leave blank to index every checkbox.",
			)
			.addText((text) =>
				text
					.setPlaceholder("#task")
					.setValue(this.plugin.settings.taskFilterTag)
					.onChange(async (value) => {
						this.plugin.settings.taskFilterTag = value.trim();
						await this.plugin.saveSettings();
						await this.plugin.taskIndex.rebuild();
					}),
			);

		new Setting(containerEl)
			.setName("Open sidebar on startup")
			.setDesc("Automatically reveal the ReminderSuite sidebar when Obsidian starts.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.openSidebarOnStartup).onChange(async (value) => {
					this.plugin.settings.openSidebarOnStartup = value;
					await this.plugin.saveSettings();
				}),
			);
	}

	private displayCalendars(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Calendars").setHeading();

		if (!this.plugin.tokenStore.isSignedIn()) {
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "Sign in to Google above to choose which calendars ReminderSuite shows.",
			});
			return;
		}

		new Setting(containerEl)
			.setName("Load calendars")
			.setDesc("Fetch your Google calendar list to choose which ones to show.")
			.addButton((button) =>
				button.setButtonText("Load calendars").onClick(async () => {
					button.setDisabled(true);
					try {
						this.loadedCalendars = await this.plugin.gcalClient.listCalendars();
					} catch (error) {
						new Notice(`ReminderSuite: ${errorMessage(error)}`, 10000);
					} finally {
						this.display();
					}
				}),
			);

		if (this.loadedCalendars !== null) {
			for (const calendar of this.loadedCalendars) {
				new Setting(containerEl)
					.setName(calendar.summary)
					.addToggle((toggle) =>
						toggle
							.setValue(this.plugin.settings.enabledCalendarIds.includes(calendar.id))
							.onChange(async (enabled) => {
								const ids = new Set(this.plugin.settings.enabledCalendarIds);
								if (enabled) {
									ids.add(calendar.id);
								} else {
									ids.delete(calendar.id);
								}
								this.plugin.settings.enabledCalendarIds = [...ids];
								await this.plugin.saveSettings();
							}),
					);
			}
		}

		new Setting(containerEl)
			.setName("Poll interval")
			.setDesc("How often, in minutes, an open calendar view refetches its events.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = String(MIN_POLL_INTERVAL_MINUTES);
				text
					.setValue(String(this.plugin.settings.pollIntervalMinutes))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isNaN(parsed) || parsed < MIN_POLL_INTERVAL_MINUTES) {
							return;
						}
						this.plugin.settings.pollIntervalMinutes = parsed;
						await this.plugin.saveSettings();
					});
			});
	}

	private displayConnection(containerEl: HTMLElement): void {
		const signedIn = this.plugin.tokenStore.isSignedIn();
		const setting = new Setting(containerEl)
			.setName(signedIn ? "Connected" : "Not connected")
			.setDesc(
				signedIn
					? "ReminderSuite can read your calendar list and manage your events."
					: "Sign in to grant access to your calendar events and calendar list.",
			);

		if (!Platform.isDesktopApp && !signedIn) {
			setting.setDesc(
				"Signing in requires the Obsidian desktop app. Sign in there and the connection will be available here.",
			);
			setting.addButton((button) => button.setButtonText("Sign in").setDisabled(true));
			return;
		}

		setting.addButton((button) => {
			button.setButtonText(signedIn ? "Sign out" : "Sign in");
			if (!signedIn) {
				button.setCta();
			}
			button.onClick(async () => {
				button.setDisabled(true);
				try {
					if (signedIn) {
						await this.plugin.tokenStore.signOut();
						new Notice("ReminderSuite: signed out of Google.");
					} else {
						await this.signIn(button);
					}
				} catch (error) {
					new Notice(`ReminderSuite: ${errorMessage(error)}`, 10000);
				} finally {
					this.display();
				}
			});
		});
	}

	private async signIn(button: ButtonComponent): Promise<void> {
		if (
			this.plugin.settings.googleClientId === "" ||
			this.plugin.settings.googleClientSecret === ""
		) {
			throw new Error("Enter your Google client ID and client secret first.");
		}
		button.setButtonText("Waiting for browser…");
		await this.plugin.tokenStore.signIn();
		new Notice("ReminderSuite: connected to Google.");
	}
}
