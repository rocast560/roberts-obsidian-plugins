// BetterNotes integration: a BetterNote is a folder X/ holding X/X.md.
// Nothing here overwrites or deletes an existing note.
import { TFile, TFolder, normalizePath, type App } from "obsidian";
import type FlowPathPlugin from "./main";
import type { Chart, FlowNode } from "./types";
import { addChild, emptyChart, spanningTree } from "./model";
import { joinPath, nodeMarkdownLink, sanitizeName, uniquePath } from "./links";

export type NoteOutcome = "created" | "linked" | "skipped";

/** Resolves node.note (vault path or linkpath, optionally [[wrapped]]) to a file. */
export function resolveNoteFile(app: App, chartPath: string, note: string | undefined): TFile | null {
  if (!note) return null;
  const ref = note.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0].trim();
  if (!ref) return null;
  for (const p of [ref, ref + ".md"]) {
    const f = app.vault.getAbstractFileByPath(normalizePath(p));
    if (f instanceof TFile) return f;
  }
  return app.metadataCache.getFirstLinkpathDest(ref, chartPath);
}

export function isBetterNote(f: TFile): boolean {
  return f.extension === "md" && !!f.parent && f.parent.name === f.basename;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = joinPath(cur, p);
    const ex = app.vault.getAbstractFileByPath(cur);
    if (!ex) await app.vault.createFolder(cur);
    else if (!(ex instanceof TFolder)) throw new Error(`${cur} exists and is not a folder`);
  }
}

function noteContent(plugin: FlowPathPlugin, chartFile: TFile, chart: Chart, node: FlowNode): string {
  const link = nodeMarkdownLink(plugin.app.vault.getName(), chart.id, chartFile.path, node.id, `↗ ${node.title} in ${chart.title}`);
  return `> [!flowpath] ${link}\n\n${node.desc ? node.desc.trim() + "\n" : ""}`;
}

/** Create (or link the existing) note X/X.md inside `baseFolder` for the node. */
async function makeNote(plugin: FlowPathPlugin, chartFile: TFile, chart: Chart, node: FlowNode, folder: string, name: string): Promise<NoteOutcome> {
  const app = plugin.app;
  const path = joinPath(folder, `${name}.md`);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    node.note = existing.path;
    return "linked";
  }
  if (existing) throw new Error(`${path} exists and is not a note`);
  await ensureFolder(app, folder);
  await app.vault.create(path, noteContent(plugin, chartFile, chart, node));
  node.note = path;
  return "created";
}

/**
 * The chart's home folder: the BetterNote the .flowpath file sits in (folder F with F/F.md),
 * otherwise "<chart folder>/<chart title>/" next to the file.
 */
function chartHome(plugin: FlowPathPlugin, chartFile: TFile, chart: Chart): string {
  const parent = chartFile.parent;
  const parentPath = parent && parent.path !== "/" ? parent.path : "";
  if (parent && parentPath) {
    const inner = plugin.app.vault.getAbstractFileByPath(joinPath(parentPath, `${parent.name}.md`));
    if (inner instanceof TFile) return parentPath;
  }
  return joinPath(parentPath, sanitizeName(chart.title));
}

