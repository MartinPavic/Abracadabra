import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "../lib/api";
import { Markdown } from "./Markdown";

vi.mock("../lib/api", () => ({ openUrl: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Markdown", () => {
  it("renders raw HTML as text instead of elements", () => {
    const { container } = render(<Markdown>{"<script>alert(1)</script> <b>hi</b>"}</Markdown>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<script>");
  });

  it("does not create an img element with an event handler", () => {
    const { container } = render(<Markdown>{'<img src=x onerror="alert(1)">'}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("onerror");
  });

  it("renders headings, lists and code", () => {
    const { container } = render(
      <Markdown>{"# Title\n\n- one\n- two\n\n```\nlet x = 1;\n```\n\nuse `code` here"}</Markdown>,
    );
    expect(container.querySelector("h3")?.textContent).toBe("Title");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre")?.textContent).toContain("let x = 1;");
    expect(container.querySelector("p code")?.textContent).toBe("code");
  });

  it("renders GitHub-flavoured tables", () => {
    render(<Markdown>{"| a | b |\n|---|---|\n| 1 | 2 |"}</Markdown>);
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("opens links through openUrl, not in the app window", () => {
    render(<Markdown>{"[docs](https://example.com/docs)"}</Markdown>);
    const notPrevented = fireEvent.click(screen.getByText("docs"));
    expect(notPrevented).toBe(false);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  });
});
