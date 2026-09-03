import { App, Modal, Setting } from "obsidian";
import { isHex } from "./hex";
import type FolderPalettePlugin from "./main";
import { markSelected, renderSwatchStrip } from "./swatches";

const FALLBACK_PICKER = "#888888";

/** Opened from the folder context menu: swatches, custom picker, clear. */
export class ColorModal extends Modal {
  constructor(
    app: App,
    private readonly plugin: FolderPalettePlugin,
    private readonly path: string
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    contentEl.addClass("fp-modal");
    titleEl.setText(`Color for "${this.path}"`);

    const palette = this.plugin.palette;
    const current = this.plugin.settings.folderColors[this.path];
    const initial = isHex(current) ? current : null;

    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: `${palette.name} — click a swatch, or choose a custom color below.`,
    });

    const swatches = renderSwatchStrip(
      contentEl.createDiv({ cls: "fp-strip fp-strip-large" }),
      palette,
      initial,
      (hex) => {
        void this.plugin.setFolderColor(this.path, hex);
        this.close();
      }
    );

    new Setting(contentEl).setName("Custom color").addColorPicker((picker) =>
      picker.setValue(initial ?? FALLBACK_PICKER).onChange((hex) => {
        void this.plugin.setFolderColor(this.path, hex);
        markSelected(swatches, hex);
      })
    );

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Clear color").onClick(() => {
          void this.plugin.setFolderColor(this.path, null);
          this.close();
        })
      )
      .addButton((button) =>
        button
          .setButtonText("Done")
          .setCta()
          .onClick(() => this.close())
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
