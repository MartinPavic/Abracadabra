import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Spinner } from "./Spinner";

afterEach(cleanup);

describe("Spinner", () => {
  it("Spinner has a status role", () => {
    render(<Spinner />);
    const spinner = screen.getByRole("status", { name: "Loading" });
    expect(spinner.getAttribute("class")).toContain("animate-spin");
    expect(spinner.getAttribute("class")).toContain("motion-reduce:animate-none");
  });

  it("a decorative Spinner is hidden from assistive tech", () => {
    const { container } = render(<Spinner decorative />);
    expect(screen.queryByRole("status")).toBeNull();
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.hasAttribute("role")).toBe(false);
    expect(svg?.hasAttribute("aria-label")).toBe(false);
  });
});
