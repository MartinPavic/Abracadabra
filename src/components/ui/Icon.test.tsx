import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Icon, type IconName } from "./Icon";

afterEach(cleanup);

const ALL_NAMES: IconName[] = [
  "tasks", "history", "settings", "sun", "moon", "check", "x", "alert", "info",
  "play", "list", "refresh", "external", "copy", "chevron-right", "chevron-down",
  "branch", "folder", "merge", "search", "sparkles", "trash", "stop", "edit", "file",
];

describe("Icon", () => {
  it("Icon is hidden from assistive tech unless it has a title", () => {
    const { container, unmount } = render(<Icon name="check" />);
    const hidden = container.querySelector("svg")!;
    expect(hidden.getAttribute("aria-hidden")).toBe("true");
    expect(hidden.getAttribute("role")).toBeNull();
    unmount();

    render(<Icon name="check" title="Done" />);
    const labelled = screen.getByRole("img", { name: "Done" });
    expect(labelled.getAttribute("aria-hidden")).toBeNull();
    expect(labelled.querySelector("title")?.textContent).toBe("Done");
  });

  it("Icon renders every IconName", () => {
    expect(ALL_NAMES).toHaveLength(25);
    for (const name of ALL_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg!.querySelector("path"), name).not.toBeNull();
      unmount();
    }
  });
});
