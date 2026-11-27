import { Menu, Notice, Plugin, TFile, TFolder, debounce, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import { FlowView, VIEW_TYPE } from "./flowView";
import { ChartStore } from "./store";
import { registerEmbed } from "./embed";
import { DEFAULT_SETTINGS, FlowPathSettingTab, type FlowPathData, type FlowPathSettings, type SavedMapState } from "./settings";
import type { MapState } from "./host";
import type { ViewMode } from "./types";
import { VIEW_MODES } from "./types";
import { isNodeUri, nodeUriAt, parseNodeUri } from "./links";
import { resolveNode } from "./model";
import { buildFromBetterNote, embedFlow, fromListFlow, insertNodeLinkFlow, newChartFlow, openChartFlow } from "./actions";

/** newTab: always a fresh tab in the main Obsidian window (beats newWindow and the setting). */
export interface OpenOpts { mode?: ViewMode; newWindow?: boolean; newTab?: boolean }

/** True if the menu already has an item with this title (e.g. Obsidian's own "Open in new tab"). */
function hasMenuItem(menu: Menu, title: string): boolean {
  const items = (menu as unknown as { items?: { titleEl?: HTMLElement }[] }).items;
  return !!items?.some((i) => i.titleEl?.textContent === title);
}

export default class FlowPathPlugin extends Plugin {
  settings: FlowPathSettings = { ...DEFAULT_SETTINGS };
  mapStates: Record<string, SavedMapState> = {};
  modes: Record<string, ViewMode> = {};
  store!: ChartStore;
  private saveSoon = debounce(() => void this.saveAll(), 1000, true);

  async onload(): Promise<void> {
    await this.loadAll();
    this.store = new ChartStore(this.app);
    this.store.attach((ref) => this.registerEvent(ref));

    this.registerView(VIEW_TYPE, (leaf) => new FlowView(leaf, this));
    this.registerExtensions(["flowpath"], VIEW_TYPE);
    this.addSettingTab(new FlowPathSettingTab(this.app, this));
    registerEmbed(this);

    this.registerObsidianProtocolHandler("flowpath", (params) => void this.handleParams(params));
    this.registerLinkClicks(document);
    this.registerEvent(this.app.workspace.on("window-open", (_w, win) => this.registerLinkClicks(win.document)));

    this.registerEvent(this.app.vault.on("rename", (f, old) => this.onRename(f, old)));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      if (f instanceof TFile && f.extension === "flowpath") {
        delete this.mapStates[f.path];
        delete this.modes[f.path];
        this.saveSoon();
      }
    }));

    this.addRibbonIcon("git-fork", "Open flow chart", () => void openChartFlow(this));

    this.addCommand({ id: "new-chart", name: "New flow chart…", callback: () => void newChartFlow(this) });
    this.addCommand({
      id: "chart-from-list",
      name: "New flow chart from selected list",
      editorCallback: (editor, ctx) => void fromListFlow(this, editor, ctx.file),
    });
    this.addCommand({ id: "insert-node-link", name: "Insert link to flow node", editorCallback: (editor) => void insertNodeLinkFlow(this, editor) });
    this.addCommand({ id: "embed-chart", name: "Embed flow chart", editorCallback: (editor) => void embedFlow(this, editor) });
    this.addCommand({ id: "open-chart", name: "Open flow chart", callback: () => void openChartFlow(this) });
    this.addCommand({ id: "chart-from-betternote", name: "Build flow chart from this BetterNote", callback: () => void buildFromBetterNote(this) });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (file instanceof TFile && file.extension === "flowpath") {
        if (!hasMenuItem(menu, "Open in new tab")) {
          menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus-2").onClick(() => void this.openNode(file, undefined, { newTab: true })));
        }
        menu.addItem((i) => i.setTitle("Open in separate window").setIcon("external-link").onClick(() => void this.openNode(file, undefined, { newWindow: true })));
      } else if (file instanceof TFolder) {
        // Right-clicking a chart's folder (e.g. "Attack Path") offers its chart directly.
        const charts = file.children.filter((c): c is TFile => c instanceof TFile && c.extension === "flowpath");
        for (const c of charts) {
          const what = charts.length > 1 ? `"${c.basename}"` : "flow chart";
          menu.addItem((i) => i.setTitle(`Open ${what} in new tab`).setIcon("git-fork").onClick(() => void this.openNode(c, undefined, { newTab: true })));
        }
      }
    }));
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      // Right-click on a flow node link while editing.
      const cur = editor.getCursor();
      const href = nodeUriAt(editor.getLine(cur.line), cur.ch);
      const parsed = href ? parseNodeUri(href) : null;
      if (parsed) {
        const p = parsed as Record<string, string | undefined>;
        menu.addItem((i) => i.setTitle("Open flow node in new tab").setIcon("file-plus-2").onClick(() => void this.handleParams(p, { newTab: true })));
        menu.addItem((i) => i.setTitle("Open flow node in separate window").setIcon("external-link").onClick(() => void this.handleParams(p, { newWindow: true })));
      }
      menu.addItem((i) => i.setTitle("Link to a flow node…").setIcon("git-fork").onClick(() => void insertNodeLinkFlow(this, editor)));
    }));
  }

  /** "Open in new tab" (and, outside pop-outs, "Open in separate window") for a chart or one of its nodes. */
  addOpenItems(menu: Menu, file: TFile, o: { node?: string; mode?: ViewMode; inPopout?: boolean } = {}): void {
    menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus-2").onClick(() => void this.openNode(file, o.node, { mode: o.mode, newTab: true })));
    if (!o.inPopout) {
      menu.addItem((i) => i.setTitle("Open in separate window").setIcon("external-link").onClick(() => void this.openNode(file, o.node, { mode: o.mode, newWindow: true })));
    }
  }

  onunload(): void {
    void this.saveAll();
  }

  // ---- persistence ----

  async loadAll(): Promise<void> {
    const d = ((await this.loadData()) ?? {}) as Partial<FlowPathData>;
    this.settings = { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) };
    this.mapStates = d.mapStates ?? {};
    this.modes = d.modes ?? {};
  }

  async saveAll(): Promise<void> {
    const data: FlowPathData = { settings: this.settings, mapStates: this.mapStates, modes: this.modes };
    await this.saveData(data);
  }

  freshMapState(): MapState {
    return { dir: this.settings.defaultDir, collapsed: new Set(), zoom: NaN, panX: 0, panY: 0 };
  }

  getMapState(path: string): MapState {
    const s = this.mapStates[path];
    if (!s) return this.freshMapState();
    return { dir: s.dir ?? this.settings.defaultDir, collapsed: new Set(s.collapsed ?? []), zoom: s.zoom == null ? NaN : s.zoom, panX: s.panX ?? 0, panY: s.panY ?? 0 };
  }

  setMapState(path: string, m: MapState): void {
    this.mapStates[path] = { dir: m.dir, collapsed: [...m.collapsed], zoom: Number.isFinite(m.zoom) ? m.zoom : null, panX: m.panX, panY: m.panY };
    this.saveSoon();
  }

  getLastMode(path: string): ViewMode {
    const m = this.modes[path];
    return m && (VIEW_MODES as string[]).includes(m) ? m : this.settings.defaultView;
  }

  setLastMode(path: string, mode: ViewMode): void {
    this.modes[path] = mode;
    this.saveSoon();
  }

  private onRename(f: TAbstractFile, old: string): void {
    if (!(f instanceof TFile) || f.extension !== "flowpath") return;
    if (this.mapStates[old]) { this.mapStates[f.path] = this.mapStates[old]; delete this.mapStates[old]; }
    if (this.modes[old]) { this.modes[f.path] = this.modes[old]; delete this.modes[old]; }
    this.saveSoon();
  }

  // ---- opening ----

  private flowLeaves(): WorkspaceLeaf[] {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE);
  }

  private winOf(leaf: WorkspaceLeaf): Window {
    return (leaf.view.containerEl as HTMLElement).win ?? window;
  }

  /** A leaf in the main window (never a pop-out). Skips leaves that show a flow chart unless `allowFlow`. */
  private mainLeaf(newTab: boolean, allowFlow = false): WorkspaceLeaf {
    const ws = this.app.workspace;
    const usable = (l: WorkspaceLeaf | null | undefined): l is WorkspaceLeaf => !!l && (allowFlow || l.view.getViewType() !== VIEW_TYPE);
    let leaf: WorkspaceLeaf | null = null;
    if (!newTab) {
      try {
        const r = (ws as unknown as { getMostRecentLeaf(root?: unknown): WorkspaceLeaf | null }).getMostRecentLeaf(ws.rootSplit);
        if (usable(r)) leaf = r;
      } catch { /* fall through */ }
      if (!leaf) ws.iterateRootLeaves((l) => { if (!leaf && usable(l)) leaf = l; });
    }
    if (leaf) return leaf;
    let base: WorkspaceLeaf | null = null;
    try {
      base = (ws as unknown as { getMostRecentLeaf(root?: unknown): WorkspaceLeaf | null }).getMostRecentLeaf(ws.rootSplit);
    } catch { /* ignore */ }
    if (!base) ws.iterateRootLeaves((l) => { if (!base) base = l; });
    if (base) ws.setActiveLeaf(base, { focus: false });
    const fresh = ws.getLeaf("tab");
    if (fresh.getRoot() === ws.rootSplit) return fresh;
    return ws.createLeafInParent(ws.rootSplit, 0);
  }

  async openInMainWindow(file: TFile, newTab: boolean): Promise<void> {
    const leaf = this.mainLeaf(newTab);
    await leaf.openFile(file);
    this.app.workspace.revealLeaf(leaf);
    window.focus();
  }

  async openNode(file: TFile, nodeId?: string, opts: OpenOpts = {}): Promise<void> {
    const ws = this.app.workspace;
    const mode = opts.mode;
    if (opts.newTab) {
      const tab = this.mainLeaf(true, true);
      await tab.setViewState({ type: VIEW_TYPE, state: { file: file.path, node: nodeId, mode: mode ?? this.getLastMode(file.path) }, active: true });
      ws.revealLeaf(tab);
      window.focus();
      return;
    }
    const newWindow = opts.newWindow ?? this.settings.openInWindow;
    const leaves = this.flowLeaves();
    const same = (l: WorkspaceLeaf) => (l.view as FlowView).file?.path === file.path;
    const wanted = newWindow ? leaves.filter((l) => this.winOf(l) !== window) : leaves.filter((l) => this.winOf(l) === window);

    let leaf = wanted.find(same) ?? null;
    let reuse = !!leaf;
    if (!leaf && wanted.length) leaf = wanted[0];
    if (!leaf) {
      if (newWindow) {
        try {
          leaf = ws.openPopoutLeaf({ size: { width: this.settings.popoutWidth, height: this.settings.popoutHeight } });
        } catch {
          leaf = this.mainLeaf(true, true);
        }
      } else {
        leaf = this.mainLeaf(true, true);
      }
    }
    if (reuse && leaf.view instanceof FlowView) {
      leaf.view.show(nodeId, mode);
    } else {
      await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path, node: nodeId, mode: mode ?? this.getLastMode(file.path) }, active: true });
    }
    ws.revealLeaf(leaf);
    try { this.winOf(leaf).focus(); } catch { /* ignore */ }
  }

  // ---- links ----

  private registerLinkClicks(doc: Document): void {
    this.registerDomEvent(doc, "click", (evt: MouseEvent) => {
      const t = evt.target as Element | null;
      const a = t?.closest?.("a");
      const href = a?.getAttribute("href");
      if (!a || !isNodeUri(href)) return;
      evt.preventDefault();
      evt.stopPropagation();
      const parsed = parseNodeUri(href!);
      if (parsed) void this.handleParams(parsed as Record<string, string | undefined>);
    }, true);
    // Right-click on a flow node link in a rendered note.
    this.registerDomEvent(doc, "contextmenu", (evt: MouseEvent) => {
      const a = (evt.target as Element | null)?.closest?.("a");
      const href = a?.getAttribute("href");
      const parsed = href && isNodeUri(href) ? parseNodeUri(href) : null;
      if (!parsed) return;
      evt.preventDefault();
      evt.stopPropagation();
      const p = parsed as Record<string, string | undefined>;
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Open in new tab").setIcon("file-plus-2").onClick(() => void this.handleParams(p, { newTab: true })));
      menu.addItem((i) => i.setTitle("Open in separate window").setIcon("external-link").onClick(() => void this.handleParams(p, { newWindow: true })));
      menu.addSeparator();
      menu.addItem((i) => i.setTitle("Copy link").setIcon("copy").onClick(() => void navigator.clipboard.writeText(href!).then(() => new Notice("Link copied."))));
      menu.showAtMouseEvent(evt);
    }, true);
  }

  private async handleParams(params: Record<string, string | undefined>, extra: OpenOpts = {}): Promise<void> {
    let file: TFile | null = null;
    const hint = params.file ? this.app.vault.getAbstractFileByPath(params.file) : null;
    if (hint instanceof TFile && hint.extension === "flowpath") {
      if (!params.chart) file = hint;
      else {
        try {
          if ((await this.store.get(hint)).id === params.chart) file = hint;
        } catch { /* unreadable: fall through to id search */ }
      }
    }
    if (!file && params.chart) file = await this.store.findById(params.chart);
    if (!file && hint instanceof TFile && hint.extension === "flowpath") file = hint;
    if (!file) { new Notice("FlowPath: couldn't find that chart."); return; }

    let node = params.node;
    try {
      const chart = await this.store.get(file);
      const n = resolveNode(chart, node);
      if (node && !n) new Notice("FlowPath: that node no longer exists; opening the chart.");
      node = n?.id;
    } catch { /* open anyway; the view shows the error */ }
    const mode = params.mode && (VIEW_MODES as string[]).includes(params.mode) ? (params.mode as ViewMode) : undefined;
    await this.openNode(file, node, { mode, ...extra });
  }
}

