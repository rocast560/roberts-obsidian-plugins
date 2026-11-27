// Pure chart operations. No Obsidian imports here, so this is unit-testable.
import type { Chart, FlowEdge, FlowNode } from "./types";

export function newId(prefix = "n"): string {
  return prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

export function emptyChart(title: string): Chart {
  const root: FlowNode = { id: newId(), title };
  return { version: 1, id: newId("c"), title, root: root.id, nodes: { [root.id]: root }, edges: [] };
}

/** Tolerant parse. Empty text gives a fresh chart. Repairs dangling edges and a missing root. */
export function parseChart(text: string, fallbackTitle = "Untitled"): Chart {
  if (!text || !text.trim()) return emptyChart(fallbackTitle);
  const raw = JSON.parse(text) as Partial<Chart>;
  const nodes: Record<string, FlowNode> = {};
  for (const [k, n] of Object.entries(raw.nodes ?? {})) {
    if (!n || typeof n !== "object") continue;
    const id = (n as FlowNode).id || k;
    nodes[id] = { ...(n as FlowNode), id, title: String((n as FlowNode).title ?? "Untitled") };
  }
  if (Object.keys(nodes).length === 0) {
    const r: FlowNode = { id: newId(), title: raw.title || fallbackTitle };
    nodes[r.id] = r;
  }
  const seen = new Set<string>();
  const edges: FlowEdge[] = [];
  for (const e of raw.edges ?? []) {
    if (!e || !nodes[e.from] || !nodes[e.to] || e.from === e.to) continue;
    const key = e.from + "\u0000" + e.to;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e.label ? { from: e.from, to: e.to, label: e.label } : { from: e.from, to: e.to });
  }
  const root = raw.root && nodes[raw.root] ? raw.root : Object.keys(nodes)[0];
  return {
    version: 1,
    id: raw.id || newId("c"),
    title: raw.title || fallbackTitle,
    root,
    nodes,
    edges,
  };
}

export function serializeChart(c: Chart): string {
  return JSON.stringify(c, null, 2) + "\n";
}

export interface Link {
  edge: FlowEdge;
  node: FlowNode;
}

/** Options that follow `id`, in order. */
export function childrenOf(c: Chart, id: string): Link[] {
  return c.edges.filter((e) => e.from === id && c.nodes[e.to]).map((e) => ({ edge: e, node: c.nodes[e.to] }));
}

/** Nodes that lead into `id`. */
export function parentsOf(c: Chart, id: string): Link[] {
  return c.edges.filter((e) => e.to === id && c.nodes[e.from]).map((e) => ({ edge: e, node: c.nodes[e.from] }));
}

export function addChild(c: Chart, parentId: string, title: string, label?: string): FlowNode {
  const n: FlowNode = { id: newId(), title };
  c.nodes[n.id] = n;
  c.edges.push(label ? { from: parentId, to: n.id, label } : { from: parentId, to: n.id });
  return n;
}

/** Adds an edge. Returns false for self-loops, duplicates or unknown nodes. Cycles are allowed (loops back are real in a playbook). */
export function connect(c: Chart, from: string, to: string, label?: string): boolean {
  if (from === to || !c.nodes[from] || !c.nodes[to]) return false;
  if (c.edges.some((e) => e.from === from && e.to === to)) return false;
  c.edges.push(label ? { from, to, label } : { from, to });
  return true;
}

export function disconnect(c: Chart, from: string, to: string): void {
  c.edges = c.edges.filter((e) => !(e.from === from && e.to === to));
}

export function setEdgeLabel(c: Chart, from: string, to: string, label: string): void {
  const e = c.edges.find((x) => x.from === from && x.to === to);
  if (!e) return;
  if (label.trim()) e.label = label.trim();
  else delete e.label;
}

/** Moves `child` up (-1) or down (+1) among the options of `parent`. */
export function moveChild(c: Chart, parent: string, child: string, dir: -1 | 1): void {
  const idx = c.edges.findIndex((e) => e.from === parent && e.to === child);
  if (idx < 0) return;
  let j = idx + dir;
  while (j >= 0 && j < c.edges.length && c.edges[j].from !== parent) j += dir;
  if (j < 0 || j >= c.edges.length) return;
  const tmp = c.edges[idx];
  c.edges[idx] = c.edges[j];
  c.edges[j] = tmp;
}

