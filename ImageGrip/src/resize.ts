export type Corner = "nw" | "ne" | "sw" | "se";

export function computeDragWidth(
  startWidth: number,
  dx: number,
  corner: Corner,
  minWidth = 40
): number {
  const delta = corner === "ne" || corner === "se" ? dx : -dx;
  return Math.max(minWidth, Math.round(startWidth + delta));
}

export type ResizeEndCallback = (
  img: HTMLImageElement,
  width: number,
  prevWidth: number | null
) => void;

/**
 * Owns the selected image and its corner-handle overlay.
 *
 * The overlay is hosted on `document.body` with `position: fixed` and tracked
 * to the image's viewport rect, rather than being inserted into the embed.
 * Keeping it outside the embed matters for three reasons observed in
 * Obsidian 1.13 + Minimal:
 *  - pressing anything inside `.image-embed` makes it `:active`, which themes
 *    use for click-to-zoom (fullscreen fixed layout, image measured at 0x0);
 *  - Obsidian's native 30x30 `.image-resize-corner` (z-index 1) sits over the
 *    embed's bottom-right corner;
 *  - handles that overhang the embed are painted over by the following
 *    `.cm-line` (position: relative, later in DOM order).
 */
export class SelectionController {
  private img: HTMLImageElement | null = null;
  private container: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private handles: Partial<Record<Corner, HTMLElement>> = {};
  private dragging = false;
  private cancelActiveDrag: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onViewportChange = () => this.reposition();

  constructor(
    private onResizeEnd: ResizeEndCallback,
    private host: HTMLElement = document.body
  ) {}

  get selectedImage(): HTMLImageElement | null {
    return this.img;
  }

  select(img: HTMLImageElement): void {
    if (this.img === img) return;
    this.deselect();
    const container =
      (img.closest(".image-embed") as HTMLElement | null) ?? img.parentElement;
    if (!container) return;
    this.img = img;
    this.container = container;
    container.classList.add("imagegrip-selected");
    const overlay = document.createElement("div");
    overlay.className = "imagegrip-overlay";
    for (const corner of ["nw", "ne", "sw", "se"] as Corner[]) {
      const handle = document.createElement("div");
      handle.className = "imagegrip-handle";
      handle.dataset.corner = corner;
      handle.addEventListener("pointerdown", (evt) => this.startDrag(evt, corner));
      overlay.appendChild(handle);
      this.handles[corner] = handle;
    }
    this.host.appendChild(overlay);
    this.overlay = overlay;
    // Scroll events don't bubble, so listen in the capture phase at the document.
    document.addEventListener("scroll", this.onViewportChange, true);
    window.addEventListener("resize", this.onViewportChange);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onViewportChange);
      this.resizeObserver.observe(img);
    }
    this.reposition();
  }

  /** Re-anchor the overlay to the image; drops the selection if the image left the DOM. */
  reposition(): void {
    const img = this.img;
    const overlay = this.overlay;
    if (!img || !overlay) return;
    if (!img.isConnected) {
      this.deselect();
      return;
    }
    const rect = img.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    // Hide handles whose corner has scrolled out of the editor's visible area.
    const clip = (
      (img.closest(".cm-scroller") as HTMLElement | null) ?? img.parentElement
    )?.getBoundingClientRect();
    const corners: Record<Corner, [number, number]> = {
      nw: [rect.left, rect.top],
      ne: [rect.right, rect.top],
      sw: [rect.left, rect.bottom],
      se: [rect.right, rect.bottom],
    };
    for (const corner of Object.keys(corners) as Corner[]) {
      const [x, y] = corners[corner];
      const visible =
        !clip ||
        (x >= clip.left && x <= clip.right && y >= clip.top && y <= clip.bottom);
      this.handles[corner]?.classList.toggle("imagegrip-hidden", !visible);
    }
  }

  deselect(): void {
    if (this.cancelActiveDrag) {
      this.cancelActiveDrag();
      this.cancelActiveDrag = null;
    }
    this.dragging = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    document.removeEventListener("scroll", this.onViewportChange, true);
    window.removeEventListener("resize", this.onViewportChange);
    this.overlay?.remove();
    this.container?.classList.remove("imagegrip-selected");
    this.img = null;
    this.container = null;
    this.overlay = null;
    this.handles = {};
  }

  revert(img: HTMLImageElement, prevWidth: number | null): void {
    if (prevWidth !== null) {
      img.style.width = `${prevWidth}px`;
    } else {
      img.style.removeProperty("width");
      img.style.removeProperty("height");
    }
  }

  destroy(): void {
    this.deselect();
  }

  private startDrag(evt: PointerEvent, corner: Corner): void {
    if (evt.button !== 0) return;
    const img = this.img;
    if (!img) return;
    evt.preventDefault();
    evt.stopPropagation();
    const startWidth = img.getBoundingClientRect().width;
    // A 0-wide image has no usable baseline (not laid out, or collapsed by a theme).
    if (!(startWidth > 0)) return;
    this.dragging = true;
    const handle = evt.currentTarget as HTMLElement;
    handle.setPointerCapture(evt.pointerId);
    const startX = evt.clientX;
    const prevStyleWidth = img.style.width
      ? Math.round(parseFloat(img.style.width))
      : null;
    let lastWidth = Math.round(startWidth);
    let moved = false;

    const cleanup = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
    };
    const onMove = (moveEvt: PointerEvent) => {
      moved = true;
      lastWidth = computeDragWidth(startWidth, moveEvt.clientX - startX, corner);
      img.style.width = `${lastWidth}px`;
      img.style.height = "auto";
      this.reposition();
    };
    const onUp = () => {
      this.cancelActiveDrag = null;
      cleanup();
      if (!this.dragging) return;
      this.dragging = false;
      if (!moved) return;
      this.onResizeEnd(img, lastWidth, prevStyleWidth);
    };
    const onCancel = () => {
      this.cancelActiveDrag = null;
      cleanup();
      this.dragging = false;
      this.revert(img, prevStyleWidth);
      this.reposition();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    this.cancelActiveDrag = () => {
      cleanup();
      this.revert(img, prevStyleWidth);
    };
  }
}
