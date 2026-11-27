// Map view: the whole chart on a pan/zoom canvas.
import type { FlowHost, FlowRenderer } from "../host";
import { layoutChart, type Layout, type LayoutEdge, type LayoutNode } from "../layout";
import { childrenOf, parentsOf, pathTo } from "../model";
import { bindNode, colorClass, doneMark, icon, Keys, noteButton, optionsLabel, pathInfo, prepareRoot, releaseRoot } from "./common";

const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const PAD = 40;
let uidCounter = 0;

export class MapRenderer implements FlowRenderer {
  private el?: HTMLElement;
  private host?: FlowHost;
  private viewport?: HTMLElement;
  private world?: HTMLElement;
  private zoomLabel?: HTMLElement;
  private layout?: Layout;
  private ro?: ResizeObserver;
  private pendingInit = false;
  private animFrom?: { panX: number; panY: number; zoom: number; at: number };
  private animTimer?: number;
  private keys = new Keys();

  render(el: HTMLElement, host: FlowHost): void {
    this.cleanupObservers();
    this.el = el;
    this.host = host;
    prepareRoot(el, host, "map");
    const st = host.mapState;
    const layout = layoutChart(host.chart, { dir: st.dir, collapsed: st.collapsed });
    this.layout = layout;
    const uid = ++uidCounter;

    const viewport = el.createDiv({ cls: "fp-map" });
    const world = viewport.createDiv({ cls: "fp-map-world" });
    this.viewport = viewport;
    this.world = world;

    const { set: pathSet, path } = pathInfo(host);
    const hlEdges = new Set<string>();
    for (let i = 1; i < path.length; i++) hlEdges.add(path[i - 1] + "\u0000" + path[i]);

    // edges
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "fp-map-edges");
    svg.setAttribute("width", String(layout.width + 80));
    svg.setAttribute("height", String(layout.height + 80));
    const defs = document.createElementNS(SVG_NS, "defs");
    defs.appendChild(this.marker(uid, "n", "fp-arrowhead"));
    defs.appendChild(this.marker(uid, "h", "fp-arrowhead fp-arrowhead-hl"));
    svg.appendChild(defs);
    world.appendChild(svg);

    const labels: { e: LayoutEdge; x: number; y: number; hl: boolean }[] = [];
    // draw plain edges first so highlighted ones sit on top
    const ordered = [...layout.edges].sort((a, b) => Number(hlEdges.has(a.from + "\u0000" + a.to)) - Number(hlEdges.has(b.from + "\u0000" + b.to)));
    for (const e of ordered) {
      const hl = hlEdges.has(e.from + "\u0000" + e.to);
      const { d, mid } = this.edgePath(e, layout.dir);
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("class", "fp-edge" + (e.tree ? "" : " fp-edge-cross") + (hl ? " fp-edge-hl" : ""));
      p.setAttribute("marker-end", `url(#fp-arrow-${hl ? "h" : "n"}-${uid})`);
      svg.appendChild(p);
      if (e.label) labels.push({ e, x: mid.x, y: mid.y, hl });
    }
    for (const l of labels) {
      const lab = world.createDiv({ cls: "fp-edge-label" + (l.hl ? " fp-edge-label-hl" : ""), text: l.e.label });
      lab.style.left = l.x + "px";
      lab.style.top = l.y + "px";
    }

    // nodes
    for (const ln of layout.nodes.values()) this.buildNode(world, host, ln, pathSet);

    this.buildControls(viewport, host);
    this.attachPanZoom(viewport, host);

    // position
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (Number.isNaN(st.zoom)) {
      if (vw > 0 && vh > 0) this.initialPosition(host, vw, vh);
      else {
        this.pendingInit = true;
        this.applyTransform(1, 0, 0);
        this.ro = new ResizeObserver(() => {
          if (!this.pendingInit || !this.viewport || !this.host) return;
          if (this.viewport.clientWidth > 0 && this.viewport.clientHeight > 0) {
            this.pendingInit = false;
            this.initialPosition(this.host, this.viewport.clientWidth, this.viewport.clientHeight);
            this.ro?.disconnect();
            this.ro = undefined;
          }
        });
        this.ro.observe(viewport);
      }
    } else {
      const af = this.animFrom;
      if (af && Date.now() - af.at < 500) {
        // a reveal() ran just before this render: replay the move from where it started
        this.applyTransform(af.zoom, af.panX, af.panY);
        void world.offsetWidth;
        this.animateTo(st.zoom, st.panX, st.panY);
      } else this.applyTransform(st.zoom, st.panX, st.panY);
    }

