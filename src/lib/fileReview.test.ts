import { describe, expect, it } from "vitest";
import type { FileMark } from "./api";
import { groupMarks, nextUndecided } from "./fileReview";

const mark = (decision: FileMark["decision"]): FileMark => ({ decision, note: null });

describe("nextUndecided", () => {
  const paths = ["a", "b", "c", "d"];

  it("skips decided files and wraps around", () => {
    const marks = { a: mark(null), b: mark("keep"), c: mark("redo"), d: mark("remove") };
    expect(nextUndecided(paths, marks, 0)).toBe(0);
    expect(nextUndecided(paths, { ...marks, a: mark("keep"), d: mark(null) }, 1)).toBe(3);
    expect(nextUndecided(paths, { ...marks, a: mark(null), d: mark("keep") }, 2)).toBe(0);
    expect(nextUndecided(paths, { ...marks, a: mark("keep") }, -1)).toBeNull();
    expect(nextUndecided(paths, {}, -1)).toBe(0);
  });

  it("returns null when everything is decided", () => {
    const marks = { a: mark("keep"), b: mark("keep"), c: mark("remove"), d: mark("redo") };
    expect(nextUndecided(paths, marks, 1)).toBeNull();
    expect(nextUndecided([], {}, -1)).toBeNull();
  });
});

describe("groupMarks", () => {
  it("puts files without a decision in undecided", () => {
    const marks = { a: mark("keep"), b: mark(null), c: mark("redo"), e: mark("remove") };
    expect(groupMarks(["a", "b", "c", "d", "e"], marks)).toEqual({
      keep: ["a"],
      remove: ["e"],
      redo: ["c"],
      undecided: ["b", "d"],
    });
  });
});
