import { describe, expect, it } from "vitest";
import {
  basename, dirname, join, noteNameForFolder, folderForInnerNote,
  collisionFree, collisionFreeFile, folderRenameSync, noteRenameSync,
  convertPlan, flattenPlan, newBetterNotePlan, attachmentsFolderFor,
} from "../src/core/pairing";

const none = (_p: string) => false;
const only = (...paths: string[]) => (p: string) => paths.includes(p);

describe("path helpers", () => {
  it("basename/dirname/join", () => {
    expect(basename("A/B/C.md")).toBe("C.md");
    expect(basename("C.md")).toBe("C.md");
    expect(dirname("A/B/C.md")).toBe("A/B");
    expect(dirname("C.md")).toBe("");
    expect(join("", "X")).toBe("X");
    expect(join("A/B", "X")).toBe("A/B/X");
  });
});

describe("betternote identity", () => {
  it("noteNameForFolder", () => {
    expect(noteNameForFolder("Projects")).toBe("Projects/Projects.md");
    expect(noteNameForFolder("A/B")).toBe("A/B/B.md");
  });
  it("folderForInnerNote matches only same-named inner md", () => {
    expect(folderForInnerNote("A/B/B.md")).toBe("A/B");
    expect(folderForInnerNote("B/B.md")).toBe("B");
    expect(folderForInnerNote("A/B/C.md")).toBeNull();
    expect(folderForInnerNote("B.md")).toBeNull();
    expect(folderForInnerNote("A/B/B.png")).toBeNull();
  });
});

describe("collision suffixing", () => {
  it("folders", () => {
    expect(collisionFree("A/Untitled", none)).toBe("A/Untitled");
    expect(collisionFree("A/Untitled", only("A/Untitled"))).toBe("A/Untitled 1");
    expect(collisionFree("A/Untitled", only("A/Untitled", "A/Untitled 1"))).toBe("A/Untitled 2");
  });
  it("files keep extension", () => {
    expect(collisionFreeFile("A/img.png", none)).toBe("A/img.png");
    expect(collisionFreeFile("A/img.png", only("A/img.png"))).toBe("A/img 1.png");
  });
});

describe("folderRenameSync", () => {
  it("renames carried note when folder renamed", () => {
    expect(folderRenameSync("A/B", "A/C", only("A/C/B.md")))
      .toEqual({ from: "A/C/B.md", to: "A/C/C.md" });
  });
  it("null on pure move (same basename)", () => {
    expect(folderRenameSync("A/B", "X/B", only("X/B/B.md"))).toBeNull();
  });
  it("null when not a betternote", () => {
    expect(folderRenameSync("A/B", "A/C", none)).toBeNull();
  });
  it("null when target name already taken", () => {
    expect(folderRenameSync("A/B", "A/C", only("A/C/B.md", "A/C/C.md"))).toBeNull();
  });
});

describe("noteRenameSync", () => {
  it("renames folder when inner note renamed in place", () => {
    expect(noteRenameSync("A/B/B.md", "A/B/C.md", none))
      .toEqual({ from: "A/B", to: "A/C" });
  });
  it("root-level betternote", () => {
    expect(noteRenameSync("B/B.md", "B/C.md", none)).toEqual({ from: "B", to: "C" });
  });
  it("null when note moved out of its folder", () => {
    expect(noteRenameSync("A/B/B.md", "A/B.md", none)).toBeNull();
  });
  it("null when source was not inner note", () => {
    expect(noteRenameSync("A/B/C.md", "A/B/D.md", none)).toBeNull();
  });
  it("null when target folder name taken", () => {
    expect(noteRenameSync("A/B/B.md", "A/B/C.md", only("A/C"))).toBeNull();
  });
});

describe("convertPlan", () => {
  it("creates folder and moves note in", () => {
    expect(convertPlan("A/B.md", none))
      .toEqual({ folder: "A/B", createFolder: true, noteTo: "A/B/B.md" });
  });
  it("merges into existing folder without inner note", () => {
    expect(convertPlan("A/B.md", only("A/B")))
      .toEqual({ folder: "A/B", createFolder: false, noteTo: "A/B/B.md" });
  });
  it("suffixes when folder exists WITH inner note", () => {
    expect(convertPlan("A/B.md", only("A/B", "A/B/B.md")))
      .toEqual({ folder: "A/B 1", createFolder: true, noteTo: "A/B 1/B 1.md" });
  });
  it("null for an already-inner note", () => {
    expect(convertPlan("A/B/B.md", none)).toBeNull();
  });
});

describe("flattenPlan", () => {
  it("moves note out and deletes empty folder", () => {
    expect(flattenPlan("A/B", ["A/B/B.md"], none))
      .toEqual({ noteTo: "A/B.md", deleteFolder: true });
  });
  it("keeps folder when it has other children", () => {
    expect(flattenPlan("A/B", ["A/B/B.md", "A/B/img.png"], none))
      .toEqual({ noteTo: "A/B.md", deleteFolder: false });
  });
  it("suffixes when sibling file exists", () => {
    expect(flattenPlan("A/B", ["A/B/B.md"], only("A/B.md")))
      .toEqual({ noteTo: "A/B 1.md", deleteFolder: true });
  });
  it("null when folder is not a betternote", () => {
    expect(flattenPlan("A/B", ["A/B/x.md"], none)).toBeNull();
  });
});

describe("attachmentsFolderFor", () => {
  it("Attachments subfolder inside the betternote", () => {
    expect(attachmentsFolderFor("A/B")).toBe("A/B/Attachments");
    expect(attachmentsFolderFor("Projects")).toBe("Projects/Attachments");
  });
});

describe("newBetterNotePlan", () => {
  it("Untitled in parent", () => {
    expect(newBetterNotePlan("A", none))
      .toEqual({ folder: "A/Untitled", note: "A/Untitled/Untitled.md" });
  });
  it("root + collision", () => {
    expect(newBetterNotePlan("", only("Untitled")))
      .toEqual({ folder: "Untitled 1", note: "Untitled 1/Untitled 1.md" });
  });
});
