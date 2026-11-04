import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadyItem } from "../lib/api";
import { ReadyBanner } from "./ReadyBanner";

afterEach(cleanup);

const renderBanner = (problems: ReadyItem[]) =>
  render(
    <MemoryRouter>
      <ReadyBanner problems={problems} />
    </MemoryRouter>,
  );

describe("ReadyBanner", () => {
  it("nothing is shown when every item is ok", () => {
    const { container } = renderBanner([]);
    expect(container.textContent).toBe("");
  });

  it("a failing item is listed with a link to settings", () => {
    renderBanner([{ id: "token", ok: false, message: "No access token for GitLab", blocks: "run" }]);
    expect(screen.getByText("Before you can run tasks:")).toBeTruthy();
    expect(screen.getByText("No access token for GitLab")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Settings" }).getAttribute("href")).toBe("/settings");
  });

  it("a failing plan item is shown as a note without blocking text", () => {
    renderBanner([{ id: "plan", ok: false, message: "No plan command configured", blocks: "plan" }]);
    expect(screen.getByText("No plan command configured")).toBeTruthy();
    expect(screen.getByText("Plan runs need a plan command; set it under Advanced in Settings.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("Before you can run tasks:")).toBeNull();
  });
});
