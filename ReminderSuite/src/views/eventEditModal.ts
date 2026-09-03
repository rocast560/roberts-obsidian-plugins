/**
 * The modal behind clicking a Google-born event in the calendar view: rename,
 * retime, or delete a simple event in place. Recurring occurrences, events
 * mirroring vault tasks, and read-only calendars open in a hand-off mode
 * instead — Google's UI owns series semantics ("this occurrence / whole
 * series / this and following"), and a synced task's source of truth is its
 * markdown line.
 */

import { Modal, Notice, Setting } from "obsidian";
import type { App } from "obsidian";
import type { GCalEvent, GCalEventInput } from "../gcal/types.ts";

export interface EditEventModalOptions {
	event: GCalEvent;
	/** Shown as the modal's subtitle so the user knows which calendar they're editing. */
	calendarName: string;
	/** When false, the modal shows `readOnlyReason` and offers only the Google Calendar hand-off. */
	editable: boolean;
	readOnlyReason?: string;
	onSave: (patch: GCalEventInput) => void;
	onDelete: () => void;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function isoDateLocal(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function timeLocal(d: Date): string {
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function shiftISODate(dateStr: string, days: number): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	return isoDateLocal(new Date(y, m - 1, d + days));
}

function parseLocal(dateStr: string, time: string): Date {
	const [y, m, d] = dateStr.split("-").map(Number);
	const [hh, mm] = time.split(":").map(Number);
	return new Date(y, m - 1, d, hh, mm);
}

export class EventEditModal extends Modal {
	private options: EditEventModalOptions;
	private title: string;
	private allDay: boolean;
	private startDate = "";
	private startTime = "";
	/** For all-day events this is the INCLUSIVE end date the user sees; GCal's exclusive form is derived on save. */
	private endDate = "";
	private endTime = "";
	private confirmingDelete = false;

	constructor(app: App, options: EditEventModalOptions) {
		super(app);
		this.options = options;
		const ev = options.event;
		this.title = ev.summary ?? "";
		this.allDay = ev.start?.date !== undefined;
		if (this.allDay) {
			this.startDate = ev.start?.date ?? "";
			const exclusiveEnd = ev.end?.date ?? shiftISODate(this.startDate, 1);
			this.endDate = shiftISODate(exclusiveEnd, -1);
			if (this.endDate < this.startDate) {
				this.endDate = this.startDate;
			}
		} else {
			const start = new Date(ev.start?.dateTime ?? "");
			const end = new Date(ev.end?.dateTime ?? "");
			this.startDate = isoDateLocal(start);
			this.startTime = timeLocal(start);
			this.endDate = isoDateLocal(end);
			this.endTime = timeLocal(end);
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.options.editable ? "Edit event" : "Event" });
		contentEl.createEl("p", { cls: "setting-item-description", text: this.options.calendarName });

		if (!this.options.editable) {
			this.renderReadOnly(contentEl);
			return;
		}

		let submit: () => void = () => {};

		new Setting(contentEl).setName("Title").addText((text) => {
			text.setValue(this.title).onChange((value) => {
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

		if (this.allDay) {
			new Setting(contentEl).setName("Start date").addText((text) =>
				text
					.setPlaceholder("YYYY-MM-DD")
					.setValue(this.startDate)
					.onChange((value) => {
						this.startDate = value.trim();
					}),
			);
			new Setting(contentEl)
				.setName("End date")
				.setDesc("Last day of the event (inclusive).")
				.addText((text) =>
					text
						.setPlaceholder("YYYY-MM-DD")
						.setValue(this.endDate)
						.onChange((value) => {
							this.endDate = value.trim();
						}),
				);
		} else {
			new Setting(contentEl).setName("Start").addText((text) =>
				text
					.setPlaceholder("YYYY-MM-DD")
					.setValue(this.startDate)
					.onChange((value) => {
						this.startDate = value.trim();
					}),
			);
			new Setting(contentEl).setName("Start time").addText((text) =>
				text
					.setPlaceholder("HH:mm")
					.setValue(this.startTime)
					.onChange((value) => {
						this.startTime = value.trim();
					}),
			);
			new Setting(contentEl).setName("End").addText((text) =>
				text
					.setPlaceholder("YYYY-MM-DD")
					.setValue(this.endDate)
					.onChange((value) => {
						this.endDate = value.trim();
					}),
			);
			new Setting(contentEl).setName("End time").addText((text) =>
				text
					.setPlaceholder("HH:mm")
					.setValue(this.endTime)
					.onChange((value) => {
						this.endTime = value.trim();
					}),
			);
		}

		submit = () => {
			const patch = this.buildPatch();
			if (patch === null) {
				return;
			}
			this.close();
			this.options.onSave(patch);
		};

		const actions = new Setting(contentEl);
		actions.addButton((button) =>
			button
				.setButtonText("Delete")
				.setWarning()
				.onClick(() => {
					if (!this.confirmingDelete) {
						this.confirmingDelete = true;
						button.setButtonText("Confirm delete");
						return;
					}
					this.close();
					this.options.onDelete();
				}),
		);
		this.addOpenInGoogleButton(actions);
		actions.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
		actions.addButton((button) =>
			button
				.setButtonText("Save")
				.setCta()
				.onClick(() => submit()),
		);
	}

	/** Validates the fields and builds the patch, or reports why not and returns null. */
	private buildPatch(): GCalEventInput | null {
		const title = this.title.trim();
		if (title === "") {
			new Notice("ReminderSuite: give the event a title.");
			return null;
		}
		if (!DATE_RE.test(this.startDate) || !DATE_RE.test(this.endDate)) {
			new Notice("ReminderSuite: dates must be YYYY-MM-DD.");
			return null;
		}
		if (this.allDay) {
			if (this.endDate < this.startDate) {
				new Notice("ReminderSuite: the end date is before the start date.");
				return null;
			}
			return {
				summary: title,
				start: { date: this.startDate },
				end: { date: shiftISODate(this.endDate, 1) },
			};
		}
		if (!TIME_RE.test(this.startTime) || !TIME_RE.test(this.endTime)) {
			new Notice("ReminderSuite: times must be HH:mm (24-hour).");
			return null;
		}
		const start = parseLocal(this.startDate, this.startTime);
		const end = parseLocal(this.endDate, this.endTime);
		if (end.getTime() <= start.getTime()) {
			new Notice("ReminderSuite: the event must end after it starts.");
			return null;
		}
		return {
			summary: title,
			// A UTC instant is unambiguous, so no timeZone field is needed.
			start: { dateTime: start.toISOString() },
			end: { dateTime: end.toISOString() },
		};
	}

	private renderReadOnly(contentEl: HTMLElement): void {
		contentEl.createEl("p", { text: this.options.event.summary ?? "(untitled)" });
		if (this.options.readOnlyReason !== undefined) {
			contentEl.createEl("p", { cls: "setting-item-description", text: this.options.readOnlyReason });
		}
		const actions = new Setting(contentEl);
		this.addOpenInGoogleButton(actions);
		actions.addButton((button) => button.setButtonText("Close").onClick(() => this.close()));
	}

	private addOpenInGoogleButton(actions: Setting): void {
		const link = this.options.event.htmlLink;
		if (link === undefined || link === "") {
			return;
		}
		actions.addButton((button) =>
			button.setButtonText("Open in Google Calendar").onClick(() => {
				window.open(link);
			}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
