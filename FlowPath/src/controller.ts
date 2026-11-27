// FlowController: one live chart view (window or embed). Implements the FlowHost contract.
import { Component, MarkdownRenderer, Menu, Notice, TFile, debounce, type App, type MenuItem } from "obsidian";
import type FlowPathPlugin from "./main";
import type { FlowHost, FlowRenderer, MapState } from "./host";
import type { Chart, NodeColor, ViewMode } from "./types";
import { NODE_COLORS } from "./types";
import { addChild, connect, deleteNode, disconnect, emptyChart, exclusiveSubtree, moveChild, parentsOf, pathTo, resolveNode, setEdgeLabel } from "./model";
import { createRenderer } from "./views";
import { noteBody, nodeMarkdownLink, embedBlock, truncateAtLine } from "./links";
import { confirm, pick, promptText, promptTextArea } from "./modals";
import { createNoteAndSave, createNotesForAll, resolveNoteFile } from "./betternotes";
import { copyText } from "./ui";

export interface ControllerOptions {
  compact: boolean;
  mode: ViewMode;
  node?: string;
  /** Persist map state / last mode in plugin data (window yes, embed no). */
  persist: boolean;
  /** Called after any change of chart, current node or mode (breadcrumb, header, view state). */
  onChange?: () => void;
}

export class FlowController implements FlowHost {
  chart: Chart;
  current: string;
  mode: ViewMode;
  mapState: MapState;
  readonly compact: boolean;
  readonly app: App;
  private renderer: FlowRenderer | null = null;
  private back: string[] = [];
  private fwd: string[] = [];
  private failed: string | null = null;
  private dead = false;
  private unsub: (() => void) | null = null;
  private persistMap: () => void;

  constructor(
    readonly plugin: FlowPathPlugin,
    readonly file: TFile,
    readonly body: HTMLElement,
    readonly component: Component,
    private opts: ControllerOptions,
  ) {
    this.app = plugin.app;
    this.compact = opts.compact;
    this.mode = opts.mode;
    this.chart = emptyChart(file.basename);
    this.current = this.chart.root;
    this.mapState = opts.persist ? plugin.getMapState(file.path) : plugin.freshMapState();
    this.persistMap = debounce(() => plugin.setMapState(file.path, this.mapState), 500, true);
    component.register(() => this.destroy());
    component.registerDomEvent(body, "contextmenu", (e) => this.showChartMenu(e));
  }

  /** True when this chart is shown in a pop-out window rather than the main Obsidian window. */
  get inPopout(): boolean {
    return (this.body.win ?? window) !== window;
  }

