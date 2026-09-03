import { describe, expect, it } from "vitest";
import { TOC_END, TOC_START, findTocBlock, renderTocBlock, tocEntries } from "../src/core/toc";

const childrenMap = (map: Record<string, string[]>) => (p: string) => map[p] ?? [];
const betterNotes = (...paths: string[]) => (p: string) => paths.includes(p);

describe("tocEntries", () => {
  it("lists direct sub-betternotes alphabetically at depth 0", () => {
    const entries = tocEntries(
      "Projects",
      childrenMap({ Projects: ["Projects/Website", "Projects/Marketing"] }),
      betterNotes("Projects/Website", "Projects/Marketing"),
    );
    expect(entries).toEqual([
      { folderPath: "Projects/Marketing", depth: 0 },
      { folderPath: "Projects/Website", depth: 0 },
    ]);
  });

  it("nests sub-betternotes of sub-betternotes with increasing depth", () => {
    const entries = tocEntries(
      "Projects",
      childrenMap({
        Projects: ["Projects/Website"],
        "Projects/Website": ["Projects/Website/Blog", "Projects/Website/Homepage"],
      }),
      betterNotes("Projects/Website", "Projects/Website/Blog", "Projects/Website/Homepage"),
    );
    expect(entries).toEqual([
      { folderPath: "Projects/Website", depth: 0 },
      { folderPath: "Projects/Website/Blog", depth: 1 },
      { folderPath: "Projects/Website/Homepage", depth: 1 },
    ]);
  });

  it("skips plain folders (without recursing) and the Attachments folder", () => {
    const entries = tocEntries(
      "Projects",
      childrenMap({
        Projects: ["Projects/Attachments", "Projects/Old Stuff", "Projects/Website"],
        "Projects/Old Stuff": ["Projects/Old Stuff/Hidden"],
      }),
      betterNotes("Projects/Website", "Projects/Old Stuff/Hidden", "Projects/Attachments"),
    );
    expect(entries).toEqual([{ folderPath: "Projects/Website", depth: 0 }]);
  });

  it("returns empty for a betternote with no sub-betternotes", () => {
    expect(tocEntries("Projects", childrenMap({}), betterNotes())).toEqual([]);
  });
});

describe("renderTocBlock", () => {
  it("wraps an indented link list in the toc markers", () => {
    const block = renderTocBlock([
      { link: "[[Website]]", depth: 0 },
      { link: "[[Blog]]", depth: 1 },
      { link: "[[Marketing]]", depth: 0 },
    ]);
    expect(block).toBe(
      `${TOC_START}\n- [[Website]]\n    - [[Blog]]\n- [[Marketing]]\n${TOC_END}`,
    );
  });
});

describe("findTocBlock", () => {
  it("returns the offsets spanning both markers inclusive", () => {
    const content = `# Note\n\n${TOC_START}\n- [[Old]]\n${TOC_END}\n\ntail`;
    const span = findTocBlock(content);
    expect(span).not.toBeNull();
    expect(content.slice(span!.from, span!.to)).toBe(`${TOC_START}\n- [[Old]]\n${TOC_END}`);
    expect(content.slice(0, span!.from)).toBe("# Note\n\n");
  });

  it("returns null when markers are missing or unpaired", () => {
    expect(findTocBlock("# Note\nno markers here")).toBeNull();
    expect(findTocBlock(`${TOC_START}\n- [[Orphan]]`)).toBeNull();
    expect(findTocBlock(`${TOC_END}\nend before start\n${TOC_START}`)).toBeNull();
  });
});
