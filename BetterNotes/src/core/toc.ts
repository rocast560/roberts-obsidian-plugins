// Pure logic for the sub-note table of contents. No Obsidian imports — unit-testable.
import { ATTACHMENTS_DIR, basename } from "./pairing";

export const TOC_START = "%% betternotes-toc:start %%";
export const TOC_END = "%% betternotes-toc:end %%";

export interface TocEntry { folderPath: string; depth: number }

/** Depth-first list of sub-betternote folders, siblings alphabetical. Plain folders are not descended into. */
export function tocEntries(
  rootFolderPath: string,
  childFoldersOf: (folderPath: string) => string[],
  isBetterNote: (folderPath: string) => boolean,
  depth = 0,
): TocEntry[] {
  const children = childFoldersOf(rootFolderPath)
    .filter((p) => basename(p) !== ATTACHMENTS_DIR && isBetterNote(p))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
  const entries: TocEntry[] = [];
  for (const child of children) {
    entries.push({ folderPath: child, depth });
    entries.push(...tocEntries(child, childFoldersOf, isBetterNote, depth + 1));
  }
  return entries;
}

export function renderTocBlock(items: { link: string; depth: number }[]): string {
  const lines = items.map((i) => `${"    ".repeat(i.depth)}- ${i.link}`);
  return [TOC_START, ...lines, TOC_END].join("\n");
}

/** Offsets spanning an existing toc block, markers inclusive, or null if there isn't a complete one. */
export function findTocBlock(content: string): { from: number; to: number } | null {
  const from = content.indexOf(TOC_START);
  if (from === -1) return null;
  const endIdx = content.indexOf(TOC_END, from + TOC_START.length);
  if (endIdx === -1) return null;
  return { from, to: endIdx + TOC_END.length };
}
