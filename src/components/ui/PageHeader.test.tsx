import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { PageHeader } from "./PageHeader";

afterEach(cleanup);

describe("PageHeader", () => {
  it("PageHeader renders a back link", () => {
    render(
      <MemoryRouter>
        <PageHeader
          title="Fix the bug"
          description="in repo"
          actions={<button type="button">Cancel run</button>}
          back={{ to: "/", label: "Tasks" }}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Tasks" });
    expect(link.getAttribute("href")).toBe("/");
    expect(screen.getByRole("heading", { level: 1, name: "Fix the bug" }).className).toContain("text-xl");
    expect(screen.getByText("in repo")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Cancel run" })).not.toBeNull();
  });

  it("PageHeader without back has no link", () => {
    render(
      <MemoryRouter>
        <PageHeader title="Settings" />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});