/**
 * Nodes that would be left unreachable from the root if `id` were deleted
 * (its exclusive subtree, including `id`).
 */
export function exclusiveSubtree(c: Chart, id: string): string[] {
  const reach = reachableFrom(c, c.root, id);
  const out: string[] = [];
  for (const k of reachableFrom(c, id)) if (!reach.has(k)) out.push(k);
  return out;
}

/** Deletes a node (and, if `withSubtree`, everything only reachable through it). The root cannot be deleted. */
export function deleteNode(c: Chart, id: string, withSubtree = false): string[] {
  if (id === c.root || !c.nodes[id]) return [];
  const doomed = withSubtree ? exclusiveSubtree(c, id) : [id];
  const set = new Set(doomed);
  for (const k of doomed) delete c.nodes[k];
  c.edges = c.edges.filter((e) => !set.has(e.from) && !set.has(e.to));
  return doomed;
}

/** BFS reachability from `start`, optionally not passing through `blocked`. */
export function reachableFrom(c: Chart, start: string, blocked?: string): Set<string> {
  const seen = new Set<string>();
  if (!c.nodes[start] || start === blocked) return seen;
  const q = [start];
  seen.add(start);
  while (q.length) {
    const cur = q.shift()!;
    for (const e of c.edges) {
      if (e.from !== cur || seen.has(e.to) || e.to === blocked || !c.nodes[e.to]) continue;
      seen.add(e.to);
      q.push(e.to);
    }
  }
  return seen;
}

/** Shortest path root → id as a list of ids (inclusive). Falls back to [id] for unreachable nodes. */
export function pathTo(c: Chart, id: string): string[] {
  if (!c.nodes[id]) return [c.root];
  const prev = new Map<string, string | null>([[c.root, null]]);
  const q = [c.root];
  while (q.length) {
    const cur = q.shift()!;
    if (cur === id) break;
    for (const e of c.edges) {
      if (e.from !== cur || prev.has(e.to) || !c.nodes[e.to]) continue;
      prev.set(e.to, cur);
      q.push(e.to);
    }
  }
  if (!prev.has(id)) return [id];
  const out: string[] = [];
  for (let k: string | null = id; k !== null; k = prev.get(k) ?? null) out.unshift(k);
  return out;
}

