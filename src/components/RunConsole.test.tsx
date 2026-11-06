import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RunConsole } from "./RunConsole";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/api", () => ({
  getRunOutput: vi.fn().mockResolvedValue([
    { role: "worker", stream: "stdout", line: "editing src/a.ts" },
    { role: "tests", stream: "stderr", line: "1 failed" },
  ]),
}));

beforeAll(() => {
  // jsdom has no layout, so no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

describe("RunConsole", () => {
  it("the console renders its lines in a scrollable monospace area", async () => {
    render(<RunConsole runId="r1" />);
    const output = await screen.findByRole("region", { name: "Run console output" });
    within(output).getByText("[worker] editing src/a.ts");
    within(output).getByText("[tests] 1 failed");
    expect(output.className).toMatch(/\boverflow-auto\b/);
    expect(output.className).toMatch(/\bmax-h-\S+/);
    expect(output.className).toMatch(/\bfont-mono\b/);
    expect(output.tabIndex).toBe(0);
  });
});
