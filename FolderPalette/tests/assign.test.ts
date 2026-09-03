import { describe, expect, it } from "vitest";
import { assignPalette, dropKey, renameKey, sortFolderNames } from "../src/assign";
import type { Palette } from "../src/palettes";

const palette: Palette = {
  id: "t",
  name: "Test",
  source: "test",
  colors: [
    { name: "a", hex: "#aaaaaa" },
    { name: "b", hex: "#bbbbbb" },
    { name: "c", hex: "#cccccc" },
  ],
};

describe("sortFolderNames", () => {
  it("sorts case-insensitively like the file explorer", () => {
    expect(sortFolderNames(["beta", "Alpha", "gamma"])).toEqual(["Alpha", "beta", "gamma"]);
  });
  it("sorts numbers naturally", () => {
    expect(sortFolderNames(["Week 10", "Week 2", "Week 1"])).toEqual(["Week 1", "Week 2", "Week 10"]);
  });
  it("does not mutate its input", () => {
    const input = ["b", "a"];
    sortFolderNames(input);
    expect(input).toEqual(["b", "a"]);
  });
});

describe("assignPalette", () => {
  it("assigns colors in order", () => {
    expect(assignPalette(["A", "B"], palette)).toEqual({ A: "#aaaaaa", B: "#bbbbbb" });
  });
  it("wraps around when there are more folders than colors", () => {
    expect(assignPalette(["A", "B", "C", "D"], palette)).toEqual({
      A: "#aaaaaa",
      B: "#bbbbbb",
      C: "#cccccc",
      D: "#aaaaaa",
    });
  });
  it("returns an empty map for no folders", () => {
    expect(assignPalette([], palette)).toEqual({});
  });
  it("returns an empty map for a palette with no colors", () => {
    expect(assignPalette(["A"], { ...palette, colors: [] })).toEqual({});
  });
});

describe("renameKey", () => {
  it("moves the color to the new key", () => {
    expect(renameKey({ Old: "#111111", Other: "#222222" }, "Old", "New")).toEqual({
      Other: "#222222",
      New: "#111111",
    });
  });
  it("is a no-op copy when the old key is missing", () => {
    const map = { A: "#111111" };
    const out = renameKey(map, "Missing", "New");
    expect(out).toEqual({ A: "#111111" });
    expect(out).not.toBe(map);
  });
  it("overwrites an existing entry at the new key", () => {
    expect(renameKey({ A: "#111111", B: "#222222" }, "A", "B")).toEqual({ B: "#111111" });
  });
  it("does not mutate its input", () => {
    const map = { A: "#111111" };
    renameKey(map, "A", "B");
    expect(map).toEqual({ A: "#111111" });
  });
});

describe("dropKey", () => {
  it("removes the key and returns a new object", () => {
    const map = { A: "#111111", B: "#222222" };
    const out = dropKey(map, "A");
    expect(out).toEqual({ B: "#222222" });
    expect(map).toEqual({ A: "#111111", B: "#222222" });
  });
  it("copies unchanged when the key is missing", () => {
    expect(dropKey({ A: "#111111" }, "Z")).toEqual({ A: "#111111" });
  });
});
