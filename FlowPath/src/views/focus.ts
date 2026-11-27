// Focus view: one node at a time, with its options as big cards ("follow the playbook").
import type { FlowHost, FlowRenderer } from "../host";
import { childrenOf, parentsOf, pathTo } from "../model";
import { bindNode, colorClass, doneMark, edgePill, firstLine, icon, Keys, noteButton, optionsLabel, prepareRoot, releaseRoot } from "./common";

export class FocusRenderer implements FlowRenderer {
  private el?: HTMLElement;
  private keys = new Keys();
  private token = 0;
  private lastId = "";

  render(el: HTMLElement, host: FlowHost): void {
    this.el = el;
    const token = ++this.token;
    const chart = host.chart;
    const cur = chart.nodes[host.current];
    if (!cur) return;
    const sameNode = this.lastId === cur.id;
    const oldScroll = sameNode ? el.querySelector<HTMLElement>(".fp-focus")?.scrollTop ?? 0 : 0;
    this.lastId = cur.id;

    prepareRoot(el, host, "focus");
    const scroller = el.createDiv({ cls: "fp-focus" });
    const inner = scroller.createDiv({ cls: "fp-focus-inner" });
    if (!sameNode) inner.addClass("fp-enter");

    // came from
    const parents = parentsOf(chart, cur.id);
    if (parents.length) {
      const row = inner.createDiv({ cls: "fp-from" });
      row.createSpan({ cls: "fp-from-label", text: "Came from" });
      for (const p of parents) {
        const chip = row.createEl("button", { cls: "fp-chip " + colorClass(p.node) });
        icon(chip, "arrow-left");
        chip.createSpan({ text: p.node.title });
        if (p.edge.label) chip.createSpan({ cls: "fp-chip-label", text: p.edge.label });
        bindNode(chip, host, p.node.id);
      }
    }

    // current node card
    const card = inner.createDiv({ cls: "fp-focus-card " + colorClass(cur) });
    if (cur.done) card.addClass("fp-done");
    const head = card.createDiv({ cls: "fp-focus-head" });
    const done = head.createEl("button", { cls: "fp-check" + (cur.done ? " is-done" : "") });
    done.setAttr("aria-label", cur.done ? "Mark as not done" : "Mark as done");
    icon(done, "check");
    done.addEventListener("click", (e) => {
      e.stopPropagation();
      host.toggleDone(cur.id);
    });
    head.createEl("h2", { cls: "fp-focus-title", text: cur.title });
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      host.showNodeMenu(cur.id, e);
    });

    const noteName = host.noteName(cur.id);
    const actions = card.createDiv({ cls: "fp-focus-actions" });
    if (cur.note) {
      const b = actions.createEl("button", { cls: "fp-btn fp-btn-primary" });
      icon(b, "file-text");
      b.createSpan({ text: noteName ?? "Open note" });
      b.addEventListener("click", (e) => host.openNote(cur.id, e.ctrlKey || e.metaKey));
    } else {
      const b = actions.createEl("button", { cls: "fp-btn fp-btn-quiet" });
      icon(b, "link");
      b.createSpan({ text: "Link a note" });
      b.addEventListener("click", () => host.openNote(cur.id, false));
    }
    if (cur.desc && cur.desc.trim()) {
      const d = card.createDiv({ cls: "fp-focus-desc markdown-rendered" });
      void host.renderMarkdown(cur.desc, d);
    }

    if (cur.note && !host.compact) {
      const panel = card.createDiv({ cls: "fp-excerpt is-loading" });
      void host.noteExcerpt(cur.id, 1200).then(async (md) => {
        if (token !== this.token || !panel.isConnected) return;
        panel.removeClass("is-loading");
        if (!md || !md.trim()) {
          panel.remove();
          return;
        }
        const body = panel.createDiv({ cls: "fp-excerpt-body markdown-rendered" });
        await host.renderMarkdown(md, body);
        if (token !== this.token || !panel.isConnected) return;
        const more = panel.createEl("button", { cls: "fp-excerpt-more" });
        more.createSpan({ text: "Open note" });
        icon(more, "arrow-right");
        more.addEventListener("click", (e) => host.openNote(cur.id, e.ctrlKey || e.metaKey));
      });
    }

    // options
    const kids = childrenOf(chart, cur.id);
    inner.createDiv({ cls: "fp-section-title", text: kids.length ? "Options — what next?" : "Options" });
    if (kids.length === 0) {
      const empty = inner.createDiv({ cls: "fp-empty" });
      empty.createDiv({ cls: "fp-empty-title", text: "End of this path" });
      empty.createDiv({ cls: "fp-empty-sub", text: "Nothing follows this step yet." });
      const row = empty.createDiv({ cls: "fp-empty-actions" });
      const add = row.createEl("button", { cls: "fp-btn fp-btn-primary" });
      icon(add, "plus");
      add.createSpan({ text: "Add option" });
      add.addEventListener("click", () => host.addOption(cur.id));
      const path = pathTo(chart, cur.id);
      const parentId = path.length > 1 ? path[path.length - 2] : undefined;
      if (parentId && chart.nodes[parentId]) {
        const back = row.createEl("button", { cls: "fp-btn" });
        icon(back, "arrow-left");
        back.createSpan({ text: "Back to " + chart.nodes[parentId].title });
        back.addEventListener("click", () => host.select(parentId));
      }
    } else {
      const grid = inner.createDiv({ cls: "fp-options" });
      kids.forEach((l, i) => {
        const n = l.node;
        const c = grid.createDiv({ cls: "fp-opt " + colorClass(n) });
        if (n.done) c.addClass("fp-done");
        const top = c.createDiv({ cls: "fp-opt-top" });
        if (i < 9) top.createSpan({ cls: "fp-num", text: String(i + 1) });
        edgePill(top, l.edge.label);
        c.createDiv({ cls: "fp-opt-title", text: n.title });
        const line = firstLine(n.desc);
        if (line) c.createDiv({ cls: "fp-opt-desc", text: line });
        const foot = c.createDiv({ cls: "fp-opt-foot" });
        const deg = childrenOf(chart, n.id).length;
        if (deg) foot.createSpan({ cls: "fp-opt-count", text: optionsLabel(deg) });
        if (n.note) noteButton(foot, host, n);
        if (n.done) doneMark(foot);
        bindNode(c, host, n.id);
      });
      const add = grid.createEl("button", { cls: "fp-opt fp-opt-add" });
      icon(add, "plus");
      add.createSpan({ text: "Add option" });
      add.addEventListener("click", () => host.addOption(cur.id));
    }

    if (oldScroll) scroller.scrollTop = oldScroll;
    this.keys.bind(el, host, { leftIsParent: true });
  }

  destroy(): void {
    this.token++;
    this.keys.unbind();
    releaseRoot(this.el);
    this.el = undefined;
  }
}
