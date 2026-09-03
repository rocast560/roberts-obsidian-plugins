// Pure path math for BetterNotes. No Obsidian imports — unit-testable.
export type Exists = (path: string) => boolean;

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function join(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

export function noteNameForFolder(folderPath: string): string {
  return `${folderPath}/${basename(folderPath)}.md`;
}

export function folderForInnerNote(notePath: string): string | null {
  if (!notePath.endsWith(".md")) return null;
  const dir = dirname(notePath);
  if (dir === "") return null;
  return basename(notePath) === `${basename(dir)}.md` ? dir : null;
}

export function collisionFree(desired: string, exists: Exists): string {
  if (!exists(desired)) return desired;
  for (let n = 1; ; n++) {
    const candidate = `${desired} ${n}`;
    if (!exists(candidate)) return candidate;
  }
}

export function collisionFreeFile(desiredPath: string, exists: Exists): string {
  if (!exists(desiredPath)) return desiredPath;
  const dot = desiredPath.lastIndexOf(".");
  const stem = dot === -1 ? desiredPath : desiredPath.slice(0, dot);
  const ext = dot === -1 ? "" : desiredPath.slice(dot);
  for (let n = 1; ; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

export interface RenameOp { from: string; to: string }

/** After a folder rename oldPath -> newPath, the op keeping its inner note in sync. */
export function folderRenameSync(oldPath: string, newPath: string, exists: Exists): RenameOp | null {
  const oldName = basename(oldPath);
  const newName = basename(newPath);
  if (oldName === newName) return null; // pure move — pairing survives untouched
  const carried = `${newPath}/${oldName}.md`;
  if (!exists(carried)) return null; // wasn't a betternote
  const target = `${newPath}/${newName}.md`;
  if (exists(target)) return null; // collision — leave unpaired rather than clobber
  return { from: carried, to: target };
}

/** After a note rename oldPath -> newPath, the op keeping its folder in sync. */
export function noteRenameSync(oldPath: string, newPath: string, exists: Exists): RenameOp | null {
  const oldFolder = folderForInnerNote(oldPath);
  if (oldFolder === null) return null;
  if (!newPath.endsWith(".md")) return null;
  if (dirname(newPath) !== oldFolder) return null; // moved out — unpair
  const newBase = basename(newPath).slice(0, -3);
  const target = join(dirname(oldFolder), newBase);
  if (exists(target)) return null;
  return { from: oldFolder, to: target };
}

export interface ConvertPlan { folder: string; createFolder: boolean; noteTo: string }

export function convertPlan(notePath: string, exists: Exists): ConvertPlan | null {
  if (!notePath.endsWith(".md")) return null;
  if (folderForInnerNote(notePath) !== null) return null;
  const dir = dirname(notePath);
  const base = basename(notePath).slice(0, -3);
  const natural = join(dir, base);
  if (exists(natural) && !exists(noteNameForFolder(natural))) {
    return { folder: natural, createFolder: false, noteTo: noteNameForFolder(natural) };
  }
  const folder = collisionFree(natural, exists);
  return { folder, createFolder: true, noteTo: noteNameForFolder(folder) };
}

export interface FlattenPlan { noteTo: string; deleteFolder: boolean }

export function flattenPlan(folderPath: string, childPaths: string[], exists: Exists): FlattenPlan | null {
  const inner = noteNameForFolder(folderPath);
  if (!childPaths.includes(inner)) return null;
  const desired = join(dirname(folderPath), `${basename(folderPath)}.md`);
  return {
    noteTo: collisionFreeFile(desired, exists),
    deleteFolder: childPaths.length === 1,
  };
}

export function newBetterNotePlan(parentPath: string, exists: Exists): { folder: string; note: string } {
  const folder = collisionFree(join(parentPath, "Untitled"), exists);
  return { folder, note: noteNameForFolder(folder) };
}

export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

export const ATTACHMENTS_DIR = "Attachments";

export function attachmentsFolderFor(folderPath: string): string {
  return `${folderPath}/${ATTACHMENTS_DIR}`;
}
