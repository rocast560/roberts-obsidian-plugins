import { describe, it, expect } from "vitest";
import {
  nodeUri,
  nodeMarkdownLink,
  parseNodeUri,
  isNodeUri,
  parseEmbedSource,
  embedBlock,
  noteBody,
  truncateAtLine,
  sanitizeName,
  uniquePath,
  listBlockAround,
  nodeUriAt,
} from "../src/links";

describe("nodeUriAt", () => {
  const u = "obsidian://flowpath?vault=V&chart=c1&file=a.flowpath&node=n1";
  it("finds the uri when the cursor is on the link text or the url", () => {
    const line = `- [Recon](${u}) next`;
    expect(nodeUriAt(line, 4)).toBe(u);
    expect(nodeUriAt(line, line.indexOf("chart"))).toBe(u);
  });
  it("handles escaped brackets in the link text", () => {
    const line = nodeMarkdownLink("V", "c1", "a.flowpath", "n1", "Step [1]");
    expect(nodeUriAt(line, 2)).toBe(line.slice(line.indexOf("(") + 1, -1));
  });
  it("finds angle-bracket and bare uris", () => {
    expect(nodeUriAt(`see <${u}>`, 6)).toBe(u);
    expect(nodeUriAt(`see ${u} ok`, 6)).toBe(u);
  });
  it("returns null off the link and for other links", () => {
    const line = `text [Recon](${u}) more [x](https://example.com)`;
    expect(nodeUriAt(line, 1)).toBeNull();
    expect(nodeUriAt(line, line.indexOf("example"))).toBeNull();
  });
});

describe("node links", () => {
  it("builds and parses a uri", () => {
    const u = nodeUri("My Vault", "c123", "Pentest/Attack Path.flowpath", "n1");
    expect(u).toBe("obsidian://flowpath?vault=My%20Vault&chart=c123&file=Pentest%2FAttack%20Path.flowpath&node=n1");
    expect(parseNodeUri(u)).toEqual({ vault: "My Vault", chart: "c123", file: "Pentest/Attack Path.flowpath", node: "n1", mode: undefined });
  });
  it("escapes brackets in the title and parens in the path", () => {
    const l = nodeMarkdownLink("V", "c", "a (b).flowpath", "n", "Step [1]");
    expect(l.startsWith("[Step \\[1\\]](obsidian://flowpath?")).toBe(true);
    expect(l).not.toMatch(/\(b\)/);
    const href = l.slice(l.indexOf("](") + 2, -1);
    expect(parseNodeUri(href)?.file).toBe("a (b).flowpath");
  });
  it("rejects other uris and reads mode", () => {
    expect(isNodeUri("obsidian://open?vault=x")).toBe(false);
    expect(parseNodeUri("https://x")).toBeNull();
    expect(parseNodeUri("obsidian://flowpath?chart=c&mode=focus")?.mode).toBe("focus");
    expect(parseNodeUri("obsidian://flowpath?chart=c&mode=bogus")?.mode).toBeUndefined();
  });
});

describe("embed source", () => {
  it("parses keys with defaults", () => {
    expect(parseEmbedSource("chart: Attack Path\nnode: Recon\nview: Focus\nheight: 500")).toEqual({ chart: "Attack Path", node: "Recon", view: "focus", height: 500 });
    expect(parseEmbedSource("chart: [[Attack Path]]")).toEqual({ chart: "Attack Path", node: undefined, view: "map", height: 420 });
    expect(parseEmbedSource("nonsense\nview: nope\nheight: 5").view).toBe("map");
    expect(parseEmbedSource("height: 5").height).toBe(420);
  });
  it("round-trips through embedBlock", () => {
    const b = embedBlock("A/B.flowpath", { view: "outline", height: 300 });
    const src = b.split("\n").slice(1, -1).join("\n");
    expect(parseEmbedSource(src)).toEqual({ chart: "A/B.flowpath", node: undefined, view: "outline", height: 300 });
  });
});

describe("note body", () => {
  it("strips frontmatter and the flowpath line", () => {
    const t = "---\ntags: a\n---\n> [!flowpath] [↗ X in Y](obsidian://flowpath?chart=c)\n\nHello\nworld\n";
    expect(noteBody(t)).toBe("Hello\nworld");
  });
  it("truncates at a line boundary", () => {
    const t = "aaaa\nbbbb\ncccc\ndddd";
    expect(truncateAtLine(t, 100)).toBe(t);
    expect(truncateAtLine(t, 12)).toBe("aaaa\nbbbb\n\n…");
  });
});

describe("names", () => {
  it("sanitizes", () => {
    expect(sanitizeName('a/b:c*d?"e<f>g|h#i^j[k]l')).toBe("a b c d e f g h i j k l");
    expect(sanitizeName("  ///  ")).toBe("Untitled");
  });
  it("finds unique paths", () => {
    const taken = new Set(["a/x.flowpath", "a/x 2.flowpath"]);
    expect(uniquePath("a/x.flowpath", (p) => taken.has(p))).toBe("a/x 3.flowpath");
    expect(uniquePath("a/y.flowpath", (p) => taken.has(p))).toBe("a/y.flowpath");
    expect(uniquePath("a/dir.d/x", (p) => p === "a/dir.d/x")).toBe("a/dir.d/x 2");
  });
});

describe("list block", () => {
  it("finds the block around a line", () => {
    const lines = ["intro", "", "- a", "  - b", "- c", "", "tail"];
    expect(listBlockAround(lines, 3)).toEqual([2, 4]);
    expect(listBlockAround(lines, 0)).toBeNull();
    expect(listBlockAround(lines, 5)).toBeNull();
  });
});
