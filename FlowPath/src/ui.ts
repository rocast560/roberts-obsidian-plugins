// Small shared UI bits: view-mode switcher and clipboard.
import { setIcon } from "obsidian";
import type { ViewMode } from "./types";
import { VIEW_MODES } from "./types";

export const MODE_ICONS: Record<ViewMode, string> = {
  map: "workflow",
  focus: "crosshair",
  outline: "list-tree",
  columns: "columns-3",
};

export const MODE_LABELS: Record<ViewMode, string> = {
  map: "Map",
  focus: "Focus",
  outline: "Outline",
  columns: "Columns",
};

export interface ModeSwitcher {
  el: HTMLElement;
  set(mode: ViewMode): void;
}

export function modeSwitcher(parent: HTMLElement, current: ViewMode, onPick: (m: ViewMode) => void, withLabels: boolean): ModeSwitcher {
  const el = parent.createDiv({ cls: "fp-segmented" + (withLabels ? " fp-segmented-labels" : "") });
  const buttons = new Map<ViewMode, HTMLElement>();
  VIEW_MODES.forEach((m, i) => {
    const b = el.createEl("button", { cls: "fp-seg-btn", attr: { "aria-label": `${MODE_LABELS[m]} view (Alt+${i + 1})`, type: "button" } });
    setIcon(b.createSpan({ cls: "fp-seg-icon" }), MODE_ICONS[m]);
    if (withLabels) b.createSpan({ cls: "fp-seg-label", text: MODE_LABELS[m] });
    b.addEventListener("click", () => onPick(m));
    buttons.set(m, b);
  });
  const set = (mode: ViewMode) => {
    for (const [m, b] of buttons) b.toggleClass("is-active", m === mode);
  };
  set(current);
  return { el, set };
}

export async function copyText(el: HTMLElement, text: string): Promise<void> {
  try {
    await el.win.navigator.clipboard.writeText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}
