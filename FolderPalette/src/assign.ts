import type { Palette } from "./palettes";

/** Top-level folder path → "#rrggbb". */
export type ColorMap = Record<string, string>;

/** Alphabetical, case-insensitive, numeric-aware — the explorer's default order. */
export function sortFolderNames(names: string[]): string[] {
  return [...names].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
  );
}

/** names[i] gets colors[i % n]. Pass names already sorted. */
export function assignPalette(sortedNames: string[], palette: Palette): ColorMap {
  const out: ColorMap = {};
  const n = palette.colors.length;
  if (n === 0) return out;
  sortedNames.forEach((name, i) => {
    out[name] = palette.colors[i % n].hex;
  });
  return out;
}

export function renameKey(map: ColorMap, oldKey: string, newKey: string): ColorMap {
  if (!(oldKey in map)) return { ...map };
  const { [oldKey]: color, ...rest } = map;
  return { ...rest, [newKey]: color };
}

export function dropKey(map: ColorMap, key: string): ColorMap {
  const { [key]: _dropped, ...rest } = map;
  return rest;
}