/** Finds a node by id, then by exact title, then case-insensitive title. Accepts a leading "#" or "^". */
export function resolveNode(c: Chart, ref: string | undefined | null): FlowNode | undefined {
  if (!ref) return undefined;
  const r = decodeURIComponent(ref).replace(/^[#^]+/, "").trim();
  if (!r) return undefined;
  if (c.nodes[r]) return c.nodes[r];
  const all = Object.values(c.nodes);
  return all.find((n) => n.title === r) ?? all.find((n) => n.title.toLowerCase() === r.toLowerCase());
}

/** Nodes not reachable from the root, which have no parents themselves (starts of detached islands). */
export function detachedRoots(c: Chart): string[] {
  const reach = reachableFrom(c, c.root);
  const out: string[] = [];
  for (const id of Object.keys(c.nodes)) {
    if (reach.has(id)) continue;
    if (parentsOf(c, id).length === 0) out.push(id);
  }
  // islands that are pure cycles have no parent-less node; pick one member of each
  const covered = new Set<string>(reach);
  for (const r of out) for (const k of reachableFrom(c, r)) covered.add(k);
  for (const id of Object.keys(c.nodes)) {
    if (covered.has(id)) continue;
    out.push(id);
    for (const k of reachableFrom(c, id)) covered.add(k);
  }
  return out;
}

export interface Spanning {
  /** Starts: [root, ...detached roots]. */
  roots: string[];
  /** Tree children (BFS first discovery), in option order. */
  kids: Map<string, string[]>;
  /** Tree parent of each node (undefined for roots). */
  parent: Map<string, string>;
  depth: Map<string, number>;
}

/**
 * Spanning forest. Each node appears exactly once; non-tree edges are cross/back links.
 * A node's tree parent is its "home" parent: the source of its first incoming edge, which is
 * the node it was created under (later "connect to existing" edges come after it). Nodes whose
 * home parent can't reach them (cycles, detached parents) attach through any edge, BFS order.
 */
export function spanningTree(c: Chart): Spanning {
  const roots = [c.root, ...detachedRoots(c)];
  const kids = new Map<string, string[]>();
  const parent = new Map<string, string>();
  const depth = new Map<string, number>();
  const home = new Map<string, string>();
  for (const e of c.edges) if (!home.has(e.to) && c.nodes[e.from] && c.nodes[e.to]) home.set(e.to, e.from);

  const attach = (from: string, to: string) => {
    depth.set(to, depth.get(from)! + 1);
    parent.set(to, from);
    kids.get(from)!.push(to);
  };
  const order: string[] = [];
  const grow = (start: string) => {
    // expand along home edges only
    const q = [start];
    while (q.length) {
      const cur = q.shift()!;
      order.push(cur);
      if (!kids.has(cur)) kids.set(cur, []);
      for (const e of c.edges) {
        if (e.from !== cur || depth.has(e.to) || !c.nodes[e.to] || home.get(e.to) !== cur) continue;
        attach(cur, e.to);
        kids.set(e.to, []);
        q.push(e.to);
      }
    }
  };

  for (const r of roots) {
    if (depth.has(r)) continue;
    depth.set(r, 0);
    grow(r);
    // fallback: anything still unplaced but reachable gets attached via its first edge from a placed node
    for (let changed = true; changed; ) {
      changed = false;
      for (const cur of [...order]) {
        for (const e of c.edges) {
          if (e.from !== cur || depth.has(e.to) || !c.nodes[e.to]) continue;
          attach(cur, e.to);
          grow(e.to);
          changed = true;
        }
      }
    }
  }
  // keep each parent's tree children in option (edge) order
  for (const [p, list] of kids) {
    const rank = new Map<string, number>();
    c.edges.forEach((e, i) => { if (e.from === p && !rank.has(e.to)) rank.set(e.to, i); });
    list.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  }
  return { roots, kids, parent, depth };
}

export function descendantCount(c: Chart, id: string): number {
  return reachableFrom(c, id).size - 1;
}

export type OutlineMode = "sequence" | "options";

/**
 * Builds a chart from a markdown bullet/numbered list.
 * Nested items become options of their parent item.
 * Top-level items: "sequence" chains them (step 1 → step 2 → ...), each step keeping
 * its nested options; "options" hangs them all off a start node named `title`.
 * `[[Note]]` / `[[Note|Alias]]` in an item sets node.note and uses the alias/name as title.
 */
export function chartFromOutline(md: string, title: string, mode: OutlineMode): Chart {
  interface Item { title: string; note?: string; desc?: string; kids: Item[]; indent: number }
  const top: Item[] = [];
  const stack: Item[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^([ \t]*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/.exec(line);
    if (!m) {
      // continuation text under an item becomes its description
      const t = line.trim();
      if (t && stack.length) {
        const last = stack[stack.length - 1];
        last.desc = last.desc ? last.desc + "\n" + t : t;
      }
      continue;
    }
    const indent = m[1].replace(/\t/g, "    ").length;
    let text = m[2];
    let note: string | undefined;
    const wl = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(text);
    if (wl) {
      note = wl[1].trim();
      text = text.replace(wl[0], (wl[2] ?? wl[1]).trim());
    }
    const item: Item = { title: text.replace(/\*\*|__|`/g, "").trim(), note, kids: [], indent };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length) stack[stack.length - 1].kids.push(item);
    else top.push(item);
    stack.push(item);
  }

  const c = emptyChart(title);
  const add = (parent: string, it: Item): string => {
    const n = addChild(c, parent, it.title);
    if (it.note) n.note = it.note;
    if (it.desc) n.desc = it.desc;
    for (const k of it.kids) add(n.id, k);
    return n.id;
  };

  if (mode === "options" || top.length === 0) {
    for (const it of top) add(c.root, it);
    return c;
  }

  // sequence: the first top-level item becomes the root itself
  const first = top[0];
  const root = c.nodes[c.root];
  root.title = first.title;
  if (first.note) root.note = first.note;
  if (first.desc) root.desc = first.desc;
  for (const k of first.kids) add(root.id, k);
  let prev = root.id;
  for (const it of top.slice(1)) {
    const n = addChild(c, prev, it.title, "next");
    if (it.note) n.note = it.note;
    if (it.desc) n.desc = it.desc;
    for (const k of it.kids) add(n.id, k);
    prev = n.id;
  }
  return c;
}
