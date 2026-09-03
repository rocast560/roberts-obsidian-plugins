import { describe, expect, it } from "vitest";
import { HEX_RE, isHex } from "../src/hex";
import { PALETTES, getPalette } from "../src/palettes";

const SNIPPET_RAINBOW = [
  "#E5877E", "#EAA87B", "#E1CF80", "#B1E291", "#90C3E2",
  "#B2A7E2", "#D8B2E2", "#E2B2D1", "#90DDCB",
];

describe("isHex", () => {
  it("accepts #rrggbb in either case", () => {
    expect(isHex("#E5877E")).toBe(true);
    expect(isHex("#e5877e")).toBe(true);
  });
  it("rejects short, named, alpha and non-string values", () => {
    expect(isHex("#fff")).toBe(false);
    expect(isHex("red")).toBe(false);
    expect(isHex("#E5877E80")).toBe(false);
    expect(isHex("#12345g")).toBe(false);
    expect(isHex(42)).toBe(false);
    expect(isHex(null)).toBe(false);
  });
});

describe("PALETTES", () => {
  it("has unique ids", () => {
    const ids = PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("every palette has at least 10 colors", () => {
    for (const p of PALETTES) expect(p.colors.length, p.id).toBeGreaterThanOrEqual(10);
  });
  it("every color is a valid #rrggbb with a name", () => {
    for (const p of PALETTES) {
      for (const c of p.colors) {
        expect(c.hex, `${p.id}/${c.name}`).toMatch(HEX_RE);
        expect(c.name.length, `${p.id}/${c.hex}`).toBeGreaterThan(0);
      }
    }
  });
  it("has no duplicate colors inside a palette", () => {
    for (const p of PALETTES) {
      const hexes = p.colors.map((c) => c.hex.toLowerCase());
      expect(new Set(hexes).size, p.id).toBe(hexes.length);
    }
  });
  it("every palette has a name and a source", () => {
    for (const p of PALETTES) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.source.length).toBeGreaterThan(0);
    }
  });
  it("starts with Muted Rainbow whose first 9 colors match bruh.css in order", () => {
    expect(PALETTES[0].id).toBe("muted-rainbow");
    expect(PALETTES[0].colors.slice(0, 9).map((c) => c.hex)).toEqual(SNIPPET_RAINBOW);
  });
});

describe("getPalette", () => {
  it("returns the palette by id", () => {
    expect(getPalette("nord").id).toBe("nord");
  });
  it("falls back to the first palette for unknown ids", () => {
    expect(getPalette("nope")).toBe(PALETTES[0]);
    expect(getPalette("")).toBe(PALETTES[0]);
  });
});
