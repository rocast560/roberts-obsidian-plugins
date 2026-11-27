// Tidy layered layout over the BFS spanning forest. Pure, no DOM.
import { spanningTree } from "./model";
import type { Chart, Direction } from "./types";

export interface LayoutOptions {
  dir: Direction;
  /** Nodes whose options are hidden. */
  collapsed: Set<string>;
  nodeW?: number;
  nodeH?: number;
  /** Gap between siblings (across the flow). */
  gapAcross?: number;
  /** Gap between levels (along the flow). */
  gapAlong?: number;
}

export interface LayoutNode {
  id: string;
  /** Top-left corner, in world pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  /** Tree children hidden because this node is collapsed (0 when expanded or a leaf). */
  hiddenKids: number;
  /** Number of options (outgoing edges) regardless of collapse. */
  outDegree: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  label?: string;
  /** True when this edge is in the spanning tree; false = cross/back link (draw dashed). */
  tree: boolean;
  /** Start (exit side of `from`) and end (entry side of `to`) points in world pixels. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Layout {
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  width: number;
  height: number;
  dir: Direction;
}

/** "next", "next phase", "next step"...: an edge to the following step of a sequence, not a sub-option. */
export function isSequenceLabel(label: string | undefined): boolean {
  return !!label && /^next\b/i.test(label.trim());
}

export function layoutChart(c: Chart, opts: LayoutOptions): Layout {
  const nodeW = opts.nodeW ?? 210;
  const nodeH = opts.nodeH ?? 64;
  const gapAcross = opts.gapAcross ?? 28;
  const gapAlong = opts.gapAlong ?? (opts.dir === "TB" ? 70 : 90);
  const tb = opts.dir === "TB";
  // "across" = breadth axis, "along" = flow axis
  const sizeAcross = tb ? nodeW : nodeH;
  const sizeAlong = tb ? nodeH : nodeW;

  const sp = spanningTree(c);
  const visible = new Set<string>();
  const step = sizeAcross + gapAcross;

  // Block layout. Each node's block holds its subtree as (across px, row) offsets.
  // Plain options: parent centred over its children, children side by side.
  // A "next…" edge (sequence step) is a spine: the next step goes in the same
  // column, below everything of the current step, and the current step's
  // options sit one column over so the spine line stays clear.
  interface Block { pos: Map<string, { a: number; row: number }>; minA: number; maxA: number; rows: number }
  const labelOf = (from: string, to: string) => c.edges.find((e) => e.from === from && e.to === to)?.label;

  const block = (id: string, onSpine = false): Block => {
    visible.add(id);
    const kids = opts.collapsed.has(id) ? [] : sp.kids.get(id) ?? [];
    const seqKid = kids.find((k) => isSequenceLabel(labelOf(id, k)));
    const optKids = kids.filter((k) => k !== seqKid);
    const pos = new Map<string, { a: number; row: number }>();

    // options, side by side starting at 0
    let cursor = 0;
    let optRows = 0;
    const roots: number[] = [];
    for (const k of optKids) {
      const b = block(k);
      const shift = cursor - b.minA;
      for (const [nid, p] of b.pos) pos.set(nid, { a: p.a + shift, row: p.row + 1 });
      roots.push(b.pos.get(k)!.a + shift);
      cursor += b.maxA - b.minA + step;
      optRows = Math.max(optRows, b.rows);
    }

    let selfA: number;
    if (seqKid || (onSpine && optKids.length)) {
      // spine column at 0, options start one column to the right
      selfA = 0;
      if (optKids.length) for (const p of pos.values()) p.a += step;
      const rowOff = 1 + optRows;
      let rows = rowOff;
      if (seqKid) {
        const s = block(seqKid, true);
        const shift = selfA - s.pos.get(seqKid)!.a;
        for (const [nid, p] of s.pos) pos.set(nid, { a: p.a + shift, row: p.row + rowOff });
        rows = rowOff + s.rows;
      }
      pos.set(id, { a: selfA, row: 0 });
      let minA = Infinity, maxA = -Infinity;
      for (const p of pos.values()) { minA = Math.min(minA, p.a); maxA = Math.max(maxA, p.a); }
      return { pos, minA, maxA, rows };
    }

    selfA = roots.length ? (roots[0] + roots[roots.length - 1]) / 2 : 0;
    pos.set(id, { a: selfA, row: 0 });
    let minA = Infinity, maxA = -Infinity;
    for (const p of pos.values()) { minA = Math.min(minA, p.a); maxA = Math.max(maxA, p.a); }
    return { pos, minA, maxA, rows: 1 + optRows };
  };

  const across = new Map<string, number>();
  const rowOf = new Map<string, number>();
  let cursor = 0;
  for (const r of sp.roots) {
    if (visible.has(r)) continue;
    const b = block(r);
    const shift = cursor - b.minA;
    for (const [nid, p] of b.pos) {
      across.set(nid, p.a + shift);
      rowOf.set(nid, p.row);
    }
    cursor += b.maxA - b.minA + step + gapAcross * 2; // breathing room between islands
  }

  const nodes = new Map<string, LayoutNode>();
  let maxX = 0;
  let maxY = 0;
  for (const id of visible) {
    const d = rowOf.get(id) ?? 0;
    const a = across.get(id)!;
    const l = d * (sizeAlong + gapAlong);
    const x = tb ? a : l;
    const y = tb ? l : a;
    const kids = sp.kids.get(id) ?? [];
    nodes.set(id, {
      id,
      x,
      y,
      w: nodeW,
      h: nodeH,
      depth: d,
      hiddenKids: opts.collapsed.has(id) ? kids.length : 0,
      outDegree: c.edges.filter((e) => e.from === id).length,
    });
    maxX = Math.max(maxX, x + nodeW);
    maxY = Math.max(maxY, y + nodeH);
  }

  const edges: LayoutEdge[] = [];
  for (const e of c.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) continue;
    if (opts.collapsed.has(e.from)) continue;
    const tree = sp.parent.get(e.to) === e.from;
    const x1 = tb ? a.x + a.w / 2 : a.x + a.w;
    const y1 = tb ? a.y + a.h : a.y + a.h / 2;
    const x2 = tb ? b.x + b.w / 2 : b.x;
    const y2 = tb ? b.y : b.y + b.h / 2;
    edges.push({ from: e.from, to: e.to, label: e.label, tree, x1, y1, x2, y2 });
  }

  return { nodes, edges, width: maxX, height: maxY, dir: opts.dir };
}
