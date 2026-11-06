import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunStatus } from "../../lib/api";
import { Badge, StatusBadge, type Tone } from "./Badge";

afterEach(cleanup);

const TONES: Tone[] = ["neutral", "info", "success", "warning", "danger", "accent", "violet"];

const STATUSES: RunStatus[] = [
  "queued",
  "cloning",
  "working",
  "reviewing",
  "committing",
  "awaiting_approval",
  "approved",
  "discarded",
  "handed_off",
  "planned",
  "failed",
  "cancelled",
];

describe("Badge", () => {
  it("Badge tones all carry dark variants", () => {
    const classes = TONES.map((tone) => {
      const { unmount } = render(<Badge tone={tone}>{tone}</Badge>);
      const cls = screen.getByText(tone).className;
      unmount();
      return cls;
    });
    for (const cls of classes) {
      expect(cls).toContain("dark:");
      expect(cls).toContain("rounded-full");
    }
    expect(new Set(classes).size).toBe(TONES.length);
    expect(classes[TONES.indexOf("accent")]).toContain("accent-");
    expect(classes[TONES.indexOf("violet")]).toContain("violet-");
  });

  it("StatusBadge shows the status as text for every RunStatus", () => {
    for (const status of STATUSES) {
      const { unmount } = render(<StatusBadge status={status} />);
      expect(screen.getByText(status.replace(/_/g, " "))).not.toBeNull();
      unmount();
    }
  });

  it("active statuses show a pulsing dot", () => {
    const pulsing = (status: RunStatus) => {
      const { container, unmount } = render(<StatusBadge status={status} />);
      const dot = container.querySelector("[aria-hidden='true']");
      const result = { hasDot: dot !== null, pulse: dot?.className.includes("animate-pulse") ?? false };
      if (result.pulse) expect(dot?.className).toContain("motion-reduce:animate-none");
      unmount();
      return result;
    };
    for (const status of ["cloning", "working", "reviewing", "committing"] as const) {
      expect(pulsing(status)).toEqual({ hasDot: true, pulse: true });
    }
    expect(pulsing("approved")).toEqual({ hasDot: true, pulse: false });
    expect(pulsing("failed")).toEqual({ hasDot: true, pulse: false });
  });
});
