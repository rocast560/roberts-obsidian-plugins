import { TFile, TFolder, setIcon } from "obsidian";
import type BetterNotesPlugin from "../main";
import { ATTACHMENTS_DIR, noteNameForFolder } from "../core/pairing";

export class ExplorerPatch {
  private raf = 0;
  private clickHandler = (evt: MouseEvent) => this.onClick(evt);

  constructor(private plugin: BetterNotesPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  enable() {
    document.body.addEventListener("click", this.clickHandler, true);
    this.plugin.registerEvent(this.app.vault.on("create", () => this.scheduleDecorate()));
    this.plugin.registerEvent(this.app.vault.on("delete", () => this.scheduleDecorate()));
    this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleDecorate()));
    this.applyGlobalToggle();
    this.scheduleDecorate();
  }

  disable() {
    document.body.removeEventListener("click", this.clickHandler, true);
    document.body.removeClass("betternotes-hide-children");
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const view of this.explorerViews()) {
      const items = view.fileItems ?? {};
      for (const path in items) {
        this.undecorateItem(items[path]);
        this.rootElOf(items[path])?.removeClass("betternote-attachments-hidden");
      }
    }
  }

  applyGlobalToggle() {
    document.body.toggleClass("betternotes-hide-children", !this.plugin.settings.showChildren);
  }

  scheduleDecorate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.decorate();
    });
  }

  private explorerViews(): any[] {
    return this.app.workspace.getLeavesOfType("file-explorer").map((l) => l.view as any);
  }

  private decorate() {
    for (const view of this.explorerViews()) {
      const items = view.fileItems;
      if (!items) continue;
      for (const path in items) {
        const item = items[path];
        const af = item?.file;
        if (af instanceof TFolder) {
          const isHiddenAttFolder = af.name === ATTACHMENTS_DIR &&
            af.parent !== null && this.plugin.isBetterNote(af.parent) &&
            !this.plugin.isAttachmentsVisible(af.parent.path);
          this.rootElOf(item)?.toggleClass("betternote-attachments-hidden", isHiddenAttFolder);
          if (this.plugin.isBetterNote(af)) this.decorateFolder(item, af);
          else this.undecorateItem(item);
        } else if (af instanceof TFile) {
          this.rootElOf(item)?.toggleClass("betternote-hidden-note", this.plugin.isInnerNote(af));
        }
      }
    }
  }

  private rootElOf(item: any): HTMLElement | null {
    return (item?.el as HTMLElement) ?? (item?.selfEl as HTMLElement | undefined)?.parentElement ?? null;
  }

  private decorateFolder(item: any, folder: TFolder) {
    const rootEl = this.rootElOf(item);
    const selfEl = item?.selfEl as HTMLElement | undefined;
    if (!rootEl || !selfEl) return;
    rootEl.addClass("betternote");
    const inner = noteNameForFolder(folder.path);
    const others = folder.children.filter((c) => {
      if (c.path === inner) return false;
      if (c instanceof TFolder && c.name === ATTACHMENTS_DIR &&
        !this.plugin.isAttachmentsVisible(folder.path)) return false;
      return true;
    });
    rootEl.toggleClass("betternote-no-children", others.length === 0);
    if (!selfEl.querySelector(".betternote-icon")) {
      const icon = document.createElement("div");
      icon.className = "betternote-icon";
      setIcon(icon, "file-text");
      const content = selfEl.querySelector(".nav-folder-title-content");
      selfEl.insertBefore(icon, content);
    }
  }

  // Note: "betternote-attachments-hidden" is managed separately in decorate() —
  // undecorating a plain folder must not reveal a hidden Attachments folder.
  private undecorateItem(item: any) {
    const rootEl = this.rootElOf(item);
    rootEl?.removeClass("betternote", "betternote-no-children", "betternote-hidden-note");
    (item?.selfEl as HTMLElement | undefined)?.querySelector(".betternote-icon")?.remove();
  }

  private onClick(evt: MouseEvent) {
    const target = evt.target as HTMLElement | null;
    if (!target) return;
    const content = target.closest(".nav-folder-title-content");
    if (!content) return;
    const titleEl = content.closest(".nav-folder-title") as HTMLElement | null;
    const path = titleEl?.getAttribute("data-path");
    if (!path) return;
    const folder = this.app.vault.getAbstractFileByPath(path);
    if (!(folder instanceof TFolder) || !this.plugin.isBetterNote(folder)) return;
    const note = this.plugin.innerNoteOf(folder);
    if (!note) return;
    evt.preventDefault();
    evt.stopPropagation();
    void this.app.workspace.getLeaf(evt.ctrlKey || evt.metaKey ? "tab" : false).openFile(note);
  }
}
