// FlowView: the window/tab that shows a .flowpath file.
import { FileView, Menu, Notice, TFile, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type FlowPathPlugin from "./main";
import { FlowController } from "./controller";
import type { ViewMode } from "./types";
import { VIEW_MODES } from "./types";
import { modeSwitcher, type ModeSwitcher } from "./ui";
import { resolveNode } from "./model";

export const VIEW_TYPE = "flowpath-view";

export class FlowView extends FileView {
  controller: FlowController | null = null;
  private toolbar!: HTMLElement;
  private crumbs!: HTMLElement;
  private bodyEl!: HTMLElement;
  private backBtn!: HTMLButtonElement;
  private fwdBtn!: HTMLButtonElement;
  private switcher!: ModeSwitcher;
  private pendingMode: ViewMode | null = null;
  private pendingNode: string | null = null;
  private pendingSub: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: FlowPathPlugin) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string { return VIEW_TYPE; }
  getIcon(): string { return "git-fork"; }
  getDisplayText(): string { return this.controller?.chart.title ?? this.file?.basename ?? "Flow chart"; }
  canAcceptExtension(ext: string): boolean { return ext === "flowpath"; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("fp-view");
    this.toolbar = root.createDiv({ cls: "fp-toolbar" });
    this.buildToolbar();
    this.bodyEl = root.createDiv({ cls: "fp-body" });

    this.registerDomEvent(root, "keydown", (e: KeyboardEvent) => {
      const c = this.controller;
      if (!c) return;
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); c.goBack(); }
      else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); c.goForward(); }
      else if (e.altKey && /^Digit[1-4]$/.test(e.code)) { e.preventDefault(); c.setMode(VIEW_MODES[parseInt(e.code.slice(5), 10) - 1]); }
    });
  }

  async onClose(): Promise<void> {
    this.controller?.destroy();
    this.controller = null;
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.controller?.destroy();
    const mode = this.pendingMode ?? this.plugin.getLastMode(file.path);
    const node = this.pendingNode ?? undefined;
    this.pendingMode = null;
    this.pendingNode = null;
    this.bodyEl.empty();
    const c = new FlowController(this.plugin, file, this.bodyEl, this, {
      compact: false,
      mode,
      node,
      persist: true,
      onChange: () => this.refresh(),
    });
    this.controller = c;
    await c.load();
    if (this.pendingSub) this.applySub();
    this.refresh();
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.controller?.destroy();
    this.controller = null;
    this.bodyEl?.empty();
  }

  getState(): Record<string, unknown> {
    return { ...super.getState(), node: this.controller?.current, mode: this.controller?.mode };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = (state ?? {}) as { mode?: ViewMode; node?: string };
    if (s.mode && (VIEW_MODES as string[]).includes(s.mode)) this.pendingMode = s.mode;
    if (s.node) this.pendingNode = s.node;
    await super.setState(state, result);
    const c = this.controller;
    if (c) {
      // same file was already loaded: apply directly
      if (this.pendingMode) { c.setMode(this.pendingMode); this.pendingMode = null; }
      if (this.pendingNode) {
        const n = resolveNode(c.chart, this.pendingNode);
        if (n) c.select(n.id);
        this.pendingNode = null;
      }
    }
  }

  setEphemeralState(state: unknown): void {
    const sub = (state as { subpath?: string } | null)?.subpath;
    if (sub) {
      this.pendingSub = sub;
      if (this.controller) this.applySub();
    }
    super.setEphemeralState(state);
  }

  private applySub(): void {
    const c = this.controller;
    const sub = this.pendingSub;
    this.pendingSub = null;
    if (!c || !sub) return;
    const n = resolveNode(c.chart, sub);
    if (n) c.select(n.id);
    else new Notice(`No node "${sub.replace(/^[#^]+/, "")}" in this chart.`);
  }

  /** Select a node and optionally switch view (used by openNode when this chart is already open). */
  show(nodeId?: string, mode?: ViewMode): void {
    const c = this.controller;
    if (!c) { if (nodeId) this.pendingNode = nodeId; if (mode) this.pendingMode = mode; return; }
    if (mode) c.setMode(mode);
    const n = resolveNode(c.chart, nodeId);
    if (n) c.select(n.id);
  }

  private buildToolbar(): void {
    const t = this.toolbar;
    const nav = t.createDiv({ cls: "fp-nav" });
    this.backBtn = nav.createEl("button", { cls: "fp-icon-btn", attr: { "aria-label": "Back (Alt+Left)", type: "button" } });
    setIcon(this.backBtn, "arrow-left");
    this.backBtn.addEventListener("click", () => this.controller?.goBack());
    this.fwdBtn = nav.createEl("button", { cls: "fp-icon-btn", attr: { "aria-label": "Forward (Alt+Right)", type: "button" } });
    setIcon(this.fwdBtn, "arrow-right");
    this.fwdBtn.addEventListener("click", () => this.controller?.goForward());

    this.crumbs = t.createDiv({ cls: "fp-crumbs" });
    t.createDiv({ cls: "fp-spacer" });

    this.switcher = modeSwitcher(t, "map", (m) => this.controller?.setMode(m), true);

    const add = t.createEl("button", { cls: "fp-btn", attr: { type: "button" } });
    setIcon(add.createSpan({ cls: "fp-btn-icon" }), "plus");
    add.createSpan({ text: "option" });
    add.addEventListener("click", () => { const c = this.controller; if (c) void c.addOption(c.current); });

    const more = t.createEl("button", { cls: "fp-icon-btn", attr: { "aria-label": "More", type: "button" } });
    setIcon(more, "more-horizontal");
    more.addEventListener("click", (e) => this.moreMenu(e));
  }

  private moreMenu(e: MouseEvent): void {
    const c = this.controller;
    if (!c) return;
    const m = new Menu();
    this.plugin.addOpenItems(m, c.file, { node: c.current, mode: c.mode, inPopout: this.containerEl.win !== window });
    m.addItem((i) => i.setTitle("Copy link to current node").setIcon("link").onClick(() => c.copyLink(c.current)));
    m.addItem((i) => i.setTitle("Copy embed").setIcon("code").onClick(() => c.copyEmbed(c.current)));
    m.addSeparator();
    m.addItem((i) => i.setTitle("Create BetterNotes for all nodes").setIcon("files").onClick(() => void c.createAllBetterNotes()));
    m.addItem((i) => i.setTitle("Rename chart…").setIcon("pencil").onClick(() => void c.renameChart()));
    m.addItem((i) => i.setTitle("Reset progress").setIcon("rotate-ccw").onClick(() => c.resetProgress()));
    m.addItem((i) => i.setTitle("Expand all").setIcon("unfold-vertical").onClick(() => c.expandAll()));
    m.showAtMouseEvent(e);
  }

  /** Re-sync toolbar, tab title and saved view state with the controller. */
  private refresh(): void {
    const c = this.controller;
    if (!c) return;
    this.backBtn.disabled = !c.canBack;
    this.fwdBtn.disabled = !c.canForward;
    this.switcher.set(c.mode);
    this.renderCrumbs(c);
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    this.app.workspace.requestSaveLayout();
  }

  private renderCrumbs(c: FlowController): void {
    this.crumbs.empty();
    const ids = c.trail;
    const sep = () => setIcon(this.crumbs.createSpan({ cls: "fp-crumb-sep" }), "chevron-right");
    const crumb = (id: string, last: boolean) => {
      const b = this.crumbs.createEl("button", { cls: "fp-crumb" + (last ? " is-current" : ""), text: c.chart.nodes[id]?.title ?? "?", attr: { type: "button" } });
      b.addEventListener("click", () => c.select(id));
    };
    const MAX = 5;
    if (ids.length <= MAX) {
      ids.forEach((id, i) => { if (i) sep(); crumb(id, i === ids.length - 1); });
      return;
    }
    crumb(ids[0], false);
    sep();
    const hidden = ids.slice(1, ids.length - 3);
    const dots = this.crumbs.createEl("button", { cls: "fp-crumb", text: "…", attr: { type: "button", "aria-label": "Show hidden steps" } });
    dots.addEventListener("click", (e) => {
      const m = new Menu();
      for (const id of hidden) m.addItem((i) => i.setTitle(c.chart.nodes[id]?.title ?? "?").onClick(() => c.select(id)));
      m.showAtMouseEvent(e);
    });
    const tail = ids.slice(-3);
    tail.forEach((id, i) => { sep(); crumb(id, i === tail.length - 1); });
  }
}
