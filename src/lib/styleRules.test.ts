import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("/src/**/*.{ts,tsx,css}", {
  query: "?raw",
  import: "default",
  eager: true,
});

// Tests assert on class names, so only production sources are held to the rules.
const files = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));

const isPrimitive = (path: string) => path.startsWith("/src/components/ui/");

function offenders(
  pattern: RegExp,
  include: (path: string) => boolean = () => true,
  allowLine: (line: string) => boolean = () => false,
): string[] {
  const found: string[] = [];
  for (const [path, text] of files) {
    if (!include(path)) continue;
    text.split("\n").forEach((line, i) => {
      if (pattern.test(line) && !allowLine(line)) found.push(`${path}:${i + 1}  ${line.trim()}`);
    });
  }
  return found;
}

describe("ui style rules", () => {
  it("finds the sources to scan", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some(([path]) => path === "/src/components/ui/Button.tsx")).toBe(true);
  });

  it("uses the accent scale instead of indigo outside App.css", () => {
    expect(offenders(/\bindigo-/, (path) => path !== "/src/App.css")).toEqual([]);
  });

  it("declares none of the removed ad-hoc class constants", () => {
    const removed =
      /\b(?:const|let|var|function)\s+(?:inputClass|labelClass|buttonClass|neutralButton|panelClass|panelTitleClass|smallButton|cardClass)\b/;
    expect(offenders(removed, (path) => /\.tsx?$/.test(path))).toEqual([]);
  });

  it("leaves no rounded-md controls in screens", () => {
    expect(offenders(/\brounded-md\b/, (path) => !isPrimitive(path))).toEqual([]);
  });

  it("pairs every animate-pulse and animate-spin with motion-reduce", () => {
    expect(
      offenders(/\banimate-(?:pulse|spin)\b/, undefined, (line) => line.includes("motion-reduce:")),
    ).toEqual([]);
  });
});
