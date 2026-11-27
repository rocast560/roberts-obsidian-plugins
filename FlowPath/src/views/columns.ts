// Columns view: Finder-style columns along the path to the current node.
import type { FlowHost, FlowRenderer } from "../host";
import { childrenOf, pathTo } from "../model";
import { bindNode, colorClass, doneMark, edgePill, icon, Keys, noteButton, prepareRoot, releaseRoot } from "./common";

export class ColumnsRenderer implements FlowRenderer {
  private el?: HTMLElement;
  private keys = new Keys();
  private token = 0;

  render(el: HTMLElement, host: FlowHost): void {
    this.el = el;
    const token = ++this.token;
    const chart = host.chart;
    const prevLeft = el.querySelector<HTMLElement>(".fp-cols")?.scrollLeft;
    prepareRoot(el, host, "columns");
    const wrap = el.createDiv({ cls: "fp-cols" });
    const path = pathTo(chart, host.current);
    const onPath = new Set(path);
    const cur = chart.nodes[host.current];
    if (!cur) return;

    interface Entry { id: string; label?: string }
    const colEntries = (k: number): Entry[] => {
      if (k === 0) {
        const roots = [chart.root, ...Object.keys(chart.nodes).filter((id) => id !== chart.root && !chart.edges.some((e) => e.to === id))];
        // a detached chain's head can be the path start when current is not reachable from the root
        if (path[0] !== chart.root && !roots.includes(path[0])) roots.push(path[0]);
        return roots.map((id) => ({ id }));
      }
      return childrenOf(chart, path[k - 1]).map((l) => ({ id: l.node.id, label: l.edge.label }));
    };

    for (let k = 0; k <= path.length; k++) {
      const entries = colEntries(k);
      const last = k === path.length;
      const col = wrap.createDiv({ cls: "fp-col" + (last ? " is-last" : "") });
      for (const en of entries) {
        const n = chart.nodes[en.id];
        if (!n) continue;
        const item = col.createDiv({ cls: "fp-item " + colorClass(n) });
        item.dataset.id = en.id;
        if (path[k] === en.id) item.addClass(en.id === host.current ? "fp-current" : "fp-onpath");
        else if (onPath.has(en.id) && !last) item.addClass("fp-onpath-soft");
        if (n.done) item.addClass("fp-done");
        item.createSpan({ cls: "fp-dot" });
        const body = item.createDiv({ cls: "fp-item-body" });
        edgePill(body, en.label);
        body.createSpan({ cls: "fp-item-title", text: n.title });
        if (n.note) noteButton(item, host, n);
        if (n.done) doneMark(item);
        if (childrenOf(chart, en.id).length) icon(item, "chevron-right", "fp-item-chev");
        bindNode(item, host, en.id);
      }
      if (last) {
        const add = col.createEl("button", { cls: "fp-item fp-item-add" });
        icon(add, "plus");
        add.createSpan({ text: "Add option" });
        add.addEventListener("click", () => host.addOption(host.current));
        if (entries.length === 0) col.addClass("is-empty");
      }
    }

    // detail panel
    const det = wrap.createDiv({ cls: "fp-detail " + colorClass(cur) });
    det.createEl("h3", { cls: "fp-detail-title", text: cur.title });
    const parents = path.length > 1 ? chart.nodes[path[path.length - 2]] : undefined;
    if (parents) {
      const edge = chart.edges.find((e) => e.from === parents.id && e.to === cur.id);
      const sub = det.createDiv({ cls: "fp-detail-sub" });
      sub.createSpan({ text: "after " + parents.title });
      edgePill(sub, edge?.label);
    }
    if (cur.desc && cur.desc.trim()) {
      const d = det.createDiv({ cls: "fp-detail-desc markdown-rendered" });
      void host.renderMarkdown(cur.desc, d).then(() => token === this.token);
    }
    const acts = det.createDiv({ cls: "fp-detail-actions" });
    const open = acts.createEl("button", { cls: "fp-btn" + (cur.note ? " fp-btn-primary" : " fp-btn-quiet") });
    icon(open, cur.note ? "file-text" : "link");
    open.createSpan({ text: cur.note ? host.noteName(cur.id) ?? "Open note" : "Link a note" });
    open.addEventListener("click", (e) => host.openNote(cur.id, e.ctrlKey || e.metaKey));
    const done = acts.createEl("button", { cls: "fp-btn" + (cur.done ? " is-on" : "") });
    icon(done, "check");
    done.createSpan({ text: cur.done ? "Done" : "Mark done" });
    done.addEventListener("click", () => host.toggleDone(cur.id));

    // scroll: keep position if only a toggle changed, else reveal the right end
    if (prevLeft !== undefined && wrap.scrollWidth <= wrap.clientWidth + prevLeft) wrap.scrollLeft = prevLeft;
    wrap.scrollLeft = wrap.scrollWidth;
    wrap.querySelectorAll<HTMLElement>(".fp-col").forEach((c) => {
      const sel = c.querySelector<HTMLElement>(".fp-onpath, .fp-current");
      if (sel) c.scrollTop = Math.max(0, sel.offsetTop - c.clientHeight / 2);
    });
    this.keys.bind(el, host, { leftIsParent: true });
  }

  destroy(): void {
    this.token++;
    this.keys.unbind();
    releaseRoot(this.el);
    this.el = undefined;
  }
}
