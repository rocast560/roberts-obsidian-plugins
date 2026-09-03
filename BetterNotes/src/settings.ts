import { App, PluginSettingTab, Setting } from "obsidian";
import type BetterNotesPlugin from "./main";

export interface BetterNotesSettings {
  takeoverCtrlN: boolean;
  showChildren: boolean;
  attachmentsBar: boolean;
  attachmentsBarCollapsed: boolean;
  /** BetterNote folder paths whose Attachments subfolder is currently shown in the explorer. */
  visibleAttachmentFolders: string[];
}

export const DEFAULT_SETTINGS: BetterNotesSettings = {
  takeoverCtrlN: true,
  showChildren: true,
  attachmentsBar: true,
  attachmentsBarCollapsed: true,
  visibleAttachmentFolders: [],
};

export class BetterNotesSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BetterNotesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Take over Ctrl+N")
      .setDesc("Ctrl+N creates a BetterNote; the core 'Create new note' hotkey is unbound. Turn off to restore the default binding.")
      .addToggle((t) => t.setValue(this.plugin.settings.takeoverCtrlN).onChange(async (v) => {
        this.plugin.settings.takeoverCtrlN = v;
        await this.plugin.saveSettings();
        this.plugin.applyHotkeyTakeover();
      }));

    new Setting(containerEl)
      .setName("Show BetterNote children")
      .setDesc("Show the chevron and the files/notes underneath BetterNotes in the file explorer.")
      .addToggle((t) => t.setValue(this.plugin.settings.showChildren).onChange(async (v) => {
        this.plugin.settings.showChildren = v;
        await this.plugin.saveSettings();
        this.plugin.explorer.applyGlobalToggle();
      }));

    new Setting(containerEl)
      .setName("Attachments bar")
      .setDesc("Show attachments stored inside a BetterNote at the bottom of its note.")
      .addToggle((t) => t.setValue(this.plugin.settings.attachmentsBar).onChange(async (v) => {
        this.plugin.settings.attachmentsBar = v;
        await this.plugin.saveSettings();
        this.plugin.attachments.refreshAll();
      }));

    new Setting(containerEl)
      .setName("Collapse attachments bar by default")
      .setDesc("Start with the attachments bar collapsed to just its header.")
      .addToggle((t) => t.setValue(this.plugin.settings.attachmentsBarCollapsed).onChange(async (v) => {
        this.plugin.settings.attachmentsBarCollapsed = v;
        await this.plugin.saveSettings();
        this.plugin.attachments.refreshAll();
      }));
  }
}
