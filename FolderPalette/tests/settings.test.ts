import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings";

describe("normalizeSettings", () => {
  it("returns defaults for null/undefined/garbage", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nope")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });
  it("never returns the shared default object", () => {
    const out = normalizeSettings(null);
    expect(out).not.toBe(DEFAULT_SETTINGS);
    expect(out.folderColors).not.toBe(DEFAULT_SETTINGS.folderColors);
  });
  it("keeps valid fields", () => {
    expect(
      normalizeSettings({
        paletteId: "nord",
        colorFiles: false,
        showCollapseArrows: false,
        treeLines: false,
        folderColors: { Archive: "#E5877E", "Cyber Security": "#eaa87b" },
      })
    ).toEqual({
      paletteId: "nord",
      colorFiles: false,
      showCollapseArrows: false,
      treeLines: false,
      folderColors: { Archive: "#E5877E", "Cyber Security": "#eaa87b" },
    });
  });
  it("defaults the explorer toggles on when missing (pre-0.2 data.json)", () => {
    const out = normalizeSettings({ paletteId: "nord", colorFiles: true, folderColors: {} });
    expect(out.showCollapseArrows).toBe(true);
    expect(out.treeLines).toBe(true);
  });
  it("ignores non-boolean explorer toggles", () => {
    const out = normalizeSettings({ showCollapseArrows: "no", treeLines: 0 });
    expect(out.showCollapseArrows).toBe(true);
    expect(out.treeLines).toBe(true);
  });
  it("drops folder entries that are not #rrggbb", () => {
    expect(
      normalizeSettings({
        folderColors: { Good: "#123456", Named: "red", Short: "#fff", Num: 7, "": "#123456" },
      }).folderColors
    ).toEqual({ Good: "#123456" });
  });
  it("falls back per field when a field has the wrong type", () => {
    expect(normalizeSettings({ paletteId: 3, colorFiles: "yes", folderColors: [] })).toEqual(
      DEFAULT_SETTINGS
    );
    expect(normalizeSettings({ paletteId: "" }).paletteId).toBe("muted-rainbow");
  });
  it("ignores unknown fields", () => {
    const out = normalizeSettings({ paletteId: "nord", extra: true }) as unknown as Record<string, unknown>;
    expect(out.extra).toBeUndefined();
  });
});
