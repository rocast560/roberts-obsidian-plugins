import { MarkdownView, Notice, Plugin } from "obsidian";
import { SelectionController } from "./resize";
import { applyWidth } from "./linkRewrite";
import { copyImage } from "./copy";
import { resolveClickAction } from "./clickTarget";

/** The undocumented CodeMirror 6 EditorView on Obsidian's Editor. */
interface CmView {
  posAtDOM(node: Node): number;
}

export default class ImageGripPlugin extends Plugin {
  private selection!: SelectionController;
  private reselectTimeoutId: number | null = null;

  onload(): void {
    this.selection = new SelectionController((img, width, prevWidth) =>
      this.commitResize(img, width, prevWidth)
    );

    this.registerDomEvent(document, "click", (evt) => this.handleClick(evt), true);
    this.registerDomEvent(
      document,
      "keydown",
      (evt) => {
        if (evt.key === "Escape" && this.selection.selectedImage) {
          this.selection.deselect();
        }
      },
      true
    );
    this.registerDomEvent(document, "copy", (evt) => this.handleCopy(evt), true);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.selection.deselect())
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.selection.deselect())
    );
    // Any edit may rebuild the embed widget; reposition() drops a selection whose <img> is gone.
    this.registerEvent(
      this.app.workspace.on("editor-change", () => this.selection.reposition())
    );
  }

  onunload(): void {
    if (this.reselectTimeoutId !== null) {
      window.clearTimeout(this.reselectTimeoutId);
      this.reselectTimeoutId = null;
    }
    this.selection.destroy();
  }

  private handleClick(evt: MouseEvent): void {
    const action = resolveClickAction(evt.target as HTMLElement | null);
    if (action.kind === "ignore") return;
    if (action.kind === "select") {
      evt.preventDefault();
      evt.stopPropagation();
      this.selection.select(action.img as HTMLImageElement);
      return;
    }
    this.selection.deselect();
  }

  private handleCopy(evt: ClipboardEvent): void {
    const img = this.selection.selectedImage;
    if (!img) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.editor.somethingSelected()) return;
    evt.preventDefault();
    evt.stopPropagation();
    copyImage(img).then(
      () => new Notice("Image copied"),
      (err) =>
        new Notice(
          `ImageGrip: could not copy image (${err instanceof Error ? err.message : err})`
        )
    );
  }

  private commitResize(
    img: HTMLImageElement,
    width: number,
    prevWidth: number | null
  ): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor;
    const cm = (editor as unknown as { cm?: CmView } | undefined)?.cm;
    if (!view || !editor || !cm) {
      this.failResize(img, prevWidth, "no active editor");
      return;
    }

    let offset: number;
    try {
      offset = cm.posAtDOM(img);
    } catch {
      this.failResize(img, prevWidth, "could not locate the image in the note");
      return;
    }

    const pos = editor.offsetToPos(offset);
    const hint =
      img.closest(".internal-embed, .external-embed")?.getAttribute("src") ??
      undefined;
    const edit = applyWidth(editor.getLine(pos.line), pos.ch, width, hint);
    if (!edit) {
      this.failResize(img, prevWidth, "could not find the image link");
      return;
    }

    const src = img.src;
    editor.replaceRange(
      edit.newText,
      { line: pos.line, ch: edit.startCh },
      { line: pos.line, ch: edit.endCh }
    );
    // Obsidian may reuse the <img> and just update its width attribute. Once the
    // attribute carries the size, drop our inline style so it no longer overrides
    // the attribute (which Obsidian's own resize corner edits).
    if (img.isConnected && img.getAttribute("width") === String(width)) {
      img.style.removeProperty("width");
      img.style.removeProperty("height");
    }
    this.selection.deselect();
    // Live Preview re-renders the embed; re-select the fresh img element.
    if (this.reselectTimeoutId !== null) {
      window.clearTimeout(this.reselectTimeoutId);
    }
    this.reselectTimeoutId = window.setTimeout(() => {
      this.reselectTimeoutId = null;
      // Guard against deselect-triggering events during the 100ms window.
      if (
        this.app.workspace.getActiveViewOfType(MarkdownView) !== view ||
        this.selection.selectedImage !== null
      ) {
        return;
      }
      const match = Array.from(view.contentEl.querySelectorAll("img")).find(
        (el) => el.src === src
      );
      if (match) this.selection.select(match);
    }, 100);
  }

  private failResize(
    img: HTMLImageElement,
    prevWidth: number | null,
    reason: string
  ): void {
    this.selection.revert(img, prevWidth);
    this.selection.deselect();
    new Notice(`ImageGrip: resize not saved — ${reason}`);
  }
}
