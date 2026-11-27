// Outline view: collapsible tree list over the spanning tree.
import type { FlowHost, FlowRenderer } from "../host";
import { childrenOf, spanningTree, type Spanning } from "../model";
import { bindNode, colorClass, doneMark, edgePill, icon, Keys, noteButton, pathInfo, prepareRoot, releaseRoot } from "./common";

// explicit expand/collapse choices per chart file; survives re-render
const overrides = new Map<string, Map<string, boolean>>();

export class OutlineRenderer implements FlowRenderer {
  private el?: HTMLElement;
  private host?: FlowHost;
  private keys = new Keys();

  render(el: HTMLElement, host: FlowHost): void {
    this.el = el;
    this.host = host;
    const chart = host.chart;
    const prevScroll = el.querySelector<HTMLElement>(".fp-outline")?.scrollTop ?? 0;
    prepareRoot(el, host, "outline");
    const root = el.createDiv({ cls: "fp-outline" });
    const sp = spanningTree(chart);
    const { set: pathSet } = pathInfo(host);
    let ov = overrides.get(host.chartPath);
    if (!ov) overrides.set(host.chartPath, (ov = new Map()));
    const ovm = ov;
    let currentRow: HTMLElement | null = null;

    const isOpen = (id: string, depth: number): boolean => ovm.get(id) ?? (depth < 2 || pathSet.has(id));

    const addRow = (parent: HTMLElement, id: string, depth: number, edgeLabel: string | undefined, ref: boolean): void => {
      const n = chart.nodes[id];
      if (!n) return;
      const kids = ref ? [] : sp.kids.get(id) ?? [];
      // non-tree options (loops, second parents) also live under the node as "↪" rows
      const expandable = !ref && childrenOf(chart, id).length > 0;
      const open = expandable && isOpen(id, depth);
      const row = parent.createDiv({ cls: "fp-row " + colorClass(n) });
      row.dataset.id = id;
      if (id === host.current && !ref) {
        row.addClass("fp-current");
        currentRow = row;
      } else if (pathSet.has(id) && !ref) row.addClass("fp-onpath");
      if (ref) row.addClass("fp-row-ref");
      if (n.done) row.addClass("fp-done");
      for (let i = 0; i < depth; i++) row.createSpan({ cls: "fp-guide" });

      const chev = row.createSpan({ cls: "fp-chev" + (expandable ? "" : " is-empty") + (open ? " is-open" : "") });
      if (expandable) {
        icon(chev, "chevron-right");
        chev.addEventListener("click", (e) => {
          e.stopPropagation();
          ovm.set(id, !open);
          this.render(el, host);
        });
        chev.addEventListener("dblclick", (e) => e.stopPropagation());
      }
      if (ref) icon(row, "corner-down-right", "fp-ref-ico");
      else row.createSpan({ cls: "fp-dot" });
      const t = row.createSpan({ cls: "fp-row-title", text: n.title });
      if (ref) t.addClass("fp-ref-title");
      edgePill(row, edgeLabel);
      row.createSpan({ cls: "fp-row-spacer" });
      if (!ref) {
        if (n.note) noteButton(row, host, n);
        if (n.done) doneMark(row);
        const deg = childrenOf(chart, id).length;
        if (deg) row.createSpan({ cls: "fp-row-count", text: String(deg) });
        const add = icon(row, "plus", "fp-row-add");
        add.setAttr("aria-label", "Add option");
        add.addEventListener("click", (e) => {
          e.stopPropagation();
          host.addOption(id);
        });
        add.addEventListener("dblclick", (e) => e.stopPropagation());
      }
      bindNode(row, host, id);

      if (open) {
        const treeKids = new Set(kids);
        for (const l of childrenOf(chart, id)) {
          if (treeKids.has(l.node.id) && sp.parent.get(l.node.id) === id) addRow(parent, l.node.id, depth + 1, l.edge.label, false);
          else addRow(parent, l.node.id, depth + 1, l.edge.label, true);
        }
      }
    };

    // children of collapsed-away nodes still count as tree, so only expanded subtrees render
    const [first, ...others] = sp.roots;
    addRow(root, first, 0, undefined, false);
    if (others.length) {
      root.createDiv({ cls: "fp-outline-sub", text: "Not connected" });
      for (const r of others) addRow(root, r, 0, undefined, false);
    }

    if (prevScroll) root.scrollTop = prevScroll;
    const cr = currentRow as HTMLElement | null;
    if (cr) cr.scrollIntoView({ block: "nearest" });
    this.keys.bind(el, host, {
      extra: (e, cur) => {
        // arrows walk the visible list; left/right collapse/expand
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          if (!childrenOf(chart, cur).length) return e.key === "ArrowLeft" ? this.up(sp, cur) : false;
          const open = isOpen(cur, sp.depth.get(cur) ?? 0);
          if (e.key === "ArrowRight" && !open) ovm.set(cur, true);
          else if (e.key === "ArrowLeft" && open) ovm.set(cur, false);
          else return e.key === "ArrowLeft" ? this.up(sp, cur) : false;
          this.render(el, host);
          return true;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          const rows = Array.from(root.querySelectorAll<HTMLElement>(".fp-row:not(.fp-row-ref)"));
          const i = rows.findIndex((r) => r.dataset.id === cur);
          const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
          if (next?.dataset.id) host.select(next.dataset.id);
          return true;
        }
        return false;
      },
    });
  }

  private up(sp: Spanning, cur: string): boolean {
    const p = sp.parent.get(cur);
    if (p && this.host) this.host.select(p);
    return true;
  }

  destroy(): void {
    this.keys.unbind();
    releaseRoot(this.el);
    this.el = undefined;
    this.host = undefined;
  }
}
