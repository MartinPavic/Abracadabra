import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { controlClasses, Field, Input, Select, Textarea } from "./Form";

afterEach(cleanup);

describe("Form", () => {
  it("Field links its label, hint and error", () => {
    render(
      <Field label="Name" htmlFor="name" hint="Shown in lists" error="Required">
        <Input id="name" aria-describedby="name-hint name-error" />
      </Field>,
    );
    const input = screen.getByLabelText("Name");
    expect(input.id).toBe("name");
    const hint = screen.getByText("Shown in lists");
    expect(hint.id).toBe("name-hint");
    const error = screen.getByRole("alert");
    expect(error.id).toBe("name-error");
    expect(error.textContent).toBe("Required");
    expect(error.className).toContain("text-red-");
    expect(input.getAttribute("aria-describedby")).toBe("name-hint name-error");
  });

  it("Field omits hint and error when not given", () => {
    render(
      <Field label="Name" htmlFor="name">
        <Input id="name" />
      </Field>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.getElementById("name-hint")).toBeNull();
  });

  it("Input mono uses the mono font class", () => {
    render(
      <>
        <Input aria-label="plain" />
        <Input aria-label="code" mono />
        <Textarea aria-label="area" mono />
      </>,
    );
    expect(screen.getByLabelText("plain").className).not.toContain("font-mono");
    expect(screen.getByLabelText("code").className).toContain("font-mono");
    expect(screen.getByLabelText("area").className).toContain("font-mono");
  });

  it("controls have dark variants and a focus ring", () => {
    expect(controlClasses).toContain("dark:");
    expect(controlClasses).toContain("focus-visible:ring-2");
    expect(controlClasses).toContain("focus-visible:ring-accent-500");
    expect(controlClasses).toContain("focus-visible:border-accent-500");
    expect(controlClasses).toContain("disabled:opacity-50");
    render(
      <>
        <Input aria-label="i" />
        <Textarea aria-label="t" />
        <Select aria-label="s">
          <option>one</option>
        </Select>
      </>,
    );
    for (const name of ["i", "t", "s"]) {
      const el = screen.getByLabelText(name);
      expect(el.className).toContain("dark:bg-zinc-900");
      expect(el.className).toContain("focus-visible:ring-2");
    }
    expect(screen.getByLabelText("i").className).toContain("h-9");
    expect(screen.getByLabelText("t").className).toContain("min-h-20");
    expect(screen.getByLabelText("t").className).not.toContain("h-9");
  });
});
