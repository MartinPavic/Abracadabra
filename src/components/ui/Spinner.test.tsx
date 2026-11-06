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
});
