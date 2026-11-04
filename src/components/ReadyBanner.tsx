import { Link } from "react-router-dom";
import type { ReadyItem } from "../lib/api";

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
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      {blocking && <p className="font-medium">Before you can run tasks:</p>}
      <ul className="space-y-0.5">
        {problems.map((item) => (
          <li key={item.id}>
            {item.message}{" "}
            {item.id in settingsHint ? (
              <>
                <Link to="/settings" className="underline">
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
    </div>
  );
}
