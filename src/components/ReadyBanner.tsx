import { Link } from "react-router-dom";
import type { ReadyItem } from "../lib/api";
import { Notice } from "./ui";

const PLAN_NOTE = "Plan runs need a plan command; set it under Advanced in Settings.";

const settingsHint: Record<string, string> = {
  token: "Connections",
  worker: "Agent",
  agent_cli: "Agent",
};

export function ReadyBanner({ problems }: { problems: ReadyItem[] }) {
  if (problems.length === 0) return null;
  const blocking = problems.some((item) => item.blocks === "run");

  return (
    <Notice
      tone="warning"
      role="status"
      title={blocking ? "Before you can run tasks:" : undefined}
    >
      <ul className="space-y-0.5">
        {problems.map((item) => (
          <li key={item.id}>
            {item.message}{" "}
            {item.id in settingsHint ? (
              <>
                <Link
                  to="/settings"
                  className="rounded font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  Open Settings
                </Link>{" "}
                <span className="text-xs opacity-75">({settingsHint[item.id]})</span>
              </>
            ) : (
              item.id === "plan" && <span className="text-xs opacity-75">{PLAN_NOTE}</span>
            )}
          </li>
        ))}
      </ul>
    </Notice>
  );
}
