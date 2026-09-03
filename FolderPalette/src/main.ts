import { Plugin, TAbstractFile, TFolder } from "obsidian";
import { assignPalette, dropKey, renameKey, sortFolderNames } from "./assign";
import { ColorModal } from "./colorModal";
import { buildCss } from "./css";
import { PaletteSuggestModal } from "./paletteModal";
import { getPalette, Palette } from "./palettes";
import { DEFAULT_SETTINGS, FolderPaletteSettings, normalizeSettings } from "./settings";
import { FolderPaletteSettingTab } from "./settingsTab";

const STYLE_ID = "folder-palette-styles";

export default class FolderPalettePlugin extends Plugin {
  settings: FolderPaletteSettings = { ...DEFAULT_SETTINGS, folderColors: {} };
  private styleEl: HTMLStyleElement | null = null;
  private settingTab!: FolderPaletteSettingTab;

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());

    this.styleEl = document.createElement("style");
    this.styleEl.id = STYLE_ID;
    document.head.appendChild(this.styleEl);
    this.applyStyles();
    this.applyBodyClasses();

    this.settingTab = new FolderPaletteSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.addCommand({
      id: "apply-palette",
      name: "Apply a color palette to all folders…",
      callback: () => {
        new PaletteSuggestModal(this.app, (palette) => void this.applyPalette(palette)).open();
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!this.isTopLevelFolder(file)) return;
        menu.addItem((item) =>
          item
            .setTitle("Change folder color…")
            .setIcon("palette")
            .onClick(() => new ColorModal(this.app, this, file.path).open())
        );
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFolder)) return;
        if (!(oldPath in this.settings.folderColors)) {
          // A folder appeared at (or left) the top level without a color: the
          // settings list changed shape, nothing to persist.
          this.settingTab.refresh();
          return;
        }
        this.settings.folderColors = this.isTopLevelFolder(file)
          ? renameKey(this.settings.folderColors, oldPath, file.path)
          : dropKey(this.settings.folderColors, oldPath);
        void this.persist();
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!(file instanceof TFolder)) return;
        if (file.path in this.settings.folderColors) {
          this.settings.folderColors = dropKey(this.settings.folderColors, file.path);
          void this.persist();
        } else {
          this.settingTab.refresh();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (this.isTopLevelFolder(file)) this.settingTab.refresh();
      })
    );
  }

  onunload(): void {
    document.body.removeClass("fp-arrows-off", "fp-tree-lines");
    this.styleEl?.remove();
    this.styleEl = null;
  }

  get palette(): Palette {
    return getPalette(this.settings.paletteId);
  }

  /** Sorted names (== paths) of the vault's top-level folders. */
  topLevelFolderNames(): string[] {
    const names = this.app.vault
      .getRoot()
      .children.filter((child): child is TFolder => child instanceof TFolder)
      .map((folder) => folder.path);
    return sortFolderNames(names);
  }

  isTopLevelFolder(file: TAbstractFile): file is TFolder {
    return file instanceof TFolder && file.parent !== null && file.parent.isRoot();
  }

  /** `color` null clears the folder. Rows in the settings tab re-sync themselves. */
  async setFolderColor(path: string, color: string | null): Promise<void> {
    this.settings.folderColors =
      color === null
        ? dropKey(this.settings.folderColors, path)
        : { ...this.settings.folderColors, [path]: color };
    await this.persist(false);
  }

  async setPaletteId(id: string): Promise<void> {
    this.settings.paletteId = getPalette(id).id;
    await this.persist();
  }

  async setColorFiles(on: boolean): Promise<void> {
    this.settings.colorFiles = on;
    await this.persist();
  }

  async setShowCollapseArrows(on: boolean): Promise<void> {
    this.settings.showCollapseArrows = on;
    await this.persist();
  }

  async setTreeLines(on: boolean): Promise<void> {
    this.settings.treeLines = on;
    await this.persist();
  }

  /** Select `palette` and color every top-level folder from it, in order. */
  async applyPalette(palette: Palette): Promise<void> {
    this.settings.paletteId = palette.id;
    this.settings.folderColors = assignPalette(this.topLevelFolderNames(), palette);
    await this.persist();
  }

  private async persist(rebuildTab = true): Promise<void> {
    await this.saveData(this.settings);
    this.applyStyles();
    this.applyBodyClasses();
    if (rebuildTab) this.settingTab.refresh();
  }

  private applyStyles(): void {
    if (!this.styleEl) return;
    const entries = Object.entries(this.settings.folderColors).map(([path, color]) => ({
      path,
      color,
    }));
    this.styleEl.textContent = buildCss(entries, { colorFiles: this.settings.colorFiles });
  }

  /** The two explorer toggles are plain body classes; styles.css does the rest. */
  private applyBodyClasses(): void {
    document.body.toggleClass("fp-arrows-off", !this.settings.showCollapseArrows);
    document.body.toggleClass("fp-tree-lines", this.settings.treeLines);
  }
}
