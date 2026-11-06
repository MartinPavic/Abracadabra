import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card } from "./Card";

afterEach(cleanup);

describe("Card", () => {
  it("Card shows its title as a heading and its actions", () => {
    render(
      <Card title="Agent" description="Which CLI to run" actions={<button type="button">Edit</button>}>
        body
      </Card>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Agent" })).not.toBeNull();
    expect(screen.getByText("Which CLI to run")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).not.toBeNull();
    expect(screen.getByText("body")).not.toBeNull();
  });

  it("Card without a title has no header", () => {
    render(<Card>just body</Card>);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("just body")).not.toBeNull();
  });

  it("Card pads its body unless padded is false", () => {
    const { rerender } = render(<Card>content</Card>);
    expect(screen.getByText("content").className).toContain("p-4");
    rerender(<Card padded={false}>content</Card>);
    expect(screen.getByText("content").className).not.toContain("p-4");
  });
});
