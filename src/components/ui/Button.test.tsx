import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, buttonClasses } from "./Button";

afterEach(cleanup);

describe("Button", () => {
  it("Button defaults to type button and secondary", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toContain("border-zinc-300");
    expect(button.className).toContain("h-9");
  });

  it("Button variants carry distinct classes and a dark variant", () => {
    const variants = ["primary", "secondary", "ghost", "danger"] as const;
    const classes = variants.map((v) => buttonClasses(v, "md"));
    expect(new Set(classes).size).toBe(4);
    for (const c of classes) {
      expect(c).toContain("dark:");
      expect(c).toContain("focus-visible:ring-2");
      expect(c).toContain("disabled:opacity-50");
    }
    expect(buttonClasses("primary")).toContain("bg-accent-600");
    expect(buttonClasses("primary")).toContain("dark:bg-accent-400");
    expect(buttonClasses("danger")).toContain("bg-red-600");
    expect(buttonClasses("secondary", "sm")).toContain("h-8");
  });

  it("a loading Button is disabled and shows the spinner but keeps its label", () => {
    render(<Button loading>Running</Button>);
    const button = screen.getByRole("button", { name: "Running" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toContain("Running");
    expect(button.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("Button forwards onClick and respects disabled", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} disabled>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("buttonClasses can style a link", () => {
    render(
      <a href="#x" className={buttonClasses("primary", "sm")}>
        Open
      </a>,
    );
    const link = screen.getByRole("link", { name: "Open" });
    expect(link.className).toContain("bg-accent-600");
    expect(link.className).toContain("h-8");
  });
});
