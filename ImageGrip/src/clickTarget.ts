/** The subset of Element that click resolution needs (kept narrow so it is unit-testable without a DOM). */
export interface ClickElement {
  tagName: string;
  closest(selector: string): ClickElement | null;
  querySelector(selector: string): ClickElement | null;
}

export type ClickAction<T extends ClickElement> =
  | { kind: "ignore" }
  | { kind: "deselect" }
  | { kind: "select"; img: T };

const LIVE_PREVIEW_CONTENT = ".markdown-source-view.is-live-preview .cm-content";
const OVERLAY = ".imagegrip-overlay";
const EMBED = ".image-embed";
/** Obsidian's own per-embed controls (zoom/edit buttons, native resize corner). */
const NATIVE_CONTROLS = ".embed-actions, .image-resize-corner";

/**
 * Decide what a document click means for the selection.
 *
 * The click target is not always the <img>: Obsidian 1.13 wraps the image in
 * `.image-embed > .image-wrapper`, and themes that restyle the embed on
 * `:active` (e.g. Minimal's click-to-zoom) make the pointerup land on the
 * embed container, so the click's target becomes the container. Resolve the
 * image from whichever part of the embed was hit.
 */
export function resolveClickAction<T extends ClickElement>(
  target: T | null
): ClickAction<T> {
  if (!target) return { kind: "deselect" };
  if (target.closest(OVERLAY)) return { kind: "ignore" };
  if (!target.closest(LIVE_PREVIEW_CONTENT)) return { kind: "deselect" };
  if (target.closest(NATIVE_CONTROLS)) return { kind: "ignore" };
  const img =
    target.tagName === "IMG"
      ? target
      : (target.closest(EMBED)?.querySelector("img") as T | null | undefined);
  if (!img) return { kind: "deselect" };
  return { kind: "select", img };
}
