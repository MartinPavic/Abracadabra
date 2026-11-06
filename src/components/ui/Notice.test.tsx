import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Notice } from "./Notice";

afterEach(cleanup);

describe("Notice", () => {
  it("Notice uses role alert for danger and warning", () => {
    const { rerender } = render(<Notice tone="danger">boom</Notice>);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    rerender(<Notice tone="warning">careful</Notice>);
    expect(screen.getByRole("alert").textContent).toContain("careful");
    rerender(<Notice tone="info">fyi</Notice>);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("fyi");
    rerender(<Notice tone="success">done</Notice>);
    expect(screen.getByRole("status").textContent).toContain("done");
  });

  it("a role override replaces the tone default", () => {
    const { rerender } = render(
      <Notice tone="warning" role="status">
        heads up
      </Notice>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("heads up");
    rerender(
      <Notice tone="info" role="alert">
        urgent
      </Notice>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("urgent");
  });

  it("Notice shows its title and actions", () => {
    render(
      <Notice title="Heads up" actions={<button type="button">Fix</button>}>
        details
      </Notice>,
    );
    expect(screen.getByText("Heads up")).not.toBeNull();
    expect(screen.getByText("details")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Fix" })).not.toBeNull();
  });

  it("Notice tones carry dark variants", () => {
    for (const tone of ["info", "success", "warning", "danger"] as const) {
      const { unmount } = render(<Notice tone={tone}>{tone}</Notice>);
      const cls = screen.getByText(tone).closest("[role]")?.className ?? "";
      expect(cls).toContain("dark:");
      expect(cls).toContain("rounded-lg");
      expect(screen.getByText(tone).className).toContain("break-words");
      unmount();
    }
  });
});
