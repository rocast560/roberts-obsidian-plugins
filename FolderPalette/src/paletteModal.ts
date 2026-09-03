import { App, FuzzyMatch, FuzzySuggestModal, renderMatches } from "obsidian";
import { PALETTES, Palette } from "./palettes";
import { renderSwatchStrip } from "./swatches";

/** Command palette helper: pick a palette to apply to every top-level folder. */
export class PaletteSuggestModal extends FuzzySuggestModal<Palette> {
  constructor(app: App, private readonly onPick: (palette: Palette) => void) {
    super(app);
    this.setPlaceholder("Choose a palette to apply to all folders");
  }

  getItems(): Palette[] {
    return PALETTES;
  }

  getItemText(palette: Palette): string {
    return palette.name;
  }

  renderSuggestion(item: FuzzyMatch<Palette>, el: HTMLElement): void {
    const title = el.createDiv();
    renderMatches(title, item.item.name, item.match.matches);
    title.appendText(` · ${item.item.colors.length} colors`);
    renderSwatchStrip(el.createDiv({ cls: "fp-strip fp-strip-mini" }), item.item, null, null);
  }

  onChooseItem(palette: Palette): void {
    this.onPick(palette);
  }
}
