// ChartStore: single source of truth for .flowpath files, shared by every view and embed.
import { Notice, TAbstractFile, TFile, type App, type EventRef } from "obsidian";
import type { Chart } from "./types";
import { parseChart, serializeChart } from "./model";

export type StoreEventKind = "change" | "rename" | "delete";
export type StoreListener = (path: string, kind: StoreEventKind) => void;

export class ChartStore {
  private cache = new Map<string, Chart>();
  /** Paths whose last read failed to parse. Never written to until they parse again. */
  private broken = new Set<string>();
  private warned = new Set<string>();
  private lastWritten = new Map<string, string>();
  private subs = new Map<string, Set<StoreListener>>();
  private pending = new Map<string, Promise<Chart>>();
  private refs: EventRef[] = [];

  constructor(private app: App) {}

  /** Start listening to the vault. Returns refs for the plugin to register. */
  attach(register: (ref: EventRef) => void): void {
    const v = this.app.vault;
    this.refs = [
      v.on("modify", (f) => void this.onModify(f)),
      v.on("rename", (f, old) => this.onRename(f, old)),
      v.on("delete", (f) => this.onDelete(f)),
    ];
    this.refs.forEach(register);
  }

  static isChartFile(f: TAbstractFile | null | undefined): f is TFile {
    return f instanceof TFile && f.extension === "flowpath";
  }

  isBroken(file: TFile): boolean {
    return this.broken.has(file.path);
  }

  /** Cached chart without reading, or undefined. */
  peek(file: TFile): Chart | undefined {
    return this.cache.get(file.path);
  }

  async get(file: TFile): Promise<Chart> {
    const hit = this.cache.get(file.path);
    if (hit) return hit;
    const running = this.pending.get(file.path);
    if (running) return running;
    const p = (async () => {
      const text = await this.app.vault.read(file);
      try {
        const chart = parseChart(text, file.basename);
        this.cache.set(file.path, chart);
        this.broken.delete(file.path);
        this.warned.delete(file.path);
        return chart;
      } catch (e) {
        this.markBroken(file, e);
        throw e;
      }
    })();
    this.pending.set(file.path, p);
    try {
      return await p;
    } finally {
      this.pending.delete(file.path);
    }
  }

  private markBroken(file: TFile, e: unknown): void {
    this.broken.add(file.path);
    this.cache.delete(file.path);
    if (!this.warned.has(file.path)) {
      this.warned.add(file.path);
      new Notice(`FlowPath: can't read ${file.name} (${(e as Error)?.message ?? e}). The file is left untouched until it parses again.`, 8000);
    }
  }

  /** Writes the chart. Refuses (returns false) if the file is currently unparseable. */
  async save(file: TFile, chart: Chart): Promise<boolean> {
    if (this.broken.has(file.path)) {
      new Notice(`FlowPath: ${file.name} has a parse error, not saving over it. Fix the file first.`);
      return false;
    }
    const text = serializeChart(chart);
    this.cache.set(file.path, chart);
    this.lastWritten.set(file.path, text);
    this.notify(file.path, "change");
    try {
      await this.app.vault.modify(file, text);
      return true;
    } catch (e) {
      new Notice(`FlowPath: couldn't save ${file.name}: ${(e as Error)?.message ?? e}`);
      return false;
    }
  }

  subscribe(path: string, cb: StoreListener): () => void {
    let set = this.subs.get(path);
    if (!set) this.subs.set(path, (set = new Set()));
    set.add(cb);
    // the path may be re-keyed by a rename, so look the set up by identity on removal
    return () => {
      for (const [k, s] of this.subs) {
        if (s.delete(cb) && s.size === 0) this.subs.delete(k);
      }
    };
  }

  private notify(path: string, kind: StoreEventKind): void {
    const set = this.subs.get(path);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(path, kind);
      } catch (e) {
        console.error("FlowPath listener failed", e);
      }
    }
  }

  private async onModify(f: TAbstractFile): Promise<void> {
    if (!ChartStore.isChartFile(f)) return;
    let text: string;
    try {
      text = await this.app.vault.read(f);
    } catch {
      return;
    }
    if (this.lastWritten.get(f.path) === text) return; // our own write
    try {
      const chart = parseChart(text, f.basename);
      this.cache.set(f.path, chart);
      this.broken.delete(f.path);
      this.warned.delete(f.path);
      this.lastWritten.delete(f.path);
      this.notify(f.path, "change");
    } catch (e) {
      this.markBroken(f, e);
      this.notify(f.path, "change");
    }
  }

  private onRename(f: TAbstractFile, oldPath: string): void {
    if (!ChartStore.isChartFile(f)) return;
    const move = <T>(m: Map<string, T>) => {
      if (m.has(oldPath)) {
        m.set(f.path, m.get(oldPath)!);
        m.delete(oldPath);
      }
    };
    move(this.cache);
    move(this.lastWritten);
    move(this.subs);
    if (this.broken.delete(oldPath)) this.broken.add(f.path);
    if (this.warned.delete(oldPath)) this.warned.add(f.path);
    this.notify(f.path, "rename");
  }

  private onDelete(f: TAbstractFile): void {
    if (!(f instanceof TFile) || f.extension !== "flowpath") return;
    this.cache.delete(f.path);
    this.broken.delete(f.path);
    this.lastWritten.delete(f.path);
    this.notify(f.path, "delete");
  }

  chartFiles(): TFile[] {
    return this.app.vault.getFiles().filter((f) => f.extension === "flowpath");
  }

  async allCharts(): Promise<{ file: TFile; chart: Chart }[]> {
    const out: { file: TFile; chart: Chart }[] = [];
    for (const file of this.chartFiles()) {
      try {
        out.push({ file, chart: await this.get(file) });
      } catch {
        /* unreadable charts are skipped; a notice was already shown */
      }
    }
    return out;
  }

  async findById(chartId: string): Promise<TFile | null> {
    for (const { file, chart } of await this.allCharts()) if (chart.id === chartId) return file;
    return null;
  }
}
