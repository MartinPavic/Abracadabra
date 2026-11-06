import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunStatusPill } from "./RunStatus";

afterEach(cleanup);

describe("RunStatusPill", () => {
  it("RunStatusPill still renders the status text", () => {
    render(<RunStatusPill status="awaiting_approval" />);
    expect(screen.getByText("awaiting approval")).not.toBeNull();
  });
});
