import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

afterEach(cleanup);

describe("EmptyState", () => {
  it("EmptyState renders title, description and action", () => {
    render(
      <EmptyState
        icon="tasks"
        title="No tasks yet"
        description="Add one to get started"
        action={<button type="button">Add task</button>}
      />,
    );
    expect(screen.getByText("No tasks yet")).not.toBeNull();
    expect(screen.getByText("Add one to get started")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add task" })).not.toBeNull();
  });
});
