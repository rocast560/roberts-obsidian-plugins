import { describe, expect, it } from "vitest";
import {
  addChild, chartFromOutline, childrenOf, connect, deleteNode, emptyChart, moveChild,
  parseChart, pathTo, resolveNode, serializeChart, spanningTree,
} from "../src/model";
import { layoutChart } from "../src/layout";

describe("model", () => {
  it("round-trips and repairs", () => {
    const c = emptyChart("T");
    const a = addChild(c, c.root, "A");
    c.edges.push({ from: a.id, to: "missing" });
    const back = parseChart(serializeChart(c));
    expect(back.edges).toHaveLength(1);
    expect(back.nodes[a.id].title).toBe("A");
    const fresh = parseChart("");
    expect(fresh.nodes[fresh.root]).toBeTruthy();
  });

  it("paths, resolve, move, delete", () => {
    const c = emptyChart("Root");
    const a = addChild(c, c.root, "A");
    const b = addChild(c, c.root, "B");
    const x = addChild(c, a.id, "X");
    expect(connect(c, b.id, x.id)).toBe(true);
    expect(connect(c, b.id, x.id)).toBe(false);
    expect(pathTo(c, x.id)).toEqual([c.root, a.id, x.id]);
    expect(resolveNode(c, "#x")?.id).toBe(x.id);
    moveChild(c, c.root, b.id, -1);
    expect(childrenOf(c, c.root).map((l) => l.node.title)).toEqual(["B", "A"]);
    // X is reachable via B, so deleting A's subtree keeps X
    expect(deleteNode(c, a.id, true)).toEqual([a.id]);
    expect(c.nodes[x.id]).toBeTruthy();
    expect(deleteNode(c, c.root)).toEqual([]);
  });

  it("builds a sequence from a flat list", () => {
    const md = "- Recon\n    - Port scan\n- Initial Access\n- [[Escalate privileges|Escalate]]\n";
    const c = chartFromOutline(md, "Attack", "sequence");
    expect(c.nodes[c.root].title).toBe("Recon");
    const kids = childrenOf(c, c.root).map((l) => l.node.title);
    expect(kids).toEqual(["Port scan", "Initial Access"]);
    const esc = resolveNode(c, "Escalate")!;
    expect(esc.note).toBe("Escalate privileges");
    expect(pathTo(c, esc.id)).toHaveLength(3);
  });

  it("lays out without overlap and handles cycles", () => {
    const c = emptyChart("R");
    const a = addChild(c, c.root, "A");
    const b = addChild(c, c.root, "B");
    addChild(c, a.id, "A1");
    addChild(c, a.id, "A2");
    connect(c, b.id, c.root); // loop back
    const sp = spanningTree(c);
    expect(sp.kids.get(c.root)).toEqual([a.id, b.id]);
    // a later cross-link from a node found earlier in BFS doesn't steal the home parent
    const h = emptyChart("H");
    const early = addChild(h, h.root, "early");
    const mid = addChild(h, h.root, "mid");
    const target = addChild(h, mid.id, "target");
    const cross = addChild(h, early.id, "cross");
    connect(h, cross.id, target.id); // cross is depth 2, same as target's real parent's child level
    connect(h, early.id, target.id);
    expect(spanningTree(h).parent.get(target.id)).toBe(mid.id);
    // a node whose only parent is unreachable from the root still gets placed via the fallback
    const f = emptyChart("F");
    const x1 = addChild(f, f.root, "x1");
    const y1 = addChild(f, x1.id, "y1");
    f.edges = [{ from: y1.id, to: x1.id }, ...f.edges]; // y1 becomes x1's "home" parent (a cycle)
    const fsp = spanningTree(f);
    expect(fsp.parent.get(x1.id)).toBe(f.root);
    expect(fsp.parent.get(y1.id)).toBe(x1.id);
    for (const dir of ["TB", "LR"] as const) {
      const l = layoutChart(c, { dir, collapsed: new Set() });
      expect(l.nodes.size).toBe(5);
      const boxes = [...l.nodes.values()];
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const p = boxes[i], q = boxes[j];
          const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
          expect(overlap).toBe(false);
        }
      expect(l.edges.filter((e) => !e.tree)).toHaveLength(1);
    }
    // sequence spine: steps share a column, options never overlap anything
    const s = chartFromOutline("- S1\n  - a\n  - b\n    - b1\n- S2\n  - c\n- S3\n", "T", "sequence");
    for (const dir of ["TB", "LR"] as const) {
      const l = layoutChart(s, { dir, collapsed: new Set() });
      const boxes = [...l.nodes.values()];
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const p = boxes[i], q = boxes[j];
          expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h).toBe(false);
        }
      const steps = ["S1", "S2", "S3"].map((t) => l.nodes.get(resolveNode(s, t)!.id)!);
      const key = dir === "TB" ? "x" : "y";
      expect(new Set(steps.map((n) => n[key])).size).toBe(1);
      expect(Math.min(...boxes.map((b) => Math.min(b.x, b.y)))).toBeGreaterThanOrEqual(0);
    }
    const col = layoutChart(c, { dir: "TB", collapsed: new Set([a.id]) });
    expect(col.nodes.size).toBe(3);
    expect(col.nodes.get(a.id)!.hiddenKids).toBe(2);
  });
});
