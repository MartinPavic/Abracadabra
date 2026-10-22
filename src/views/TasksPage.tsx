import { useSearchParams } from "react-router-dom";
import { OrphanedStashes } from "../components/OrphanedStashes";
import { RunHistory } from "../components/RunHistory";
import { TaskList } from "./TaskList";

type Tab = "tasks" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "history", label: "History" },
];

/** `/tasks`: the assigned-issue list plus the history of runs. */
export function TasksPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "history" ? "history" : "tasks";
  const setTab = (next: Tab) => setParams(next === "tasks" ? {} : { tab: next });

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-medium ${
              tab === id
                ? "border-zinc-900 text-zinc-900 dark:border-zinc-100 dark:text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <OrphanedStashes />

      <div className="min-h-0 flex-1">{tab === "tasks" ? <TaskList /> : <RunHistory />}</div>
    </div>
  );
}
