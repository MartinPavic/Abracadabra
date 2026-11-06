import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "./AppShell";

function renderShell(route: string, children: ReactNode = <p>page body</p>) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AppShell>{children}</AppShell>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("AppShell", () => {
  it("the sidebar links to tasks and settings and marks the active one", () => {
    renderShell("/settings");

    const tasks = screen.getByRole("link", { name: "Tasks" });
    const settings = screen.getByRole("link", { name: "Settings" });
    expect(tasks.getAttribute("href")).toBe("/tasks");
    expect(settings.getAttribute("href")).toBe("/settings");
    expect(settings.getAttribute("aria-current")).toBe("page");
    expect(tasks.getAttribute("aria-current")).toBeNull();
    expect(screen.getByText("Abracadabra")).toBeTruthy();
  });

  it("the tasks item stays active on a run page", () => {
    renderShell("/tasks/abc-123");

    expect(screen.getByRole("link", { name: "Tasks" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBeNull();
  });

  it("the theme toggle switches mode and has an accessible name", () => {
    renderShell("/tasks");

    fireEvent.click(screen.getByRole("button", { name: "Switch to dark mode" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeTruthy();
  });

  it("the content area renders its children", () => {
    renderShell("/tasks", <p>page body</p>);

    expect(screen.getByRole("main").textContent).toContain("page body");
    expect(screen.queryByRole("banner")).toBeNull();
  });
});
