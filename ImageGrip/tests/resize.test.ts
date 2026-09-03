import { describe, expect, it } from "vitest";
import { computeDragWidth } from "../src/resize";

describe("computeDragWidth", () => {
  it("east corners grow with positive dx", () => {
    expect(computeDragWidth(200, 50, "se")).toBe(250);
    expect(computeDragWidth(200, 50, "ne")).toBe(250);
  });
  it("west corners grow with negative dx", () => {
    expect(computeDragWidth(200, -50, "sw")).toBe(250);
    expect(computeDragWidth(200, -50, "nw")).toBe(250);
  });
  it("shrinks in the opposite direction", () => {
    expect(computeDragWidth(200, -50, "se")).toBe(150);
  });
  it("clamps to the minimum width", () => {
    expect(computeDragWidth(200, -500, "se")).toBe(40);
  });
  it("rounds to whole pixels", () => {
    expect(computeDragWidth(200.4, 0, "se")).toBe(200);
  });
});