  /** Right-click on empty chart space (node menus call preventDefault first, so they win). */
  private showChartMenu(e: MouseEvent): void {
    if (e.defaultPrevented || this.dead) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.("input, textarea, [contenteditable='true'], a")) return;
    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    this.plugin.addOpenItems(menu, this.file, { node: this.current, mode: this.mode, inPopout: this.inPopout });
    menu.addSeparator();
    menu.addItem((i) => i.setTitle("Copy link to current node").setIcon("copy").onClick(() => this.copyLink(this.current)));
    menu.addItem((i) => i.setTitle("Copy embed code block").setIcon("code").onClick(() => this.copyEmbed(this.current)));
    menu.showAtMouseEvent(e);
  }

  get chartPath(): string {
    return this.file.path;
  }

  get canBack(): boolean { return this.back.length > 0; }
  get canForward(): boolean { return this.fwd.length > 0; }
  /** Ids from the root to the current node. */
  get trail(): string[] { return pathTo(this.chart, this.current); }

  async load(): Promise<void> {
    this.body.empty();
    try {
      this.chart = await this.plugin.store.get(this.file);
      this.failed = null;
    } catch (e) {
      this.failed = (e as Error)?.message ?? String(e);
    }
    if (this.dead) return;
    this.current = resolveNode(this.chart, this.opts.node)?.id ?? this.chart.root;
    this.unsub = this.plugin.store.subscribe(this.file.path, (_p, kind) => this.onStore(kind));
    this.renderer = createRenderer(this.mode);
    this.render();
    this.opts.onChange?.();
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.unsub?.();
    this.renderer?.destroy?.();
    this.renderer = null;
  }

  private onStore(kind: string): void {
    if (this.dead) return;
    if (kind === "delete") {
      this.failed = "This chart file was deleted.";
    } else {
      const c = this.plugin.store.peek(this.file);
      if (c) {
        this.chart = c;
        this.failed = null;
      } else if (this.plugin.store.isBroken(this.file)) {
        // keep showing the last good chart; edits stay blocked until the file parses
      }
    }
    if (!this.chart.nodes[this.current]) this.current = this.chart.root;
    this.back = this.back.filter((id) => !!this.chart.nodes[id]);
    this.fwd = this.fwd.filter((id) => !!this.chart.nodes[id]);
    this.render();
    this.opts.onChange?.();
  }

  render(): void {
    if (this.dead || !this.renderer) return;
    if (this.failed) {
      this.body.empty();
      this.body.createDiv({ cls: "fp-error", text: `Can't show this chart: ${this.failed}` });
      return;
    }
    try {
      this.renderer.render(this.body, this);
    } catch (e) {
      console.error("FlowPath render failed", e);
      this.body.empty();
      this.body.createDiv({ cls: "fp-error", text: "This view failed to draw. Try another view." });
    }
  }

  // ---- navigation ----

  select(id: string, history = true): void {
    if (!this.chart.nodes[id]) return;
    if (id !== this.current && history) {
      this.back.push(this.current);
      if (this.back.length > 200) this.back.shift();
      this.fwd = [];
    }
    this.current = id;
    this.render();
    this.renderer?.reveal?.(id);
    this.opts.onChange?.();
  }

  goBack(): void {
    const id = this.back.pop();
    if (!id) return;
    this.fwd.push(this.current);
    this.select(id, false);
  }

  goForward(): void {
    const id = this.fwd.pop();
    if (!id) return;
    this.back.push(this.current);
    this.select(id, false);
  }

  setMode(mode: ViewMode): void {
    if (mode === this.mode && this.renderer) return;
    this.renderer?.destroy?.();
    this.mode = mode;
    this.renderer = createRenderer(mode);
    if (this.opts.persist) this.plugin.setLastMode(this.file.path, mode);
    this.render();
    this.renderer.reveal?.(this.current);
    this.opts.onChange?.();
  }

  fit(): void { this.renderer?.fit?.(); }

  saveMapState(): void {
    if (this.opts.persist) this.persistMap();
  }

  toggleCollapse(id: string): void {
    if (this.mapState.collapsed.has(id)) this.mapState.collapsed.delete(id);
    else this.mapState.collapsed.add(id);
    this.saveMapState();
    this.render();
  }

  expandAll(): void {
    this.mapState.collapsed.clear();
    this.saveMapState();
    this.render();
  }

  // ---- mutations ----

  /** Every edit goes through here: apply, save, and the store notifies all views of this chart. */
  mutate(fn: (c: Chart) => void): boolean {
    if (this.failed || this.plugin.store.isBroken(this.file)) {
      new Notice("FlowPath: this chart file can't be read, so it's read-only until it's fixed.");
      return false;
    }
    fn(this.chart);
    void this.plugin.store.save(this.file, this.chart);
    return true;
  }

  async addOption(parentId: string): Promise<void> {
    const title = await promptText(this.app, { title: `Add option under "${this.chart.nodes[parentId]?.title ?? ""}"`, placeholder: "What can happen or be done next?", cta: "Add" });
    if (!title) return;
    let newId = "";
    if (this.mutate((c) => { newId = addChild(c, parentId, title).id; })) {
      if (this.mapState.collapsed.delete(parentId)) this.saveMapState();
      this.select(newId);
    }
  }

  async rename(id: string): Promise<void> {
    const n = this.chart.nodes[id];
    if (!n) return;
    const title = await promptText(this.app, { title: "Rename node", value: n.title, cta: "Rename" });
    if (title && title !== n.title) this.mutate((c) => { c.nodes[id].title = title; });
  }

  async renameChart(): Promise<void> {
    const title = await promptText(this.app, { title: "Rename chart", value: this.chart.title, cta: "Rename" });
    if (title && title !== this.chart.title) this.mutate((c) => { c.title = title; });
  }

  async editDescription(id: string): Promise<void> {
    const n = this.chart.nodes[id];
    if (!n) return;
    const v = await promptTextArea(this.app, { title: `Description: ${n.title}`, value: n.desc ?? "" });
    if (v === null) return;
    this.mutate((c) => { if (v) c.nodes[id].desc = v; else delete c.nodes[id].desc; });
  }

  toggleDone(id: string): void {
    this.mutate((c) => { if (c.nodes[id].done) delete c.nodes[id].done; else c.nodes[id].done = true; });
  }

  resetProgress(): void {
    this.mutate((c) => { for (const n of Object.values(c.nodes)) delete n.done; });
  }

  setColor(id: string, color: NodeColor | null): void {
    this.mutate((c) => { if (color) c.nodes[id].color = color; else delete c.nodes[id].color; });
  }

  async connectExisting(id: string): Promise<void> {
    const others = Object.values(this.chart.nodes).filter((n) => n.id !== id);
    const target = await pick(this.app, others, (n) => this.pathLabel(n.id), "Connect to which node?");
    if (!target) return;
    const label = await promptText(this.app, { title: "Arrow label (optional)", placeholder: "e.g. found creds", cta: "Connect", allowEmpty: true });
    if (label === null) return;
    let ok = false;
    this.mutate((c) => { ok = connect(c, id, target.id, label || undefined); });
    if (!ok) new Notice("Already connected.");
  }

  async editEdgeLabel(parent: string, id: string): Promise<void> {
    const e = this.chart.edges.find((x) => x.from === parent && x.to === id);
    if (!e) return;
    const v = await promptText(this.app, { title: "Arrow label", value: e.label ?? "", cta: "Save", allowEmpty: true });
    if (v !== null) this.mutate((c) => setEdgeLabel(c, parent, id, v));
  }

  setStart(id: string): void {
    this.mutate((c) => { c.root = id; });
  }

  move(parent: string, id: string, dir: -1 | 1): void {
    this.mutate((c) => moveChild(c, parent, id, dir));
  }

  async removeFromParent(parent: string, id: string): Promise<void> {
    const only = parentsOf(this.chart, id).length <= 1;
    if (only) {
      const ok = await confirm(this.app, {
        title: "Remove from parent",
        message: `"${this.chart.nodes[id].title}" has no other parent, so it will become detached from the start. The node is kept.`,
        cta: "Remove",
      });
      if (!ok) return;
    }
    if (this.current === id) this.current = parent;
    this.mutate((c) => disconnect(c, parent, id));
  }

  async deleteFlow(id: string): Promise<void> {
    if (id === this.chart.root) { new Notice("The start node can't be deleted. Set another start node first."); return; }
    const n = this.chart.nodes[id];
    if (!n) return;
    const exclusive = exclusiveSubtree(this.chart, id).filter((x) => x !== id).length;
    const res = await confirm(this.app, {
      title: "Delete node",
      message: `Delete "${n.title}" from this chart? Linked notes are not touched.`,
      cta: "Delete",
      danger: true,
      checkbox: exclusive > 0 ? `Also delete ${exclusive} option${exclusive === 1 ? "" : "s"} only reachable through it` : undefined,
    });
    if (!res) return;
    const path = pathTo(this.chart, id);
    const fallback = path.length > 1 ? path[path.length - 2] : this.chart.root;
    if (this.current === id || exclusiveSubtree(this.chart, id).includes(this.current)) this.current = fallback;
    this.mutate((c) => { deleteNode(c, id, res.checked); });
  }

  // ---- notes ----

  noteFile(id: string): TFile | null {
    return resolveNoteFile(this.app, this.chartPath, this.chart.nodes[id]?.note);
  }

  noteName(id: string): string | null {
    return this.noteFile(id)?.basename ?? null;
  }

  async noteExcerpt(id: string, maxChars = 1500): Promise<string | null> {
    const f = this.noteFile(id);
    if (!f) return null;
    try {
      const text = await this.app.vault.cachedRead(f);
      return truncateAtLine(noteBody(text), maxChars);
    } catch {
      return null;
    }
  }

  async renderMarkdown(md: string, el: HTMLElement): Promise<void> {
    await MarkdownRenderer.render(this.app, md, el, this.chartPath, this.component);
  }

  openNote(id: string, newTab: boolean): void {
    const f = this.noteFile(id);
    if (f) {
      void this.plugin.openInMainWindow(f, newTab);
      return;
    }
    const n = this.chart.nodes[id];
    if (!n) return;
    if (n.note) new Notice(`Linked note "${n.note}" wasn't found. Link another one.`);
    const menu = new Menu();
    menu.addItem((i) => i.setTitle("Link existing note…").setIcon("link").onClick(() => void this.linkNote(id)));
    menu.addItem((i) => i.setTitle("Create BetterNote for this node").setIcon("file-plus").onClick(() => void this.createBetterNote(id, true)));
    const r = this.body.getBoundingClientRect();
    menu.showAtPosition({ x: r.left + r.width / 2, y: r.top + r.height / 3 });
  }

  async linkNote(id: string): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const f = await pick(this.app, files, (x) => x.path.replace(/\.md$/, ""), "Link which note?");
    if (f) this.mutate((c) => { c.nodes[id].note = f.path; });
  }

  async createBetterNote(id: string, open: boolean): Promise<void> {
    if (this.failed || this.plugin.store.isBroken(this.file)) { new Notice("This chart can't be read, so it's read-only."); return; }
    try {
      const out = await createNoteAndSave(this.plugin, this.file, this.chart, id);
      if (out === "skipped") new Notice("This node already has a note.");
      else {
        new Notice(out === "created" ? "BetterNote created." : "Linked the existing note with that name.");
        if (open) this.openNote(id, true);
      }
    } catch (e) {
      new Notice(`Couldn't create the note: ${(e as Error)?.message ?? e}`);
    }
  }

  async createAllBetterNotes(): Promise<void> {
    if (this.failed || this.plugin.store.isBroken(this.file)) { new Notice("This chart can't be read, so it's read-only."); return; }
    const r = await createNotesForAll(this.plugin, this.file, this.chart);
    new Notice(`BetterNotes: ${r.created} created, ${r.linked} linked existing, ${r.skipped} skipped${r.failed ? `, ${r.failed} failed` : ""}.`);
  }

  // ---- links ----

  linkFor(id: string): string {
    const n = this.chart.nodes[id];
    return nodeMarkdownLink(this.app.vault.getName(), this.chart.id, this.file.path, id, n?.title ?? "node");
  }

  copyLink(id: string): void {
    void copyText(this.body, this.linkFor(id)).then(() => new Notice("Link copied."));
  }

  copyEmbed(id?: string): void {
    const node = id && id !== this.chart.root ? this.chart.nodes[id]?.id : undefined;
    void copyText(this.body, embedBlock(this.file.path, { node, view: this.mode })).then(() => new Notice("Embed copied."));
  }

  /** "Chart › Parent › Node" label for pickers. */
  pathLabel(id: string): string {
    return [this.chart.title, ...pathTo(this.chart, id).map((x) => this.chart.nodes[x]?.title ?? "?")].join(" › ");
  }

  // ---- context menu ----

  showNodeMenu(id: string, evt: MouseEvent): void {
    const n = this.chart.nodes[id];
    if (!n) return;
    const path = pathTo(this.chart, id);
    const parentId = path.length > 1 ? path[path.length - 2] : null;
    const parent = parentId ? this.chart.nodes[parentId] : null;
    const menu = new Menu();
    const add = (title: string, icon: string, fn: () => void) => menu.addItem((i) => i.setTitle(title).setIcon(icon).onClick(fn));

    this.plugin.addOpenItems(menu, this.file, { node: id, mode: this.mode, inPopout: this.inPopout });
    menu.addSeparator();
    add("Add option…", "plus", () => void this.addOption(id));
    add("Connect to existing node…", "git-merge", () => void this.connectExisting(id));
    add("Rename…", "pencil", () => void this.rename(id));
    add("Edit description…", "align-left", () => void this.editDescription(id));
    if (parentId) add("Edit arrow label…", "tag", () => void this.editEdgeLabel(parentId, id));

    menu.addSeparator();
    if (this.noteFile(id)) {
      add("Open note", "file-text", () => this.openNote(id, false));
      add("Open note in new tab", "file-plus-2", () => this.openNote(id, true));
    }
    add(n.note ? "Link another note…" : "Link note…", "link", () => void this.linkNote(id));
    if (n.note) add("Unlink note", "unlink", () => this.mutate((c) => { delete c.nodes[id].note; }));
    if (!this.noteFile(id)) add("Create BetterNote for this node", "file-plus", () => void this.createBetterNote(id, true));

    menu.addSeparator();
    add(n.done ? "Mark not done" : "Mark done", n.done ? "circle" : "check-circle-2", () => this.toggleDone(id));
    menu.addItem((i: MenuItem) => {
      i.setTitle("Colour").setIcon("palette");
      const sub = (i as unknown as { setSubmenu?: () => Menu }).setSubmenu?.();
      if (sub) {
        sub.addItem((x) => x.setTitle("None").setChecked(!n.color).onClick(() => this.setColor(id, null)));
        for (const col of NODE_COLORS) sub.addItem((x) => x.setTitle(col[0].toUpperCase() + col.slice(1)).setChecked(n.color === col).onClick(() => this.setColor(id, col)));
      } else {
        i.onClick(() => {
          const m2 = new Menu();
          m2.addItem((x) => x.setTitle("No colour").onClick(() => this.setColor(id, null)));
          for (const col of NODE_COLORS) m2.addItem((x) => x.setTitle(col).onClick(() => this.setColor(id, col)));
          m2.showAtMouseEvent(evt);
        });
      }
    });
    if (parentId) {
      add("Move up", "arrow-up", () => this.move(parentId, id, -1));
      add("Move down", "arrow-down", () => this.move(parentId, id, 1));
    }
    if (id !== this.chart.root) add("Set as start node", "flag", () => this.setStart(id));

    menu.addSeparator();
    add("Copy link to node", "copy", () => this.copyLink(id));
    add("Copy embed code block", "code", () => this.copyEmbed(id));

    menu.addSeparator();
    if (parentId && parent) add(`Remove from "${parent.title}"`, "unlink-2", () => void this.removeFromParent(parentId, id));
    if (id !== this.chart.root) menu.addItem((i) => i.setTitle("Delete node…").setIcon("trash-2").setWarning(true).onClick(() => void this.deleteFlow(id)));

    menu.showAtMouseEvent(evt);
  }
}

