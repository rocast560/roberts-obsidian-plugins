import { describe, expect, it } from "vitest";
import { resolveClickAction, type ClickElement } from "../src/clickTarget";

/** Minimal stand-in for a DOM element: `closest`/`querySelector` answer from a fixed map. */
function el(
  tagName: string,
  ancestors: Record<string, boolean> = {},
  children: Record<string, ClickElement | null> = {}
): ClickElement {
  const self: ClickElement = {
    tagName,
    closest: (selector) => {
      if (ancestors[selector]) return self;
      // comma lists: match if any member matches
      if (selector.split(",").some((s) => ancestors[s.trim()])) return self;
      return null;
    },
    querySelector: (selector) => children[selector] ?? null,
  };
  return self;
}

const LP = ".markdown-source-view.is-live-preview .cm-content";

describe("resolveClickAction", () => {
  it("selects an <img> clicked directly inside Live Preview", () => {
    const img = el("IMG", { [LP]: true, ".image-embed": true });
    expect(resolveClickAction(img)).toEqual({ kind: "select", img });
  });

  it("selects the embed's <img> when the click lands on the embed container", () => {
    const img = el("IMG");
    const embedDiv = el("DIV", { [LP]: true, ".image-embed": true }, { img });
    expect(resolveClickAction(embedDiv)).toEqual({ kind: "select", img });
  });

  it("ignores clicks on ImageGrip's own overlay", () => {
    const handle = el("DIV", { ".imagegrip-overlay": true });
    expect(resolveClickAction(handle)).toEqual({ kind: "ignore" });
  });

  it("ignores clicks on Obsidian's native embed controls", () => {
    const corner = el("DIV", { [LP]: true, ".image-embed": true, ".image-resize-corner": true });
    const action = el("DIV", { [LP]: true, ".image-embed": true, ".embed-actions": true });
    expect(resolveClickAction(corner)).toEqual({ kind: "ignore" });
    expect(resolveClickAction(action)).toEqual({ kind: "ignore" });
  });

  it("deselects on clicks outside Live Preview or outside any embed", () => {
    const readingImg = el("IMG", { ".image-embed": true });
    const text = el("SPAN", { [LP]: true });
    expect(resolveClickAction(readingImg)).toEqual({ kind: "deselect" });
    expect(resolveClickAction(text)).toEqual({ kind: "deselect" });
    expect(resolveClickAction(null)).toEqual({ kind: "deselect" });
  });

  it("deselects when the embed container has no image yet", () => {
    const embedDiv = el("DIV", { [LP]: true, ".image-embed": true });
    expect(resolveClickAction(embedDiv)).toEqual({ kind: "deselect" });
  });
});
