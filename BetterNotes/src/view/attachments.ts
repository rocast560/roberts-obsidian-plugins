import { MarkdownView, TFile, TFolder, setIcon } from "obsidian";
import type BetterNotesPlugin from "../main";
import { ATTACHMENTS_DIR, IMAGE_EXTS } from "../core/pairing";

const BAR_CLASS = "betternotes-attachments";

const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "flac", "m4a", "3gp"]);
const VIDEO_EXTS = new Set(["mp4", "mov", "mkv", "webm", "avi"]);

function iconFor(ext: string): string {
  const e = ext.toLowerCase();
  if (AUDIO_EXTS.has(e)) return "file-audio";
  if (VIDEO_EXTS.has(e)) return "file-video";
  if (e === "pdf") return "file-text";
  return "file";
}

export class AttachmentsBar {
  private timer = 0;

  constructor(private plugin: BetterNotesPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  enable() {
    this.plugin.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshAll()));
    this.plugin.registerEvent(this.app.workspace.on("layout-change", () => this.refreshAll()));
    this.plugin.registerEvent(this.app.vault.on("create", () => this.refreshSoon()));
    this.plugin.registerEvent(this.app.vault.on("delete", () => this.refreshSoon()));
    this.refreshAll();
  }

  disable() {
    window.clearTimeout(this.timer);
    document.querySelectorAll(`.${BAR_CLASS}`).forEach((el) => el.remove());
  }

  refreshSoon() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refreshAll(), 150);
  }

  refreshAll() {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) this.attach(leaf.view);
    }
  }

  private attach(view: MarkdownView) {
    view.containerEl.querySelectorAll(`.${BAR_CLASS}`).forEach((el) => el.remove());
    if (!this.plugin.settings.attachmentsBar) return;
    const file = view.file;
    if (!file || !this.plugin.isInnerNote(file) || !file.parent) return;

    // Attachments live in the Attachments/ subfolder; legacy files in the
    // betternote's root still show so nothing silently disappears.
    const rootAtts = file.parent.children
      .filter((c): c is TFile => c instanceof TFile && c.extension !== "md");
    const attFolder = file.parent.children
      .find((c): c is TFolder => c instanceof TFolder && c.name === ATTACHMENTS_DIR);
    const subAtts = attFolder
      ? attFolder.children.filter((c): c is TFile => c instanceof TFile && c.extension !== "md")
      : [];
    const atts = [...rootAtts, ...subAtts].sort((a, b) => a.name.localeCompare(b.name));
    if (atts.length === 0) return;

    const content = view.containerEl.querySelector(".view-content");
    if (!content) return;

    const bar = document.createElement("div");
    bar.className = BAR_CLASS;
    if (this.plugin.settings.attachmentsBarCollapsed) bar.classList.add("is-collapsed");

    const header = document.createElement("div");
    header.className = `${BAR_CLASS}-header`;
    const clip = document.createElement("span");
    setIcon(clip, "paperclip");
    header.appendChild(clip);
    const label = document.createElement("span");
    label.textContent = `Attachments (${atts.length})`;
    header.appendChild(label);
    const chevron = document.createElement("span");
    chevron.className = `${BAR_CLASS}-chevron`;
    setIcon(chevron, "chevron-down");
    header.appendChild(chevron);
    header.addEventListener("click", () => {
      const collapsed = bar.classList.toggle("is-collapsed");
      this.plugin.settings.attachmentsBarCollapsed = collapsed;
      void this.plugin.saveSettings();
    });
    bar.appendChild(header);

    const grid = document.createElement("div");
    grid.className = `${BAR_CLASS}-grid`;
    for (const att of atts) {
      const item = document.createElement("div");
      item.className = "betternotes-attachment";
      if (IMAGE_EXTS.has(att.extension.toLowerCase())) {
        const img = document.createElement("img");
        img.src = this.app.vault.getResourcePath(att);
        img.alt = att.name;
        item.appendChild(img);
      } else {
        const box = document.createElement("div");
        box.className = "betternotes-attachment-iconbox";
        setIcon(box, iconFor(att.extension));
        item.appendChild(box);
      }
      const name = document.createElement("div");
      name.className = "betternotes-attachment-name";
      name.textContent = att.name;
      name.title = att.name;
      item.appendChild(name);
      item.addEventListener("click", () => {
        void this.app.workspace.getLeaf("tab").openFile(att);
      });
      item.addEventListener("mouseover", (event) => {
        this.app.workspace.trigger("hover-link", {
          event, source: "betternotes", hoverParent: view,
          targetEl: item, linktext: att.path,
        });
      });
      grid.appendChild(item);
    }
    bar.appendChild(grid);
    content.appendChild(bar);
  }
}
