import { describe, expect, it } from "vitest";
import { applyWidth, findEmbedAt, rewriteWidth } from "../src/linkRewrite";

describe("rewriteWidth — wiki embeds", () => {
  it("appends width when there is none", () => {
    expect(rewriteWidth("![[a.png]]", 420)).toBe("![[a.png|420]]");
  });
  it("replaces an existing width", () => {
    expect(rewriteWidth("![[a.png|300]]", 420)).toBe("![[a.png|420]]");
  });
  it("collapses WxH to width-only", () => {
    expect(rewriteWidth("![[a.png|300x200]]", 420)).toBe("![[a.png|420]]");
  });
  it("keeps a caption and appends width", () => {
    expect(rewriteWidth("![[a.png|caption]]", 420)).toBe("![[a.png|caption|420]]");
  });
  it("keeps a caption and replaces width", () => {
    expect(rewriteWidth("![[a.png|caption|300]]", 420)).toBe("![[a.png|caption|420]]");
  });
  it("never treats the target itself as a size", () => {
    expect(rewriteWidth("![[300]]", 420)).toBe("![[300|420]]");
  });
});

describe("rewriteWidth — markdown embeds", () => {
  it("appends width to alt text", () => {
    expect(rewriteWidth("![alt](a.png)", 420)).toBe("![alt|420](a.png)");
  });
  it("uses width as alt when alt is empty", () => {
    expect(rewriteWidth("![](a.png)", 420)).toBe("![420](a.png)");
  });
  it("replaces an existing width in alt", () => {
    expect(rewriteWidth("![alt|300](a.png)", 420)).toBe("![alt|420](a.png)");
  });
  it("replaces a bare numeric alt (it is a size)", () => {
    expect(rewriteWidth("![300](a.png)", 420)).toBe("![420](a.png)");
  });
  it("collapses WxH in alt to width-only", () => {
    expect(rewriteWidth("![alt|300x200](a.png)", 420)).toBe("![alt|420](a.png)");
  });
  it("works with remote URLs", () => {
    expect(rewriteWidth("![pic](https://example.com/a.png)", 420)).toBe(
      "![pic|420](https://example.com/a.png)"
    );
  });
});

describe("findEmbedAt", () => {
  it("finds a wiki embed containing ch", () => {
    expect(findEmbedAt("foo ![[a.png]] bar", 8)).toEqual({
      start: 4,
      end: 14,
      text: "![[a.png]]",
    });
  });
  it("is inclusive at both ends of the span", () => {
    expect(findEmbedAt("foo ![[a.png]] bar", 4)).not.toBeNull();
    expect(findEmbedAt("foo ![[a.png]] bar", 14)).not.toBeNull();
  });
  it("returns null outside any embed", () => {
    expect(findEmbedAt("foo ![[a.png]] bar", 2)).toBeNull();
    expect(findEmbedAt("foo ![[a.png]] bar", 16)).toBeNull();
  });
  it("picks the right embed among several", () => {
    const line = "![[a.png]] and ![[b.png]]";
    expect(findEmbedAt(line, 20)?.text).toBe("![[b.png]]");
  });
  it("finds a markdown embed", () => {
    expect(findEmbedAt("x ![alt](a.png) y", 6)?.text).toBe("![alt](a.png)");
  });
  it("does not double-match a wiki embed as markdown", () => {
    const line = "![[a.png]] ![b](b.png)";
    expect(findEmbedAt(line, 3)?.text).toBe("![[a.png]]");
    expect(findEmbedAt(line, 15)?.text).toBe("![b](b.png)");
  });
  it("returns null on a line with no embeds", () => {
    expect(findEmbedAt("no images! just text", 5)).toBeNull();
  });
});

describe("applyWidth", () => {
  it("produces the edit range and new text", () => {
    expect(applyWidth("foo ![[a.png]] bar", 8, 420)).toEqual({
      startCh: 4,
      endCh: 14,
      newText: "![[a.png|420]]",
    });
  });
  it("returns null when ch is not in an embed", () => {
    expect(applyWidth("foo ![[a.png]] bar", 1, 420)).toBeNull();
  });

  describe("zero-gap adjacent embeds (boundary ch shared by two spans)", () => {
    const line = "![[a.png]]![[b.png]]";
    // ch=10 is both the inclusive end of a.png's span and the start of b.png's span.

    it("targets the b embed when the hint matches it", () => {
      expect(applyWidth(line, 10, 420, "b.png")).toEqual({
        startCh: 10,
        endCh: 20,
        newText: "![[b.png|420]]",
      });
    });

    it("falls back to the positional first match when no hint is given", () => {
      expect(applyWidth(line, 10, 420)).toEqual({
        startCh: 0,
        endCh: 10,
        newText: "![[a.png|420]]",
      });
    });

    it("targets the a embed when the hint matches it", () => {
      expect(applyWidth(line, 10, 420, "a.png")).toEqual({
        startCh: 0,
        endCh: 10,
        newText: "![[a.png|420]]",
      });
    });

    it("falls back to the positional first match when the hint matches no candidate", () => {
      expect(applyWidth(line, 10, 420, "c.png")).toEqual({
        startCh: 0,
        endCh: 10,
        newText: "![[a.png|420]]",
      });
    });
  });
});
