import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { buttonClasses, EmptyState, TabPanel, Tabs, type TabDef } from "../components/ui";
import { useConfig } from "../lib/useConfig";
import { describeError, getRun, isCancellable, type RunRecord } from "../lib/api";
import { ActivityTab } from "./run/ActivityTab";
import { ChangesTab } from "./run/ChangesTab";
import { OverviewTab } from "./run/OverviewTab";
import { RunHeader } from "./run/RunHeader";

type RunTab = "overview" | "changes" | "activity";

function defaultTab(run: RunRecord): RunTab {
  const hasChanges =
    run.status === "awaiting_approval" || run.status === "working" || run.status === "reviewing";
  return hasChanges && !run.planOnly ? "changes" : "overview";
}

export function TaskRun() {
  const { id } = useParams();
  const { config } = useConfig();
  const [run, setRun] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Null until the user picks a tab; until then the tab follows the run's status.
  const [chosenTab, setChosenTab] = useState<RunTab | null>(null);
  // Identifies the latest load; slower, older responses must not overwrite newer ones.
  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    if (!id) return;
    const thisLoad = ++latestLoad.current;
    try {
      const loaded = await getRun(id);
      if (thisLoad !== latestLoad.current) return;
      setRun(loaded);
      setError(null);
    } catch (err) {
      if (thisLoad === latestLoad.current) setError(describeError(err));
    }
  }, [id]);

  useEffect(() => {
    // Opening another run must not keep showing the previous one; the tabs' own state
    // resets because they unmount while `run` is null.
    setRun(null);
    setError(null);
    setChosenTab(null);

    let disposed = false;
    const unlisten = listen<{ runId: string }>("run://status", ({ payload }) => {
      if (payload.runId === id) void load();
    });
    // Load only once subscribed, so a status change in between can't be missed.
    unlisten.then(
      () => !disposed && void load(),
      () => !disposed && void load(),
    );
    return () => {
      disposed = true;
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, [id, load]);

  if (!run) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon="search"
          title="Run not found"
          description={error ?? "Loading..."}
          action={
            <Link to="/tasks" className={buttonClasses("secondary", "sm")}>
              Back to tasks
            </Link>
          }
        />
      </div>
    );
  }

  const tab = chosenTab ?? defaultTab(run);
  const tabs: TabDef<RunTab>[] = [
    { id: "overview", label: "Overview" },
    {
      id: "changes",
      label: "Changes",
      indicator: run.status === "awaiting_approval" && !run.planOnly ? "dot" : null,
    },
    { id: "activity", label: "Activity", indicator: isCancellable(run.status) ? "pulse" : null },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <RunHeader run={run} config={config} reload={load} />
      <Tabs tabs={tabs} value={tab} onChange={setChosenTab} idPrefix="run" label="Run sections" />
      <TabPanel id="overview" value={tab} idPrefix="run">
        <OverviewTab run={run} config={config} reload={load} />
      </TabPanel>
      <TabPanel id="changes" value={tab} idPrefix="run">
        <ChangesTab run={run} reload={load} />
      </TabPanel>
      <TabPanel id="activity" value={tab} idPrefix="run">
        <ActivityTab run={run} />
      </TabPanel>
    </div>
  );
}
