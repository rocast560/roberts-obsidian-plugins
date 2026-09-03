import { describe, expect, it } from "vitest";
import { buildCss, escapeAttr, folderSelector } from "../src/css";

const SEL = (p: string) =>
  `body .nav-files-container > div > .nav-folder:has(> .nav-folder-title[data-path="${p}"])`;

describe("escapeAttr", () => {
  it("escapes backslashes and double quotes", () => {
    expect(escapeAttr('a"b')).toBe('a\\"b');
    expect(escapeAttr("a\\b")).toBe("a\\\\b");
    expect(escapeAttr('x\\"y')).toBe('x\\\\\\"y');
  });
  it("leaves ordinary names alone", () => {
    expect(escapeAttr("Software Engineering")).toBe("Software Engineering");
  });
});

describe("folderSelector", () => {
  it("matches the bruh.css selector shape with a body prefix", () => {
    expect(folderSelector("Archive")).toBe(SEL("Archive"));
  });
  it("escapes the path inside the attribute", () => {
    expect(folderSelector('We "love" CSS')).toBe(SEL('We \\"love\\" CSS'));
  });
});

describe("buildCss", () => {
  it("emits variable, title and file rules for one folder", () => {
    const css = buildCss([{ path: "Archive", color: "#E5877E" }], { colorFiles: true });
    expect(css.split("\n")).toEqual([
      `${SEL("Archive")} { --folder-color: #E5877E; }`,
      `${SEL("Archive")} > .nav-folder-title { color: var(--folder-color); }`,
      `${SEL("Archive")} .nav-file-title { color: var(--folder-color); }`,
    ]);
  });
  it("omits the file rule when colorFiles is off", () => {
    const css = buildCss([{ path: "Archive", color: "#E5877E" }], { colorFiles: false });
    expect(css.split("\n")).toEqual([
      `${SEL("Archive")} { --folder-color: #E5877E; }`,
      `${SEL("Archive")} > .nav-folder-title { color: var(--folder-color); }`,
    ]);
  });
  it("keeps entry order and handles many folders", () => {
    const css = buildCss(
      [
        { path: "B", color: "#000000" },
        { path: "A", color: "#ffffff" },
      ],
      { colorFiles: false }
    );
    expect(css.indexOf('data-path="B"')).toBeLessThan(css.indexOf('data-path="A"'));
    expect(css.split("\n")).toHaveLength(4);
  });
  it("skips entries whose color is not #rrggbb", () => {
    const css = buildCss(
      [
        { path: "Bad", color: "red" },
        { path: "Short", color: "#fff" },
        { path: "Inject", color: "#000000; } body { display:none" },
        { path: "Good", color: "#123456" },
      ],
      { colorFiles: true }
    );
    expect(css).not.toContain("Bad");
    expect(css).not.toContain("Short");
    expect(css).not.toContain("display:none");
    expect(css).toContain('data-path="Good"');
  });
  it("returns an empty string for no entries", () => {
    expect(buildCss([], { colorFiles: true })).toBe("");
  });
});
