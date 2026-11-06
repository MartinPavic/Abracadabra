import { useSearchParams } from "react-router-dom";
import { OrphanedStashes } from "../components/OrphanedStashes";
import { RunHistory } from "../components/RunHistory";
import { PageHeader, TabPanel, Tabs, type TabDef } from "../components/ui";
import { TaskList } from "./TaskList";

type Tab = "tasks" | "history";

const TABS: TabDef<Tab>[] = [
  { id: "tasks", label: "Tasks" },
  { id: "history", label: "History" },
];

/** `/tasks`: the assigned-issue list plus the history of runs. */
export function TasksPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "history" ? "history" : "tasks";
  const setTab = (next: Tab) => setParams(next === "tasks" ? {} : { tab: next });

  return (
    <div className="flex flex-col pb-6">
      <PageHeader title="Tasks" description="Issues assigned to you, ready to hand to an agent." />
      <Tabs tabs={TABS} value={tab} onChange={setTab} idPrefix="tasks-page" label="Tasks and history" />

      <div className="mt-4 flex flex-col gap-4">
        <OrphanedStashes />
        {/* Only the active view is mounted: each one fetches on mount. */}
        <TabPanel id={tab} value={tab} idPrefix="tasks-page">
          {tab === "tasks" ? <TaskList /> : <RunHistory />}
        </TabPanel>
      </div>
    </div>
  );
}
