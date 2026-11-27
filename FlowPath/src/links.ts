// Pure helpers: node links, embed source parsing, note-body cleanup, names. No Obsidian imports.
import type { ViewMode } from "./types";
import { VIEW_MODES } from "./types";

/** encodeURIComponent plus the characters that would break a markdown link target. */
function enc(s: string): string {
  return encodeURIComponent(s).replace(/[()!'*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export const NODE_URI_PREFIX = "obsidian://flowpath";

export function nodeUri(vaultName: string, chartId: string, filePath: string, nodeId: string): string {
  return `${NODE_URI_PREFIX}?vault=${enc(vaultName)}&chart=${enc(chartId)}&file=${enc(filePath)}&node=${enc(nodeId)}`;
}

/** Markdown link whose text is the node title. */
export function nodeMarkdownLink(vaultName: string, chartId: string, filePath: string, nodeId: string, title: string): string {
  return `[${escapeLinkText(title)}](${nodeUri(vaultName, chartId, filePath, nodeId)})`;
}

export function escapeLinkText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/\s+/g, " ").trim();
}

export interface ParsedNodeUri {
  vault?: string;
  chart?: string;
  file?: string;
  node?: string;
  mode?: ViewMode;
}

export function isNodeUri(href: string | null | undefined): boolean {
  return !!href && href.startsWith(NODE_URI_PREFIX) && /^obsidian:\/\/flowpath(\?|$)/.test(href);
}

export function parseNodeUri(href: string): ParsedNodeUri | null {
  if (!isNodeUri(href)) return null;
  const q = href.indexOf("?");
  const params = new URLSearchParams(q === -1 ? "" : href.slice(q + 1));
  const out: ParsedNodeUri = {};
  const get = (k: string) => params.get(k) ?? undefined;
  out.vault = get("vault");
  out.chart = get("chart");
  out.file = get("file");
  out.node = get("node");
  const mode = get("mode");
  if (mode && (VIEW_MODES as string[]).includes(mode)) out.mode = mode as ViewMode;
  return out;
}

/** The flow node URI under column `ch` of a Markdown line: inside [text](uri), <uri> or a bare uri. */
export function nodeUriAt(line: string, ch: number): string | null {
  const re = /\[(?:\\.|[^\]\\])*\]\((obsidian:\/\/flowpath(?:\?[^)\s]*)?)\)|<(obsidian:\/\/flowpath(?:\?[^>\s]*)?)>|(obsidian:\/\/flowpath(?:\?[^\s)>\]]*)?)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (ch >= m.index && ch <= m.index + m[0].length) return m[1] ?? m[2] ?? m[3] ?? null;
  }
  return null;
}

export interface EmbedSpec {
  chart?: string;
  node?: string;
  view: ViewMode;
  height: number;
}

export const DEFAULT_EMBED_HEIGHT = 420;

/** Body of a ```flowpath block: `key: value` lines. Unknown keys are ignored. */
export function parseEmbedSource(src: string): EmbedSpec {
  const spec: EmbedSpec = { view: "map", height: DEFAULT_EMBED_HEIGHT };
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let val = m[2];
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
    if (key === "chart" && val) spec.chart = val.replace(/^\[\[(.*)\]\]$/, "$1").split("|")[0];
    else if (key === "node" && val) spec.node = val;
    else if (key === "view" && (VIEW_MODES as string[]).includes(val.toLowerCase())) spec.view = val.toLowerCase() as ViewMode;
    else if (key === "height") {
      const n = parseInt(val, 10);
      if (Number.isFinite(n) && n >= 120) spec.height = Math.min(n, 2000);
    }
  }
  return spec;
}

export function embedBlock(chartPath: string, opts: { node?: string; view?: ViewMode; height?: number } = {}): string {
  const lines = ["```flowpath", `chart: ${chartPath}`];
  if (opts.node) lines.push(`node: ${opts.node}`);
  if (opts.view && opts.view !== "map") lines.push(`view: ${opts.view}`);
  if (opts.height && opts.height !== DEFAULT_EMBED_HEIGHT) lines.push(`height: ${opts.height}`);
  lines.push("```");
  return lines.join("\n");
}

/** The backlink callout line FlowPath writes at the top of notes it creates. */
export const FLOWPATH_LINE = /^>\s*\[!flowpath\][^\n]*\n?/m;

export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "");
}

/** Note text for a node's preview: no frontmatter, no FlowPath backlink line, trimmed. */
export function noteBody(text: string): string {
  return stripFrontmatter(text).replace(FLOWPATH_LINE, "").trim();
}

/** Cuts at the last line boundary within maxChars (keeps whole text if shorter). */
export function truncateAtLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf("\n");
  return (nl > maxChars * 0.4 ? cut.slice(0, nl) : cut).trimEnd() + "\n\n…";
}

/** Safe file/folder name: strips \ / : * ? " < > | # ^ [ ]. */
export function sanitizeName(s: string): string {
  const out = s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  return out || "Untitled";
}

/** First free path: desired, then "name 2.ext", "name 3.ext"... Never returns an existing path. */
export function uniquePath(desired: string, exists: (p: string) => boolean): string {
  if (!exists(desired)) return desired;
  const slash = desired.lastIndexOf("/");
  const dot = desired.lastIndexOf(".");
  const hasExt = dot > slash;
  const stem = hasExt ? desired.slice(0, dot) : desired;
  const ext = hasExt ? desired.slice(dot) : "";
  for (let n = 2; ; n++) {
    const cand = `${stem} ${n}${ext}`;
    if (!exists(cand)) return cand;
  }
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** Finds the list block around a line (list items and their indented continuation), as [start, end] line numbers. */
export function listBlockAround(lines: string[], at: number): [number, number] | null {
  const isItem = (l: string) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const isCont = (l: string) => /^\s+\S/.test(l);
  const ok = (l: string | undefined) => l !== undefined && (isItem(l) || isCont(l));
  if (!ok(lines[at])) return null;
  let s = at;
  let e = at;
  while (s > 0 && ok(lines[s - 1])) s--;
  while (e < lines.length - 1 && ok(lines[e + 1])) e++;
  if (!lines.slice(s, e + 1).some(isItem)) return null;
  return [s, e];
}