    this.keys.bind(el, host, {
      onSelect: (id) => this.reveal(id),
      extra: (e, cur) => this.mapKey(e, cur),
    });
  }

  reveal(id: string): void {
    const host = this.host;
    const vp = this.viewport;
    const ln = this.layout?.nodes.get(id);
    if (!host || !vp || !ln || vp.clientWidth === 0) return;
    const st = host.mapState;
    if (Number.isNaN(st.zoom)) return;
    this.animFrom = { panX: st.panX, panY: st.panY, zoom: st.zoom, at: Date.now() };
    const z = st.zoom;
    const px = vp.clientWidth / 2 - (ln.x + ln.w / 2) * z;
    const py = vp.clientHeight / 2 - (ln.y + ln.h / 2) * z;
    st.panX = px;
    st.panY = py;
    host.saveMapState();
    this.animateTo(z, px, py);
  }

  fit(): void {
    const host = this.host;
    const vp = this.viewport;
    const lay = this.layout;
    if (!host || !vp || !lay || vp.clientWidth === 0) return;
    const t = this.fitTransform(lay, vp.clientWidth, vp.clientHeight, 1.2);
    this.commit(t.zoom, t.panX, t.panY, true);
  }

  destroy(): void {
    this.cleanupObservers();
    this.keys.unbind();
    if (this.animTimer) window.clearTimeout(this.animTimer);
    releaseRoot(this.el);
    this.el = undefined;
    this.host = undefined;
    this.viewport = undefined;
    this.world = undefined;
  }

  // ---------- internals ----------

  private cleanupObservers(): void {
    this.ro?.disconnect();
    this.ro = undefined;
    this.pendingInit = false;
  }

  private marker(uid: number, kind: string, cls: string): SVGElement {
    const m = document.createElementNS(SVG_NS, "marker");
    m.setAttribute("id", `fp-arrow-${kind}-${uid}`);
    m.setAttribute("viewBox", "0 0 10 10");
    m.setAttribute("refX", "9");
    m.setAttribute("refY", "5");
    m.setAttribute("markerWidth", "9");
    m.setAttribute("markerHeight", "9");
    m.setAttribute("markerUnits", "userSpaceOnUse");
    m.setAttribute("orient", "auto");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", "M1,1.5 L9,5 L1,8.5 Z");
    p.setAttribute("class", cls);
    m.appendChild(p);
    return m;
  }

  private edgePath(e: LayoutEdge, dir: "TB" | "LR"): { d: string; mid: { x: number; y: number } } {
    const tb = dir === "TB";
    const along = tb ? e.y2 - e.y1 : e.x2 - e.x1;
    const back = along < 20; // loop back / same level
    const k = back ? 70 : Math.max(30, along * 0.5);
    const c1 = tb ? { x: e.x1, y: e.y1 + k } : { x: e.x1 + k, y: e.y1 };
    const c2 = tb ? { x: e.x2, y: e.y2 - k } : { x: e.x2 - k, y: e.y2 };
    const d = `M${e.x1},${e.y1} C${c1.x},${c1.y} ${c2.x},${c2.y} ${e.x2},${e.y2}`;
    const mid = {
      x: (e.x1 + 3 * c1.x + 3 * c2.x + e.x2) / 8,
      y: (e.y1 + 3 * c1.y + 3 * c2.y + e.y2) / 8,
    };
    return { d, mid };
  }

  private buildNode(world: HTMLElement, host: FlowHost, ln: LayoutNode, pathSet: Set<string>): void {
    const node = host.chart.nodes[ln.id];
    if (!node) return;
    const card = world.createDiv({ cls: "fp-node" });
    card.dataset.id = ln.id;
    const cc = colorClass(node);
    if (cc) card.addClass(cc);
    if (ln.id === host.current) card.addClass("fp-current");
    else if (pathSet.has(ln.id)) card.addClass("fp-onpath");
    if (node.done) card.addClass("fp-done");
    card.style.left = ln.x + "px";
    card.style.top = ln.y + "px";
    card.style.width = ln.w + "px";
    card.style.height = ln.h + "px";

    card.createDiv({ cls: "fp-node-title", text: node.title });
    const meta = card.createDiv({ cls: "fp-node-meta" });
    if (node.done) doneMark(meta);
    if (node.note) noteButton(meta, host, node);
    if (ln.outDegree > 0) meta.createSpan({ cls: "fp-node-count", text: String(ln.outDegree) }).setAttr("aria-label", optionsLabel(ln.outDegree));

    if (ln.outDegree > 0) {
      const tb = host.mapState.dir === "TB";
      const collapsed = ln.hiddenKids > 0 || host.mapState.collapsed.has(ln.id);
      const t = card.createEl("button", { cls: "fp-node-toggle " + (tb ? "fp-toggle-tb" : "fp-toggle-lr") + (collapsed ? " is-collapsed" : "") });
      t.setAttr("aria-label", collapsed ? "Expand options" : "Collapse options");
      if (ln.hiddenKids > 0) t.setText("+" + ln.hiddenKids);
      else if (collapsed) icon(t, "plus");
      else icon(t, tb ? "chevron-down" : "chevron-right");
      t.addEventListener("click", (ev) => {
        ev.stopPropagation();
        host.toggleCollapse(ln.id);
      });
      t.addEventListener("dblclick", (ev) => ev.stopPropagation());
      t.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    }
    bindNode(card, host, ln.id);
  }

  private buildControls(viewport: HTMLElement, host: FlowHost): void {
    const bar = viewport.createDiv({ cls: "fp-controls" });
    bar.addEventListener("pointerdown", (e) => e.stopPropagation());
    bar.addEventListener("dblclick", (e) => e.stopPropagation());
    bar.addEventListener("wheel", (e) => e.stopPropagation());
    const btn = (ic: string, label: string, fn: () => void, text?: string): HTMLElement => {
      const b = bar.createEl("button", { cls: "fp-ctl" });
      b.setAttr("aria-label", label);
      if (text) b.setText(text);
      else icon(b, ic);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    btn("minus", "Zoom out", () => this.zoomBy(1 / 1.25));
    if (!host.compact) this.zoomLabel = bar.createSpan({ cls: "fp-zoom-label", text: "100%" });
    else this.zoomLabel = undefined;
    btn("plus", "Zoom in", () => this.zoomBy(1.25));
    btn("maximize", "Fit chart", () => this.fit());
    if (host.compact) return;
    bar.createSpan({ cls: "fp-ctl-sep" });
    btn("crosshair", "Center on current", () => this.centerOn(host.current));
    btn("", host.mapState.dir === "TB" ? "Switch to left-to-right" : "Switch to top-to-bottom", () => {
      host.mapState.dir = host.mapState.dir === "TB" ? "LR" : "TB";
      host.mapState.zoom = NaN;
      host.saveMapState();
      host.select(host.current);
    }, host.mapState.dir);
    btn("chevrons-down-up", "Expand all", () => {
      if (host.mapState.collapsed.size === 0) return;
      host.mapState.collapsed.clear();
      host.saveMapState();
      host.select(host.current);
    }).addClass("fp-ctl-expand");
  }

  private attachPanZoom(vp: HTMLElement, host: FlowHost): void {
    let drag: { id: number; sx: number; sy: number; px: number; py: number; moved: boolean } | null = null;
    vp.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      if ((e.target as HTMLElement).closest(".fp-node, .fp-controls")) return;
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, px: host.mapState.panX, py: host.mapState.panY, moved: false };
      vp.setPointerCapture(e.pointerId);
      vp.addClass("is-panning");
    });
    vp.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      drag.moved = true;
      this.commit(host.mapState.zoom, drag.px + dx, drag.py + dy, false);
    });
    const end = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      vp.removeClass("is-panning");
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);

    vp.addEventListener(
      "wheel",
      (e) => {
        if (host.compact && !(e.ctrlKey || e.metaKey)) return; // let the note scroll
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const k = Math.exp((-e.deltaY * unit) * (e.ctrlKey ? 0.01 : 0.0018));
        const r = vp.getBoundingClientRect();
        this.zoomAt(host.mapState.zoom * k, e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
  }

  private mapKey(e: KeyboardEvent, cur: string): boolean {
    const host = this.host;
    if (!host) return false;
    const go = (id: string | undefined): boolean => {
      if (!id) return true;
      host.select(id);
      this.reveal(id);
      return true;
    };
    switch (e.key) {
      case "f":
        this.fit();
        return true;
      case "c":
        this.centerOn(cur);
        return true;
      case "+":
      case "=":
        this.zoomBy(1.25);
        return true;
      case "-":
        this.zoomBy(1 / 1.25);
        return true;
    }
    const tb = host.mapState.dir === "TB";
    const kind = ({ ArrowUp: tb ? "parent" : "prev", ArrowDown: tb ? "child" : "next", ArrowLeft: tb ? "prev" : "parent", ArrowRight: tb ? "next" : "child" } as Record<string, string>)[e.key];
    if (!kind) return false;
    const chart = host.chart;
    const parents = parentsOf(chart, cur);
    const p = pathTo(chart, cur);
    const parent = p.length > 1 ? p[p.length - 2] : parents[0]?.node.id;
    if (kind === "parent") return go(parent);
    if (kind === "child") return go(childrenOf(chart, cur)[0]?.node.id);
    if (!parent) return true;
    const sibs = childrenOf(chart, parent).map((l) => l.node.id);
    const i = sibs.indexOf(cur);
    return go(sibs[kind === "next" ? i + 1 : i - 1]);
  }

  // ----- transform handling -----

  private applyTransform(z: number, x: number, y: number): void {
    if (this.world) this.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    if (this.zoomLabel) this.zoomLabel.setText(Math.round(z * 100) + "%");
  }

  private animateTo(z: number, x: number, y: number): void {
    const w = this.world;
    if (!w) return;
    w.addClass("is-animating");
    this.applyTransform(z, x, y);
    if (this.animTimer) window.clearTimeout(this.animTimer);
    this.animTimer = window.setTimeout(() => {
      w.removeClass("is-animating");
      this.animTimer = undefined;
    }, 280);
  }

  /** Writes state, applies it, and asks the host to persist. */
  private commit(z: number, x: number, y: number, animate: boolean): void {
    const host = this.host;
    if (!host) return;
    const st = host.mapState;
    st.zoom = z;
    st.panX = x;
    st.panY = y;
    if (animate) this.animateTo(z, x, y);
    else this.applyTransform(z, x, y);
    host.saveMapState();
  }

  private zoomAt(target: number, cx: number, cy: number, animate = false): void {
    const host = this.host;
    if (!host) return;
    const st = host.mapState;
    const z0 = Number.isNaN(st.zoom) ? 1 : st.zoom;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target));
    const r = z / z0;
    this.commit(z, cx - (cx - st.panX) * r, cy - (cy - st.panY) * r, animate);
  }

  private zoomBy(f: number): void {
    const vp = this.viewport;
    const host = this.host;
    if (!vp || !host) return;
    this.zoomAt(host.mapState.zoom * f, vp.clientWidth / 2, vp.clientHeight / 2, true);
  }

  private centerOn(id: string): void {
    const host = this.host;
    const vp = this.viewport;
    const ln = this.layout?.nodes.get(id);
    if (!host || !vp || !ln) return;
    const z = Number.isNaN(host.mapState.zoom) ? 1 : host.mapState.zoom;
    this.commit(z, vp.clientWidth / 2 - (ln.x + ln.w / 2) * z, vp.clientHeight / 2 - (ln.y + ln.h / 2) * z, true);
  }

  private fitTransform(lay: Layout, vw: number, vh: number, cap: number): { zoom: number; panX: number; panY: number } {
    const w = Math.max(lay.width, 1);
    const h = Math.max(lay.height, 1);
    const pad = vw < 420 || vh < 260 ? 16 : PAD;
    const z = Math.min(cap, Math.max(MIN_ZOOM, Math.min((vw - pad * 2) / w, (vh - pad * 2) / h)));
    // if even the minimum zoom can't fit it, anchor at the top-left (where the start node is) instead of centring
    const panX = w * z + pad * 2 > vw ? pad : (vw - w * z) / 2;
    const panY = h * z + pad * 2 > vh ? pad : (vh - h * z) / 2;
    return { zoom: z, panX, panY };
  }

  private initialPosition(host: FlowHost, vw: number, vh: number): void {
    const lay = this.layout;
    if (!lay) return;
    if (host.current === host.chart.root) {
      const t = this.fitTransform(lay, vw, vh, 1);
      this.commit(t.zoom, t.panX, t.panY, false);
    } else {
      const ln = lay.nodes.get(host.current);
      if (!ln) {
        const t = this.fitTransform(lay, vw, vh, 1);
        this.commit(t.zoom, t.panX, t.panY, false);
        return;
      }
      this.commit(1, vw / 2 - (ln.x + ln.w / 2), vh / 2 - (ln.y + ln.h / 2), false);
    }
  }
}
