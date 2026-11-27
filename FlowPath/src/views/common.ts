// Shared building blocks for the four view renderers.
import { setIcon } from "obsidian";
import type { FlowHost } from "../host";
import { childrenOf, pathTo } from "../model";
import type { FlowNode } from "../types";

export function colorClass(n: FlowNode): string {
  return n.color ? "fp-c-" + n.color : "";
}

export function icon(parent: HTMLElement, name: string, cls = ""): HTMLElement {
  const s = parent.createSpan({ cls: "fp-ico " + cls });
  setIcon(s, name);
  return s;
}

/** First non-empty line of a description, with light markdown noise removed. */
export function firstLine(s: string | undefined): string {
  if (!s) return "";
  const line = s.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.replace(/^[#>\-*+\s]+/, "").replace(/[*_`]/g, "").replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2").trim();
}

export function edgePill(parent: HTMLElement, label: string | undefined): HTMLElement | null {
  if (!label) return null;
  return parent.createSpan({ cls: "fp-pill", text: label });
}

export function optionsLabel(n: number): string {
  return n === 1 ? "1 option" : n + " options";
}

/** The chain root → current, as list and set. */
export function pathInfo(host: FlowHost): { path: string[]; set: Set<string> } {
  const path = pathTo(host.chart, host.current);
  return { path, set: new Set(path) };
}

/** Small icon button that opens the node's note. Clicking never selects the node. */
export function noteButton(parent: HTMLElement, host: FlowHost, node: FlowNode): HTMLElement {
  const b = icon(parent, "file-text", "fp-note-ico");
  b.setAttr("aria-label", host.noteName(node.id) ?? node.note ?? "Open note");
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    host.openNote(node.id, e.ctrlKey || e.metaKey);
  });
  b.addEventListener("dblclick", (e) => e.stopPropagation());
  return b;
}

export function doneMark(parent: HTMLElement): HTMLElement {
  return icon(parent, "check", "fp-done-ico");
}

/** Click selects, double-click opens the note (only on the current node, see note below), right-click menu. */
export function bindNode(el: HTMLElement, host: FlowHost, id: string, opts: { onSelect?: (id: string) => void } = {}): void {
  el.addEventListener("click", (e) => {
    if (e.defaultPrevented) return;
    host.select(id);
    opts.onSelect?.(id);
  });
  // A click may re-render and move things under the cursor before the second click lands,
  // so only act when the double-clicked node is the one that is now current.
  el.addEventListener("dblclick", (e) => {
    if (host.current !== id) return;
    e.preventDefault();
    host.openNote(id, e.ctrlKey || e.metaKey);
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    host.showNodeMenu(id, e);
  });
}

export function prepareRoot(el: HTMLElement, host: FlowHost, mode: string): void {
  el.empty();
  el.addClass("fp-root");
  el.toggleClass("fp-compact", host.compact);
  el.dataset.fpMode = mode;
  if (!host.compact) {
    el.tabIndex = 0;
    const doc = el.ownerDocument;
    const a = doc.activeElement;
    if (!a || a === doc.body || el.contains(a)) el.focus({ preventScroll: true });
  }
}

export function releaseRoot(el: HTMLElement | undefined): void {
  if (!el) return;
  el.removeClass("fp-root");
  el.removeClass("fp-compact");
  delete el.dataset.fpMode;
}

export interface KeyOpts {
  /** Called after a key moved the selection. */
  onSelect?: (id: string) => void;
  /** ArrowLeft also goes to the parent (focus / columns). */
  leftIsParent?: boolean;
  /** View-specific keys first; return true when handled. */
  extra?: (e: KeyboardEvent, cur: string) => boolean;
}

/** Owns one keydown listener on the view element; rebinding replaces it. */
export class Keys {
  private el?: HTMLElement;
  private fn?: (e: KeyboardEvent) => void;

  bind(el: HTMLElement, host: FlowHost, opts: KeyOpts = {}): void {
    this.unbind();
    if (host.compact) return;
    const go = (id: string | undefined): void => {
      if (!id) return;
      host.select(id);
      opts.onSelect?.(id);
    };
    const fn = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const cur = host.current;
      if (opts.extra?.(e, cur)) {
        e.preventDefault();
        return;
      }
      const parent = (): string | undefined => {
        const p = pathTo(host.chart, cur);
        return p.length > 1 ? p[p.length - 2] : undefined;
      };
      let handled = true;
      if (e.key === "Backspace" || e.key === "u" || (opts.leftIsParent && e.key === "ArrowLeft")) go(parent());
      else if (/^[1-9]$/.test(e.key)) go(childrenOf(host.chart, cur)[Number(e.key) - 1]?.node.id);
      else if (e.key === "Enter") host.openNote(cur, false);
      else if (e.key === "a") host.addOption(cur);
      else if (e.key === "F2") host.rename(cur);
      else if (e.key === "x") host.toggleDone(cur);
      else handled = false;
      if (handled) e.preventDefault();
    };
    el.addEventListener("keydown", fn);
    this.el = el;
    this.fn = fn;
  }

  unbind(): void {
    if (this.el && this.fn) this.el.removeEventListener("keydown", this.fn);
    this.el = undefined;
    this.fn = undefined;
  }
}

/** Ids of the options of `parent` (or the other roots when parent is undefined is handled by callers). */
export function optionIds(host: FlowHost, id: string): string[] {
  return childrenOf(host.chart, id).map((l) => l.node.id);
}
