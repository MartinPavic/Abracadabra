import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { minimalGraph } from "@coldtea/pr-lens-schema/examples";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError, generateRunDiagram, type RunRecord } from "../lib/api";
import { PrLensDiagram } from "./PrLensDiagram";

vi.mock("../lib/api", () => ({
  describeError: vi.fn((error: unknown) => String(error)),
  generateRunDiagram: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const run = {
  id: "run-1",
  project: "group/sub/app",
  baseCommit: "a".repeat(40),
  commitSha: "b".repeat(40),
} as RunRecord;

describe("PrLensDiagram", () => {
  it("fills in provenance when the agent omits it", async () => {
    const { provenance: _omitted, ...withoutProvenance } = minimalGraph;
    vi.mocked(generateRunDiagram).mockResolvedValue(JSON.stringify(withoutProvenance));
    render(<PrLensDiagram run={run} baseUrl="https://gitlab.example.com" />);

    fireEvent.click(screen.getByRole("button", { name: "Generate diagram" }));

    expect(await screen.findByRole("img", { name: "PR Lens architecture diagram" })).toBeTruthy();
  });

  it("validates and renders a PR Lens graph document", async () => {
    vi.mocked(generateRunDiagram).mockResolvedValue(JSON.stringify(minimalGraph));
    render(<PrLensDiagram run={run} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate diagram" }));

    const image = await screen.findByRole("img", { name: "PR Lens architecture diagram" });
    const svg = decodeURIComponent(image.getAttribute("src")?.split(",")[1] ?? "");
    expect(svg).toContain("<svg");
    expect(svg).toContain("GET /health");
  });

  it("shows an error when the agent output is not valid JSON", async () => {
    vi.mocked(generateRunDiagram).mockResolvedValue("not a graph");
    render(<PrLensDiagram run={run} />);

    fireEvent.click(screen.getByRole("button", { name: "Generate diagram" }));

    expect(await screen.findByText(/SyntaxError/)).toBeTruthy();
    expect(describeError).toHaveBeenCalled();
  });
});