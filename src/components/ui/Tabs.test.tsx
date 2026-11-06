import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabPanel, Tabs } from "./Tabs";

afterEach(cleanup);

type Id = "a" | "b" | "c";
type TabDef = { id: Id; label: string; indicator?: "dot" | "pulse" | null };

const TABS: TabDef[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
];

function Harness({
  tabs = TABS,
  initial = "a",
  onChange,
  idPrefix,
}: {
  tabs?: TabDef[];
  initial?: Id;
  onChange?: (id: Id) => void;
  idPrefix?: string;
}) {
  const [value, setValue] = useState<Id>(initial);
  return (
    <>
      <Tabs
        tabs={tabs}
        value={value}
        onChange={(id) => {
          onChange?.(id);
          setValue(id);
        }}
        idPrefix={idPrefix}
        label="Sections"
      />
      {tabs.map((t) => (
        <TabPanel key={t.id} id={t.id} value={value} idPrefix={idPrefix}>
          <p>{t.label} content</p>
        </TabPanel>
      ))}
    </>
  );
}

describe("Tabs", () => {
  it("Tabs exposes tablist, tab and tabpanel roles with aria wiring", () => {
    render(<Harness idPrefix="demo" />);
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeTruthy();
    const tab = screen.getByRole("tab", { name: "Alpha" });
    expect(tab.id).toBe("demo-tab-a");
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(tab.getAttribute("aria-controls")).toBe("demo-panel-a");
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("aria-selected")).toBe("false");
    const panel = screen.getByRole("tabpanel");
    expect(panel.id).toBe("demo-panel-a");
    expect(panel.getAttribute("aria-labelledby")).toBe("demo-tab-a");
  });

  it("clicking a tab calls onChange", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Gamma" }));
    expect(onChange).toHaveBeenCalledWith("c");
    expect(screen.getByRole("tab", { name: "Gamma" }).getAttribute("aria-selected")).toBe("true");
  });

  it("arrow keys, Home and End move the selection and wrap", () => {
    render(<Harness />);
    const selected = () => screen.getByRole("tab", { selected: true });
    const press = (key: string) => fireEvent.keyDown(selected(), { key });

    press("ArrowRight");
    expect(selected().textContent).toBe("Beta");
    expect(document.activeElement).toBe(selected());
    press("ArrowRight");
    press("ArrowRight");
    expect(selected().textContent).toBe("Alpha");
    expect(document.activeElement).toBe(selected());
    press("ArrowLeft");
    expect(selected().textContent).toBe("Gamma");
    expect(document.activeElement).toBe(selected());
    press("Home");
    expect(selected().textContent).toBe("Alpha");
    expect(document.activeElement).toBe(selected());
    press("End");
    expect(selected().textContent).toBe("Gamma");
    expect(document.activeElement).toBe(selected());
  });

  it("only the selected tab is in the tab order", () => {
    render(<Harness initial="b" />);
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tab", { name: "Alpha" }).getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("tab", { name: "Gamma" }).getAttribute("tabindex")).toBe("-1");
  });

  it("TabPanel hides inactive panels but keeps them mounted", () => {
    render(<Harness />);
    expect(screen.getByText("Alpha content").parentElement?.hasAttribute("hidden")).toBe(false);
    const hidden = screen.getByText("Beta content");
    expect(hidden.parentElement?.hasAttribute("hidden")).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Beta" }));
    expect(screen.getByText("Beta content").parentElement?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByText("Alpha content").parentElement?.hasAttribute("hidden")).toBe(true);
  });

  it("an indicator is shown on the tab", () => {
    const tabs: TabDef[] = [
      { id: "a", label: "Alpha", indicator: "dot" },
      { id: "b", label: "Beta", indicator: "pulse" },
      { id: "c", label: "Gamma" },
    ];
    render(<Harness tabs={tabs} />);
    const alpha = screen.getByRole("tab", { name: /Alpha/ });
    const alphaDot = alpha.querySelector("[aria-hidden='true']");
    expect(alphaDot?.className).toContain("bg-amber-500");
    expect(alphaDot?.className).not.toContain("animate-pulse");
    expect(alpha.textContent).toContain("needs attention");
    expect(screen.getByRole("tab", { name: "Alpha needs attention" })).toBe(alpha);
    expect(screen.getByRole("tab", { name: "Beta active" })).toBeTruthy();

    const beta = screen.getByRole("tab", { name: /Beta/ });
    const betaDot = beta.querySelector("[aria-hidden='true']");
    expect(betaDot?.className).toContain("animate-pulse");
    expect(betaDot?.className).toContain("motion-reduce:animate-none");
    expect(beta.textContent).toContain("active");

    const gamma = screen.getByRole("tab", { name: "Gamma" });
    expect(gamma.querySelector("[aria-hidden='true']")).toBeNull();
  });
});
