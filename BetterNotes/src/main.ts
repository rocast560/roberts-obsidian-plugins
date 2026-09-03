import { Editor, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder } from "obsidian";
import * as pairing from "./core/pairing";
import { findTocBlock, renderTocBlock, tocEntries } from "./core/toc";
import { BetterNotesSettings, BetterNotesSettingTab, DEFAULT_SETTINGS } from "./settings";
import { ExplorerPatch } from "./explorer/patch";
import { AttachmentsBar } from "./view/attachments";

export default class BetterNotesPlugin extends Plugin {
  settings: BetterNotesSettings = DEFAULT_SETTINGS;
  explorer!: ExplorerPatch;
  attachments!: AttachmentsBar;
  private syncing = false;
  private origAttachmentPathFn: ((...args: unknown[]) => Promise<string>) | null = null;

  exists = (p: string): boolean => this.app.vault.getAbstractFileByPath(p) !== null;

  async onload() {
    await this.loadSettings();
    this.explorer = new ExplorerPatch(this);
    this.attachments = new AttachmentsBar(this);
    this.addSettingTab(new BetterNotesSettingTab(this.app, this));

    this.addCommand({
      id: "new-betternote",
      name: "New BetterNote",
      hotkeys: [{ modifiers: ["Mod"], key: "n" }],
      callback: () => this.createBetterNote(),
    });
    this.addCommand({
      id: "toggle-children",
      name: "Toggle BetterNote children visibility",
      callback: async () => {
        this.settings.showChildren = !this.settings.showChildren;
        await this.saveSettings();
        this.explorer.applyGlobalToggle();
      },
    });
    this.addCommand({
      id: "toggle-attachments-folder",
      name: "Toggle attachments folder visibility (this BetterNote)",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "a" }],
      checkCallback: (checking) => {
        const folder = this.betterNoteFolderOfActive();
        if (!folder) return false;
        if (!checking) void this.toggleAttachmentsVisibility(folder.path);
        return true;
      },
    });
    this.addCommand({
      id: "insert-toc",
      name: "Insert sub-note table of contents",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "t" }],
      editorCheckCallback: (checking, editor, ctx) => {
        const f = ctx.file;
        if (!f || !this.isInnerNote(f)) return false;
        if (!checking) this.insertToc(editor, f);
        return true;
      },
    });
    this.addCommand({
      id: "convert-note",
      name: "Convert current note to BetterNote",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "md" || this.isInnerNote(f)) return false;
        if (!checking) void this.convertNote(f);
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.onFileMenu(menu, file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.onRename(file, oldPath)));

    this.app.workspace.onLayoutReady(() => {
      this.explorer.enable();
      this.attachments.enable();
      this.patchAttachmentPath();
      this.applyHotkeyTakeover();
    });
  }

  onunload() {
    this.explorer.disable();
    this.attachments.disable();
    this.unpatchAttachmentPath();
    if (this.settings.takeoverCtrlN) this.restoreCoreNewNoteHotkey();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- identity -----------------------------------------------------------

  isBetterNote(af: TAbstractFile | null): af is TFolder {
    return af instanceof TFolder &&
      this.app.vault.getAbstractFileByPath(pairing.noteNameForFolder(af.path)) instanceof TFile;
  }

  isInnerNote(af: TAbstractFile | null): af is TFile {
    return af instanceof TFile && af.extension === "md" &&
      pairing.folderForInnerNote(af.path) !== null;
  }

  innerNoteOf(folder: TFolder): TFile | null {
    const af = this.app.vault.getAbstractFileByPath(pairing.noteNameForFolder(folder.path));
    return af instanceof TFile ? af : null;
  }

  betterNoteFolderOfActive(): TFolder | null {
    const f = this.app.workspace.getActiveFile();
    if (!f || !this.isInnerNote(f)) return null;
    return f.parent;
  }

  // ---- attachments-folder visibility --------------------------------------

  isAttachmentsVisible(folderPath: string): boolean {
    return this.settings.visibleAttachmentFolders.includes(folderPath);
  }

  async toggleAttachmentsVisibility(folderPath: string) {
    const list = this.settings.visibleAttachmentFolders;
    const i = list.indexOf(folderPath);
    if (i === -1) list.push(folderPath);
    else list.splice(i, 1);
    await this.saveSettings();
    this.explorer.scheduleDecorate();
  }

  // ---- table of contents ---------------------------------------------------

  insertToc(editor: Editor, note: TFile) {
    const folder = note.parent;
    if (!folder) return;
    const childFoldersOf = (p: string) => {
      const af = this.app.vault.getAbstractFileByPath(p);
      if (!(af instanceof TFolder)) return [];
      return af.children.filter((c): c is TFolder => c instanceof TFolder).map((c) => c.path);
    };
    const entries = tocEntries(folder.path, childFoldersOf, (p) =>
      this.isBetterNote(this.app.vault.getAbstractFileByPath(p)));
    if (entries.length === 0) {
      new Notice("BetterNotes: no sub-notes to link.");
      return;
    }
    const items = entries.flatMap((e) => {
      const inner = this.app.vault.getAbstractFileByPath(pairing.noteNameForFolder(e.folderPath));
      if (!(inner instanceof TFile)) return [];
      return [{ link: this.app.fileManager.generateMarkdownLink(inner, note.path), depth: e.depth }];
    });
    const block = renderTocBlock(items);
    const span = findTocBlock(editor.getValue());
    if (span) {
      editor.replaceRange(block, editor.offsetToPos(span.from), editor.offsetToPos(span.to));
      new Notice("BetterNotes: table of contents refreshed.");
    } else {
      editor.replaceSelection(block + "\n");
    }
  }

  // ---- creation / conversion ---------------------------------------------

  async createBetterNote(parent?: TFolder) {
    const parentFolder = parent ??
      this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
    const parentPath = parentFolder.path === "/" ? "" : parentFolder.path;
    const plan = pairing.newBetterNotePlan(parentPath, this.exists);
    this.syncing = true;
    try {
      await this.app.vault.createFolder(plan.folder);
      const note = await this.app.vault.create(plan.note, "");
      await this.app.workspace.getLeaf(false).openFile(note);
    } finally {
      this.syncing = false;
    }
    this.explorer.scheduleDecorate();
    // Focus the title for immediate renaming (F2 behavior); rename-sync renames the folder.
    window.setTimeout(() => {
      (this.app as any).commands?.executeCommandById?.("workspace:edit-file-title");
    }, 100);
  }

  async makeBetterNote(folder: TFolder) {
    const notePath = pairing.noteNameForFolder(folder.path);
    if (this.exists(notePath)) return;
    const note = await this.app.vault.create(notePath, "");
    await this.app.workspace.getLeaf(false).openFile(note);
    this.explorer.scheduleDecorate();
  }

  async convertNote(file: TFile) {
    const plan = pairing.convertPlan(file.path, this.exists);
    if (!plan) return;
    this.syncing = true;
    try {
      if (plan.createFolder) await this.app.vault.createFolder(plan.folder);
      await this.app.fileManager.renameFile(file, plan.noteTo);
    } catch (e) {
      console.error("BetterNotes: convert failed", e);
      new Notice("BetterNotes: convert failed — see console.");
    } finally {
      this.syncing = false;
    }
    this.explorer.scheduleDecorate();
  }

  async flatten(folder: TFolder) {
    const plan = pairing.flattenPlan(folder.path, folder.children.map((c) => c.path), this.exists);
    if (!plan) return;
    const note = this.innerNoteOf(folder);
    if (!note) return;
    this.syncing = true;
    try {
      await this.app.fileManager.renameFile(note, plan.noteTo);
      if (plan.deleteFolder) {
        const fm = this.app.fileManager as any;
        if (typeof fm.trashFile === "function") await fm.trashFile(folder);
        else await this.app.vault.trash(folder, true);
      }
    } catch (e) {
      console.error("BetterNotes: flatten failed", e);
      new Notice("BetterNotes: flatten failed — see console.");
    } finally {
      this.syncing = false;
    }
    this.explorer.scheduleDecorate();
  }

  // ---- sync ---------------------------------------------------------------

  private async onRename(file: TAbstractFile, oldPath: string) {
    this.explorer.scheduleDecorate();
    this.attachments.refreshSoon();
    // Keep attachments-visibility state pointing at renamed/moved betternotes,
    // including renames we perform ourselves (so this runs before the syncing guard).
    if (file instanceof TFolder) {
      const list = this.settings.visibleAttachmentFolders;
      let changed = false;
      for (let i = 0; i < list.length; i++) {
        if (list[i] === oldPath) {
          list[i] = file.path;
          changed = true;
        } else if (list[i].startsWith(oldPath + "/")) {
          list[i] = file.path + list[i].slice(oldPath.length);
          changed = true;
        }
      }
      if (changed) void this.saveSettings();
    }
    if (this.syncing) return;
    let op: pairing.RenameOp | null = null;
    if (file instanceof TFolder) op = pairing.folderRenameSync(oldPath, file.path, this.exists);
    else if (file instanceof TFile && file.extension === "md") op = pairing.noteRenameSync(oldPath, file.path, this.exists);
    if (!op) return;
    const target = this.app.vault.getAbstractFileByPath(op.from);
    if (!target) return;
    this.syncing = true;
    try {
      await this.app.fileManager.renameFile(target, op.to);
    } catch (e) {
      console.error("BetterNotes: rename sync failed", e);
    } finally {
      this.syncing = false;
    }
    this.explorer.scheduleDecorate();
  }

  // ---- menus --------------------------------------------------------------

  private onFileMenu(menu: Menu, file: TAbstractFile) {
    if (file instanceof TFolder) {
      menu.addItem((i) => i.setTitle("New BetterNote inside").setIcon("file-plus-2")
        .onClick(() => void this.createBetterNote(file)));
      if (this.isBetterNote(file)) {
        menu.addItem((i) => i.setTitle("Flatten to plain note").setIcon("file-minus-2")
          .onClick(() => void this.flatten(file)));
      } else {
        menu.addItem((i) => i.setTitle("Turn into BetterNote").setIcon("file-symlink")
          .onClick(() => void this.makeBetterNote(file)));
      }
    } else if (file instanceof TFile && file.extension === "md" && !this.isInnerNote(file)) {
      menu.addItem((i) => i.setTitle("Convert to BetterNote").setIcon("file-symlink")
        .onClick(() => void this.convertNote(file)));
    }

    const bnFolder = file instanceof TFolder && this.isBetterNote(file) ? file
      : this.isInnerNote(file) ? file.parent : null;
    if (bnFolder) {
      const visible = this.isAttachmentsVisible(bnFolder.path);
      menu.addItem((i) => i
        .setTitle(visible ? "Hide attachments folder" : "Show attachments folder")
        .setIcon("paperclip")
        .onClick(() => void this.toggleAttachmentsVisibility(bnFolder.path)));
    }
  }

  // ---- Ctrl+N takeover ----------------------------------------------------

  applyHotkeyTakeover() {
    const hm = (this.app as any).hotkeyManager;
    if (!hm || typeof hm.setHotkeys !== "function") {
      if (this.settings.takeoverCtrlN) {
        new Notice("BetterNotes: couldn't rebind Ctrl+N automatically — unbind 'Create new note' in Settings → Hotkeys.");
      }
      return;
    }
    try {
      if (this.settings.takeoverCtrlN) hm.setHotkeys("file-explorer:new-file", []);
      else hm.removeHotkeys("file-explorer:new-file");
      hm.bake?.();
      hm.save?.();
    } catch (e) {
      console.error("BetterNotes: hotkey takeover failed", e);
    }
  }

  private restoreCoreNewNoteHotkey() {
    try {
      const hm = (this.app as any).hotkeyManager;
      hm?.removeHotkeys?.("file-explorer:new-file");
      hm?.bake?.();
      hm?.save?.();
    } catch (e) {
      console.error("BetterNotes: hotkey restore failed", e);
    }
  }

  // ---- attachment path override -------------------------------------------

  private patchAttachmentPath() {
    const vault = this.app.vault as any;
    if (typeof vault.getAvailablePathForAttachments !== "function") return;
    this.origAttachmentPathFn = vault.getAvailablePathForAttachments;
    const plugin = this;
    vault.getAvailablePathForAttachments = async function (
      fileName: string, extension: string, file: TAbstractFile | null, ...rest: unknown[]
    ): Promise<string> {
      if (file instanceof TFile && plugin.isInnerNote(file) && file.parent) {
        const parentPath = file.parent.path === "/" ? "" : file.parent.path;
        const attFolder = pairing.join(parentPath, pairing.ATTACHMENTS_DIR);
        const existing = plugin.app.vault.getAbstractFileByPath(attFolder);
        if (existing === null) {
          try {
            await plugin.app.vault.createFolder(attFolder);
          } catch (e) {
            console.error("BetterNotes: could not create attachments folder", e);
          }
        }
        // If something non-folder squats on the Attachments name, fall back to the folder root.
        const base = plugin.app.vault.getAbstractFileByPath(attFolder) instanceof TFolder ? attFolder : parentPath;
        const desired = pairing.join(base, `${fileName}.${extension}`);
        return pairing.collisionFreeFile(desired, plugin.exists);
      }
      return plugin.origAttachmentPathFn!.call(this, fileName, extension, file, ...rest);
    };
  }

  private unpatchAttachmentPath() {
    if (this.origAttachmentPathFn) {
      (this.app.vault as any).getAvailablePathForAttachments = this.origAttachmentPathFn;
      this.origAttachmentPathFn = null;
    }
  }
}
