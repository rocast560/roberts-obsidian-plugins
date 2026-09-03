import type { Palette } from "./palettes";

/**
 * Render one swatch per palette color into `container`. Returns hex → element
 * so callers can re-mark the selected swatch without rebuilding the strip.
 */
export function renderSwatchStrip(
  container: HTMLElement,
  palette: Palette,
  selected: string | null,
  onPick: ((hex: string) => void) | null
): Map<string, HTMLElement> {
  const swatches = new Map<string, HTMLElement>();
  const sel = selected?.toLowerCase() ?? null;
  for (const color of palette.colors) {
    const label = `${color.name} ${color.hex}`;
    const el = container.createEl(onPick ? "button" : "span", {
      cls: "fp-swatch",
      attr: { "aria-label": label, title: label, type: "button" },
    });
    el.style.setProperty("--fp-color", color.hex);
    if (sel !== null && color.hex.toLowerCase() === sel) el.addClass("is-selected");
    if (onPick) {
      el.addEventListener("click", (evt) => {
        evt.preventDefault();
        onPick(color.hex);
      });
    }
    swatches.set(color.hex, el);
  }
  return swatches;
}

/** Re-mark which swatch is selected. `selected` null clears all marks. */
export function markSelected(swatches: Map<string, HTMLElement>, selected: string | null): void {
  const sel = selected?.toLowerCase() ?? null;
  for (const [hex, el] of swatches) {
    el.toggleClass("is-selected", sel !== null && hex.toLowerCase() === sel);
  }
}
