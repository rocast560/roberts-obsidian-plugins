import { isHex } from "./hex";

export interface FolderColorEntry {
  path: string;
  color: string;
}

export interface CssOptions {
  /** Also color `.nav-file-title` rows inside the folder. */
  colorFiles: boolean;
}

/** Escape a string for use inside a double-quoted CSS attribute selector. */
export function escapeAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Selects a top-level folder in the file explorer by its data-path. Same
 * shape as the bruh.css snippet, with a leading `body` so these rules win
 * over the snippet's equal-specificity rules regardless of load order.
 */
export function folderSelector(path: string): string {
  return `body .nav-files-container > div > .nav-folder:has(> .nav-folder-title[data-path="${escapeAttr(path)}"])`;
}

/** Build the whole stylesheet. Entries with invalid colors are skipped. */
export function buildCss(entries: FolderColorEntry[], opts: CssOptions): string {
  const rules: string[] = [];
  for (const { path, color } of entries) {
    if (!isHex(color)) continue;
    const sel = folderSelector(path);
    rules.push(`${sel} { --folder-color: ${color}; }`);
    rules.push(`${sel} > .nav-folder-title { color: var(--folder-color); }`);
    if (opts.colorFiles) {
      rules.push(`${sel} .nav-file-title { color: var(--folder-color); }`);
    }
  }
  return rules.join("\n");
}
