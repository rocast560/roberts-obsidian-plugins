import { PluginSettingTab, Setting, type App } from "obsidian";
import type FlowPathPlugin from "./main";
import type { Direction, ViewMode } from "./types";
import { VIEW_MODES } from "./types";
import { MODE_LABELS } from "./ui";

export interface FlowPathSettings {
  openInWindow: boolean;
  popoutWidth: number;
  popoutHeight: number;
  defaultView: ViewMode;
  defaultDir: Direction;
  embedOpenButton: boolean;
}

export const DEFAULT_SETTINGS: FlowPathSettings = {
  openInWindow: true,
  popoutWidth: 1200,
  popoutHeight: 800,
  defaultView: "map",
  defaultDir: "TB",
  embedOpenButton: true,
};

/** Map state as stored in plugin data (zoom null = not positioned yet). */
export interface SavedMapState {
  dir: Direction;
  collapsed: string[];
  zoom: number | null;
  panX: number;
  panY: number;
}

export interface FlowPathData {
  settings: FlowPathSettings;
  mapStates: Record<string, SavedMapState>;
  modes: Record<string, ViewMode>;
}

export class FlowPathSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: FlowPathPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveAll();

    new Setting(containerEl)
      .setName("Open charts in a separate window")
      .setDesc("Clicking a node link opens (or reuses) a pop-out window, so your notes stay put.")
      .addToggle((t) => t.setValue(s.openInWindow).onChange((v) => { s.openInWindow = v; save(); }));

    new Setting(containerEl)
      .setName("Pop-out width")
      .addText((t) => t.setValue(String(s.popoutWidth)).onChange((v) => {
        const n = parseInt(v, 10);
        if (n >= 400) { s.popoutWidth = n; save(); }
      }));
    new Setting(containerEl)
      .setName("Pop-out height")
      .addText((t) => t.setValue(String(s.popoutHeight)).onChange((v) => {
        const n = parseInt(v, 10);
        if (n >= 300) { s.popoutHeight = n; save(); }
      }));

    new Setting(containerEl)
      .setName("Default view")
      .setDesc("Used for charts you haven't opened before.")
      .addDropdown((d) => {
        for (const m of VIEW_MODES) d.addOption(m, MODE_LABELS[m]);
        d.setValue(s.defaultView).onChange((v) => { s.defaultView = v as ViewMode; save(); });
      });

    new Setting(containerEl)
      .setName("Default map direction")
      .addDropdown((d) => {
        d.addOption("TB", "Top to bottom").addOption("LR", "Left to right");
        d.setValue(s.defaultDir).onChange((v) => { s.defaultDir = v as Direction; save(); });
      });

    new Setting(containerEl)
      .setName("Show \"Open in window\" in embeds")
      .addToggle((t) => t.setValue(s.embedOpenButton).onChange((v) => { s.embedOpenButton = v; save(); }));
  }
}
