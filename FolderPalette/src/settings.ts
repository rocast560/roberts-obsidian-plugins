import type { ColorMap } from "./assign";
import { isHex } from "./hex";

export interface FolderPaletteSettings {
  /** Palette selected in the settings UI (used for swatches + "apply to all"). */
  paletteId: string;
  /** Top-level folder path → "#rrggbb". */
  folderColors: ColorMap;
  /** Also color note titles inside each colored folder. */
  colorFiles: boolean;
  /** Show the native collapse chevron on folder rows in the file explorer. */
  showCollapseArrows: boolean;
  /** Draw a colored line from each folder down through its children, with an elbow into each child. */
  treeLines: boolean;
}

export const DEFAULT_SETTINGS: FolderPaletteSettings = {
  paletteId: "muted-rainbow",
  folderColors: {},
  colorFiles: true,
  showCollapseArrows: true,
  treeLines: true,
};

/** Coerce whatever loadData() returned into a valid settings object. */
export function normalizeSettings(raw: unknown): FolderPaletteSettings {
  const out: FolderPaletteSettings = { ...DEFAULT_SETTINGS, folderColors: {} };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;

  if (typeof r.paletteId === "string" && r.paletteId.length > 0) out.paletteId = r.paletteId;
  if (typeof r.colorFiles === "boolean") out.colorFiles = r.colorFiles;
  if (typeof r.showCollapseArrows === "boolean") out.showCollapseArrows = r.showCollapseArrows;
  if (typeof r.treeLines === "boolean") out.treeLines = r.treeLines;

  const fc = r.folderColors;
  if (fc && typeof fc === "object" && !Array.isArray(fc)) {
    for (const [path, color] of Object.entries(fc as Record<string, unknown>)) {
      if (path.length > 0 && isHex(color)) out.folderColors[path] = color;
    }
  }
  return out;
}
