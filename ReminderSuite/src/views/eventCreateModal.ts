/**
 * The modal behind clicking an empty slot in the calendar view: title, all-day
 * flag, and which calendar to create the event in.
 *
 * Calendar-born events are deliberately not vault tasks — they exist only in
 * Google, and the calendar view shows them like any other remote event.
 */

import { Modal, Notice, Setting } from "obsidian";
import type { App } from "obsidian";
import type { GCalCalendarListEntry } from "../gcal/types.ts";

export interface CreateEventRequest {
	calendarId: string;
	title: string;
	allDay: boolean;
}

export interface CreateEventModalOptions {
	/** Calendars offered in the dropdown; the caller filters to writable, displayed ones. */
	calendars: GCalCalendarListEntry[];
	/** Pre-selected calendar, when it's among `calendars`. */
	defaultCalendarId: string;
	/** The clicked slot, used for the modal's subtitle and to seed the all-day toggle. */
	date: Date;
	allDay: boolean;
	onSubmit: (request: CreateEventRequest) => void;
}

function describeSlot(date: Date, allDay: boolean): string {
	return allDay
		? date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
		: date.toLocaleString(undefined, {
				weekday: "long",
				month: "long",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			});
}

export class CreateEventModal extends Modal {
	private options: CreateEventModalOptions;
	private title = "";
	private allDay: boolean;
	private calendarId: string;

	constructor(app: App, options: CreateEventModalOptions) {
		super(app);
		this.options = options;
		this.allDay = options.allDay;
		const hasDefault = options.calendars.some((cal) => cal.id === options.defaultCalendarId);
		this.calendarId = hasDefault ? options.defaultCalendarId : (options.calendars[0]?.id ?? "");
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "New event" });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: describeSlot(this.options.date, this.options.allDay),
		});

		let submit: () => void = () => {};

		new Setting(contentEl).setName("Title").addText((text) => {
			text.setPlaceholder("Event title").onChange((value) => {
				this.title = value;
			});
			text.inputEl.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		new Setting(contentEl)
			.setName("All day")
			.addToggle((toggle) =>
				toggle.setValue(this.allDay).onChange((value) => {
					this.allDay = value;
				}),
			);

		new Setting(contentEl).setName("Calendar").addDropdown((dropdown) => {
			for (const calendar of this.options.calendars) {
				dropdown.addOption(calendar.id, calendar.summary);
			}
			dropdown.setValue(this.calendarId).onChange((value) => {
				this.calendarId = value;
			});
		});

		submit = () => {
			const title = this.title.trim();
			if (title === "") {
				new Notice("ReminderSuite: give the event a title.");
				return;
			}
			if (this.calendarId === "") {
				new Notice("ReminderSuite: no writable calendar is enabled.");
				return;
			}
			this.close();
			this.options.onSubmit({ calendarId: this.calendarId, title, allDay: this.allDay });
		};

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Create")
					.setCta()
					.onClick(() => submit()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