function folderName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function parentFolder(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** "next", "next phase", "next step"...: sequence edges, whose target is a sibling step rather than a sub-option. */
function isSequenceLabel(label: string | undefined): boolean {
  return !!label && /^next\b/i.test(label.trim());
}

/**
 * Folder that holds the root node's BetterNote; makes the root's note if it has none.
 * The root is the home BetterNote itself when their names match, otherwise a BetterNote inside home.
 */
async function rootBase(plugin: FlowPathPlugin, chartFile: TFile, chart: Chart): Promise<{ folder: string; outcome: NoteOutcome | null }> {
  const root = chart.nodes[chart.root];
  const rf = resolveNoteFile(plugin.app, chartFile.path, root.note);
  if (rf && isBetterNote(rf)) return { folder: rf.parent!.path, outcome: null };
  const home = chartHome(plugin, chartFile, chart);
  const name = sanitizeName(root.title);
  const folder = name === folderName(home) ? home : joinPath(home, name);
  if (!rf) return { folder, outcome: await makeNote(plugin, chartFile, chart, root, folder, name) };
  return { folder, outcome: null };
}

/** Creates (or links) the BetterNote for one node. Mutates `chart` in place; caller saves. */
export async function createNoteForNode(plugin: FlowPathPlugin, chartFile: TFile, chart: Chart, nodeId: string): Promise<NoteOutcome> {
  const node = chart.nodes[nodeId];
  if (!node) return "skipped";
  if (resolveNoteFile(plugin.app, chartFile.path, node.note)) return "skipped";
  if (nodeId === chart.root) {
    const b = await rootBase(plugin, chartFile, chart);
    return b.outcome ?? "skipped";
  }
  const parentId = spanningTree(chart).parent.get(nodeId);
  let base: string | null = null;
  // a "next phase" step sits beside its predecessor instead of inside it, so a
  // sequence of steps doesn't turn into one folder nested six levels deep
  const sequence = !!parentId && isSequenceLabel(chart.edges.find((e) => e.from === parentId && e.to === nodeId)?.label);
  if (parentId) {
    const pf = resolveNoteFile(plugin.app, chartFile.path, chart.nodes[parentId]?.note);
    if (pf && isBetterNote(pf)) {
      const pFolder = pf.parent!.path;
      base = sequence && pFolder !== chartHome(plugin, chartFile, chart) ? parentFolder(pFolder) : pFolder;
    }
  }
  if (base === null) {
    const rootFolder = (await rootBase(plugin, chartFile, chart)).folder;
    base = sequence && rootFolder !== chartHome(plugin, chartFile, chart) ? parentFolder(rootFolder) : rootFolder;
  }
  const name = sanitizeName(node.title);
  return makeNote(plugin, chartFile, chart, node, joinPath(base, name), name);
}

export async function createNoteAndSave(plugin: FlowPathPlugin, chartFile: TFile, chart: Chart, nodeId: string): Promise<NoteOutcome> {
  const out = await createNoteForNode(plugin, chartFile, chart, nodeId);
  if (out !== "skipped") await plugin.store.save(chartFile, chart);
  return out;
}

/** BFS from the root so folders nest like the chart. Saves once at the end. */
export async function createNotesForAll(plugin: FlowPathPlugin, chartFile: TFile, chart: Chart): Promise<{ created: number; linked: number; skipped: number; failed: number }> {
  const sp = spanningTree(chart);
  const counts = { created: 0, linked: 0, skipped: 0, failed: 0 };
  const queue = [...sp.roots];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      counts[await createNoteForNode(plugin, chartFile, chart, id)]++;
    } catch (e) {
      console.error("FlowPath: note creation failed for", chart.nodes[id]?.title, e);
      counts.failed++;
    }
    queue.push(...(sp.kids.get(id) ?? []));
  }
  await plugin.store.save(chartFile, chart);
  return counts;
}

/** Chart from a BetterNote: the note is the root, sub-BetterNotes and plain notes below it are nodes. */
export function chartFromBetterNote(app: App, file: TFile): Chart {
  const chart = emptyChart(file.basename);
  const root = chart.nodes[chart.root];
  root.note = file.path;
  const walk = (folder: TFolder, parentId: string, selfPath: string) => {
    const kids = [...folder.children].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    for (const k of kids) {
      if (k instanceof TFolder) {
        if (k.name === "Attachments") continue;
        const inner = app.vault.getAbstractFileByPath(joinPath(k.path, `${k.name}.md`));
        if (!(inner instanceof TFile)) continue;
        const n = addChild(chart, parentId, k.name);
        n.note = inner.path;
        walk(k, n.id, inner.path);
      } else if (k instanceof TFile && k.extension === "md" && k.path !== selfPath) {
        const n = addChild(chart, parentId, k.basename);
        n.note = k.path;
      }
    }
  };
  if (file.parent) walk(file.parent, chart.root, file.path);
  return chart;
}

export function uniqueChartPath(app: App, folder: string, title: string): string {
  const base = joinPath(folder === "/" ? "" : folder, `${sanitizeName(title)}.flowpath`);
  return uniquePath(base, (p) => !!app.vault.getAbstractFileByPath(p));
}
