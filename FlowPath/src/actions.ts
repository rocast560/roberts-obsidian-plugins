// Command flows: creating charts, inserting links and embeds.
import { MarkdownView, Notice, TFile, type Editor } from "obsidian";
import type FlowPathPlugin from "./main";
import type { Chart } from "./types";
import { chartFromOutline, emptyChart, pathTo, serializeChart } from "./model";
import { askNewChart, askOutline, pick } from "./modals";
import { chartFromBetterNote, isBetterNote, uniqueChartPath } from "./betternotes";
import { embedBlock, listBlockAround, nodeMarkdownLink } from "./links";

async function ensureFolderPath(plugin: FlowPathPlugin, folder: string): Promise<void> {
  const parts = folder.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    if (!plugin.app.vault.getAbstractFileByPath(cur)) await plugin.app.vault.createFolder(cur);
  }
}

/** Writes a new chart file at a free path (never overwrites). */
export async function createChartFile(plugin: FlowPathPlugin, folder: string, chart: Chart): Promise<TFile> {
  await ensureFolderPath(plugin, folder);
  const path = uniqueChartPath(plugin.app, folder, chart.title);
  return plugin.app.vault.create(path, serializeChart(chart));
}

function activeFolder(plugin: FlowPathPlugin): string {
  const p = plugin.app.workspace.getActiveFile()?.parent?.path ?? "";
  return p === "/" ? "" : p;
}

export async function newChartFlow(plugin: FlowPathPlugin): Promise<void> {
  const r = await askNewChart(plugin.app, activeFolder(plugin));
  if (!r) return;
  try {
    const file = await createChartFile(plugin, r.folder, emptyChart(r.title));
    await plugin.openNode(file);
  } catch (e) {
    new Notice(`Couldn't create the chart: ${(e as Error)?.message ?? e}`);
  }
}

export async function fromListFlow(plugin: FlowPathPlugin, editor: Editor, note: TFile | null): Promise<void> {
  let text = editor.getSelection();
  let endLine: number;
  if (text.trim()) {
    const to = editor.getCursor("to");
    const from = editor.getCursor("from");
    endLine = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
  } else {
    const lines = editor.getValue().split("\n");
    const blk = listBlockAround(lines, editor.getCursor().line);
    if (!blk) { new Notice("Select a list, or put the cursor inside one."); return; }
    text = lines.slice(blk[0], blk[1] + 1).join("\n");
    endLine = blk[1];
  }
  const r = await askOutline(plugin.app, note?.basename ?? "Flow chart");
  if (!r) return;
  try {
    const chart = chartFromOutline(text, r.title, r.mode);
    const folder = note?.parent?.path && note.parent.path !== "/" ? note.parent.path : "";
    const file = await createChartFile(plugin, folder, chart);
    const block = "\n\n" + embedBlock(file.path) + "\n";
    editor.replaceRange(block, { line: endLine, ch: editor.getLine(endLine).length });
    await plugin.openNode(file);
  } catch (e) {
    new Notice(`Couldn't create the chart: ${(e as Error)?.message ?? e}`);
  }
}

export interface NodeChoice { file: TFile; chart: Chart; id: string; label: string }

export async function allNodeChoices(plugin: FlowPathPlugin): Promise<NodeChoice[]> {
  const out: NodeChoice[] = [];
  for (const { file, chart } of await plugin.store.allCharts()) {
    for (const id of Object.keys(chart.nodes)) {
      const trail = pathTo(chart, id).map((x) => chart.nodes[x]?.title ?? "?");
      // "Chart › Parent › Node": drop the root title when it just repeats the chart title
      const parts = trail[0] === chart.title ? trail : [chart.title, ...trail];
      const shown = parts.length > 4 ? [parts[0], "…", ...parts.slice(-2)] : parts;
      out.push({ file, chart, id, label: shown.join(" › ") });
    }
  }
  return out;
}

export async function insertNodeLinkFlow(plugin: FlowPathPlugin, editor: Editor): Promise<void> {
  const choices = await allNodeChoices(plugin);
  if (!choices.length) { new Notice("No flow charts yet."); return; }
  const c = await pick(plugin.app, choices, (x) => x.label, "Link to which node?");
  if (!c) return;
  editor.replaceSelection(nodeMarkdownLink(plugin.app.vault.getName(), c.chart.id, c.file.path, c.id, c.chart.nodes[c.id].title));
}

export async function pickChart(plugin: FlowPathPlugin, placeholder: string): Promise<TFile | null> {
  const files = plugin.store.chartFiles();
  if (!files.length) { new Notice("No flow charts yet."); return null; }
  return pick(plugin.app, files, (f) => f.path.replace(/\.flowpath$/, ""), placeholder);
}

export async function embedFlow(plugin: FlowPathPlugin, editor: Editor): Promise<void> {
  const f = await pickChart(plugin, "Embed which chart?");
  if (!f) return;
  editor.replaceSelection(embedBlock(f.path) + "\n");
}

export async function openChartFlow(plugin: FlowPathPlugin): Promise<void> {
  const f = await pickChart(plugin, "Open which chart?");
  if (f) await plugin.openNode(f);
}

export async function buildFromBetterNote(plugin: FlowPathPlugin): Promise<void> {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  const file = view?.file ?? plugin.app.workspace.getActiveFile();
  if (!file || file.extension !== "md" || !isBetterNote(file)) {
    new Notice("Open a BetterNote first (a note X inside its own folder X).");
    return;
  }
  try {
    const chart = chartFromBetterNote(plugin.app, file);
    const folder = file.parent!.path === "/" ? "" : file.parent!.path;
    const f = await createChartFile(plugin, folder, chart);
    new Notice(`Built ${f.name} with ${Object.keys(chart.nodes).length} nodes.`);
    await plugin.openNode(f);
  } catch (e) {
    new Notice(`Couldn't build the chart: ${(e as Error)?.message ?? e}`);
  }
}
