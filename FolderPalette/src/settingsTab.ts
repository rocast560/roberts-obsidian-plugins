import { App, ColorComponent, PluginSettingTab, Setting } from "obsidian";
import { isHex } from "./hex";
import type FolderPalettePlugin from "./main";
import { PALETTES, Palette } from "./palettes";
import { markSelected, renderSwatchStrip } from "./swatches";

const FALLBACK_PICKER = "#888888";

export class FolderPaletteSettingTab extends PluginSettingTab {
  private open = false;
  private rows: FolderRow[] = [];

  constructor(app: App, private plugin: FolderPalettePlugin) {
    super(app, plugin);
  }

  display(): void {
    this.open = true;
    const { containerEl } = this;
    const scrollTop = containerEl.scrollTop;
    containerEl.empty();
    this.rows = [];

    const palette = this.plugin.palette;

    new Setting(containerEl)
      .setName("Palette")
      .setDesc(`${palette.colors.length} colors — ${palette.source}`)
      .addDropdown((dropdown) => {
        for (const p of PALETTES) dropdown.addOption(p.id, p.name);
        dropdown.setValue(palette.id).onChange((id) => void this.plugin.setPaletteId(id));
      });

    renderSwatchStrip(containerEl.createDiv({ cls: "fp-strip fp-strip-preview" }), palette, null, null);

    new Setting(containerEl)
      .setName("Apply to all folders")
      .setDesc(
        "Colors every top-level folder from this palette in alphabetical order (wrapping around if there are more folders than colors). Replaces any colors set below."
      )
      .addButton((button) =>
        button
          .setButtonText("Apply")
          .setCta()
          .onClick(() => void this.plugin.applyPalette(palette))
      );

    new Setting(containerEl)
      .setName("Color files inside folders")
      .setDesc("Notes under a colored folder take the folder's color too.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.colorFiles)
          .onChange((on) => void this.plugin.setColorFiles(on))
      );

    new Setting(containerEl).setName("Explorer").setHeading();

    new Setting(containerEl)
      .setName("Show collapse arrows")
      .setDesc("The chevron on folder rows: down when open, right when closed. Click it to fold the folder's children.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showCollapseArrows)
          .onChange((on) => void this.plugin.setShowCollapseArrows(on))
      );

    new Setting(containerEl)
      .setName("Tree lines")
      .setDesc("Thin grey connectors from each folder down through its children, with a rounded elbow into every child.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.treeLines)
          .onChange((on) => void this.plugin.setTreeLines(on))
      );

    new Setting(containerEl).setName("Folders").setHeading();

    const names = this.plugin.topLevelFolderNames();
    if (names.length === 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "No top-level folders in this vault yet.",
      });
    }
    for (const name of names) {
      this.rows.push(new FolderRow(containerEl, this.plugin, name, palette));
    }

    containerEl.scrollTop = scrollTop;
  }

  hide(): void {
    this.open = false;
    this.rows = [];
  }

  /** Rebuild if the tab is currently showing; no-op otherwise. */
  refresh(): void {
    if (this.open) this.display();
  }
}

/** One settings row: dot + name, palette swatches, custom picker, clear. */
class FolderRow {
  private readonly dot: HTMLElement;
  private readonly swatches: Map<string, HTMLElement>;
  private picker!: ColorComponent;

  constructor(
    parent: HTMLElement,
    private readonly plugin: FolderPalettePlugin,
    private readonly path: string,
    palette: Palette
  ) {
    const setting = new Setting(parent).setClass("fp-folder-row");

    setting.nameEl.empty();
    this.dot = setting.nameEl.createSpan({ cls: "fp-dot" });
    setting.nameEl.appendText(path);

    this.swatches = renderSwatchStrip(
      setting.controlEl.createDiv({ cls: "fp-strip" }),
      palette,
      this.current(),
      (hex) => void this.set(hex)
    );

    setting.addColorPicker((picker) => {
      this.picker = picker;
      picker.setValue(this.current() ?? FALLBACK_PICKER).onChange((hex) => void this.set(hex));
    });

    setting.addExtraButton((button) =>
      button
        .setIcon("x")
        .setTooltip("Clear color")
        .onClick(() => void this.set(null))
    );

    this.sync();
  }

  private current(): string | null {
    const color = this.plugin.settings.folderColors[this.path];
    return isHex(color) ? color : null;
  }

  private async set(color: string | null): Promise<void> {
    await this.plugin.setFolderColor(this.path, color);
    this.sync();
  }

  /** Re-sync dot, swatch mark and picker from settings without rebuilding DOM. */
  sync(): void {
    const color = this.current();
    this.dot.style.setProperty("--fp-color", color ?? "transparent");
    markSelected(this.swatches, color);
    if (color !== null) this.picker.setValue(color);
  }
}
