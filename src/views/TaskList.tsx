import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ReadyBanner } from "../components/ReadyBanner";
import { RunStatusPill } from "../components/RunStatus";
import { Badge, Button, Card, EmptyState, Icon, Input, Notice, Select, type Tone } from "../components/ui";
import {
  describeError,
  listRuns,
  listTasks,
  openUrl,
  type RunRecord,
  startRun,
  type Task,
} from "../lib/api";
import { summarizeReady } from "../lib/ready";
import { getCachedTasks, isFresh, setCachedTasks } from "../lib/taskCache";
import { useConfig } from "../lib/useConfig";
import { useReady } from "../lib/useReady";

const ALL = "__all__";
const HIDE_CLOSED = "__hide_closed__";

interface SavedFilters {
  search: string;
  project: string;
  label: string;
  status: string;
}

const filtersKey = (sourceId: string) => `taskFilters:${sourceId}`;

function loadFilters(sourceId: string): SavedFilters | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(filtersKey(sourceId)) ?? "null");
    if (parsed && typeof parsed === "object") {
      const { search, project, label, status } = parsed as Record<string, unknown>;
      if ([search, project, label, status].every((value) => typeof value === "string")) {
        return parsed as SavedFilters;
      }
    }
  } catch {
    // Unreadable saved filters just mean defaults.
  }
  return null;
}

const statusTone: Record<string, Tone> = { opened: "success", open: "success", closed: "neutral" };

// No checkbox primitive; the focus outline (rather than a ring) is drawn on native checkboxes too.
const checkboxClass =
  "size-4 shrink-0 rounded accent-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500 dark:accent-accent-400";

/** GitLab calls the open state "opened"; show it as "open". */
const statusLabel = (status: string) => (status === "opened" ? "open" : status);

/** A fetched task list together with the git source it belongs to. */
interface TaskView {
  sourceId: string;
  tasks: Task[];
  fetchedAt: number;
}

export function TaskList() {
  const { config, loading: configLoading } = useConfig();
  const navigate = useNavigate();
  const gitSources = config?.gitSources ?? [];

  const [sourceId, setSourceId] = useState<string | null>(null);
  const [view, setView] = useState<TaskView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState(ALL);
  const [labelFilter, setLabelFilter] = useState(ALL);
  const [statusFilter, setStatusFilter] = useState(HIDE_CLOSED);
  const [runError, setRunError] = useState<string | null>(null);
  const [startingTask, setStartingTask] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  // The source whose saved filters are applied; filters are only saved once loaded.
  const [filtersFor, setFiltersFor] = useState<string | null>(null);
  // Identifies the latest fetch; responses from older ones (e.g. a previous source) are dropped.
  const latestFetch = useRef(0);

  const tasks = view?.tasks ?? null;
  const fetchedAt = view?.fetchedAt ?? null;
  const { problems, runBlock, planBlock } = summarizeReady(useReady(sourceId) ?? []);

  useEffect(() => {
    if (gitSources.length > 0 && !gitSources.some((s) => s.id === sourceId)) {
      setSourceId(gitSources[0].id);
    }
  }, [gitSources, sourceId]);

  useEffect(() => {
    if (!sourceId) return;
    const saved = loadFilters(sourceId);
    setSearch(saved?.search ?? "");
    setProjectFilter(saved?.project ?? ALL);
    setLabelFilter(saved?.label ?? ALL);
    setStatusFilter(saved?.status ?? HIDE_CLOSED);
    setFiltersFor(sourceId);
  }, [sourceId]);

  useEffect(() => {
    if (!sourceId || filtersFor !== sourceId) return;
    const filters: SavedFilters = {
      search,
      project: projectFilter,
      label: labelFilter,
      status: statusFilter,
    };
    localStorage.setItem(filtersKey(sourceId), JSON.stringify(filters));
  }, [sourceId, filtersFor, search, projectFilter, labelFilter, statusFilter]);

  useEffect(() => {
    const load = () =>
      listRuns()
        .then(setRuns)
        .catch(() => undefined);
    load();
    const unlisten = listen("run://status", load);
    return () => {
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, []);

  // Newest run per task of the shown source (the list arrives newest first).
  const latestRunByTask = useMemo(() => {
    const byTask = new Map<string, RunRecord>();
    for (const run of runs) {
      if (run.sourceId === view?.sourceId && !byTask.has(run.taskId)) byTask.set(run.taskId, run);
    }
    return byTask;
  }, [runs, view?.sourceId]);

  async function refresh(forSource: string | null = sourceId) {
    if (!forSource) return;
    const thisFetch = ++latestFetch.current;
    setLoading(true);
    setError(null);
    try {
      const entry = setCachedTasks(forSource, await listTasks(forSource));
      if (thisFetch === latestFetch.current) setView({ sourceId: forSource, ...entry });
    } catch (err) {
      if (thisFetch === latestFetch.current) setError(describeError(err));
    } finally {
      if (thisFetch === latestFetch.current) setLoading(false);
    }
  }

  async function handleRun(taskId: string, planOnly = false) {
    // Always the source the shown tasks came from, never one picked after the list was fetched.
    if (!view || startingTask) return;
    setRunError(null);
    setStartingTask(taskId);
    try {
      const runId = await startRun(view.sourceId, taskId, planOnly);
      navigate(`/tasks/${runId}`);
    } catch (err) {
      setRunError(describeError(err));
    } finally {
      setStartingTask(null);
    }
  }

  async function handleRunSelected() {
    if (!view || batchRunning) return;
    // Only what is still on screen: filters may have hidden earlier picks.
    const picked = filteredTasks.filter((task) => selected.has(task.id));
    if (picked.length === 0) return;
    setBatchRunning(true);
    setBatchMessage(null);
    setRunError(null);
    const refused: string[] = [];
    let started = 0;
    for (const task of picked) {
      try {
        await startRun(view.sourceId, task.id, false);
        started += 1;
      } catch (err) {
        refused.push(`${task.title}: ${describeError(err)}`);
      }
    }
    setSelected(new Set());
    setBatchRunning(false);
    setBatchMessage(
      `Started ${started} run${started === 1 ? "" : "s"}${
        refused.length > 0 ? `; ${refused.length} refused:\n${refused.join("\n")}` : ""
      }. Runs in the same project go one at a time, in this order.`,
    );
  }

  useEffect(() => {
    setSelected(new Set());
    setBatchMessage(null);
    if (!sourceId) return;
    latestFetch.current += 1; // drop any response still in flight for the previous source
    setError(null);
    setLoading(false);
    const cached = getCachedTasks(sourceId);
    setView(cached ? { sourceId, ...cached } : null);
    if (!cached || !isFresh(cached)) void refresh(sourceId);
  }, [sourceId]);

  const projects = useMemo(
    () => Array.from(new Set((tasks ?? []).map((t) => t.project))).sort(),
    [tasks],
  );
  const labels = useMemo(
    () => Array.from(new Set((tasks ?? []).flatMap((t) => t.labels))).sort(),
    [tasks],
  );
  const statuses = useMemo(
    () => Array.from(new Set((tasks ?? []).map((t) => t.status))).sort(),
    [tasks],
  );

  // A saved filter for something that no longer exists in the list must not hide everything.
  const activeProject = projects.includes(projectFilter) ? projectFilter : ALL;
  const activeLabel = labels.includes(labelFilter) ? labelFilter : ALL;
  const activeStatus =
    statusFilter === ALL || statusFilter === HIDE_CLOSED || statuses.includes(statusFilter)
      ? statusFilter
      : HIDE_CLOSED;

  const filteredTasks = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (tasks ?? []).filter((task) => {
      if (query && !task.title.toLowerCase().includes(query)) return false;
      if (activeProject !== ALL && task.project !== activeProject) return false;
      if (activeLabel !== ALL && !task.labels.includes(activeLabel)) return false;
      if (activeStatus === HIDE_CLOSED) {
        if (task.status === "closed") return false;
      } else if (activeStatus !== ALL && task.status !== activeStatus) return false;
      return true;
    });
  }, [tasks, search, activeProject, activeLabel, activeStatus]);

  if (configLoading) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</p>;
  }

  if (gitSources.length === 0) {
    return (
      <Card>
        <EmptyState
          icon="tasks"
          title="No tasks yet"
          description={
            <>
              Add a git source in{" "}
              <Link
                to="/settings"
                className="rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                Settings
              </Link>{" "}
              to start pulling in assigned issues.
            </>
          }
        />
      </Card>
    );
  }

  const selectedCount = filteredTasks.filter((task) => selected.has(task.id)).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {gitSources.length > 1 && (
          <div className="w-40">
            <Select
              aria-label="Git source"
              value={sourceId ?? ""}
              onChange={(e) => setSourceId(e.target.value)}
            >
              {gitSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </Select>
          </div>
        )}

        <div className="relative w-56">
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400 dark:text-zinc-500"
          />
          <Input
            className="pl-8"
            aria-label="Search by title"
            placeholder="Search by title..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="w-40">
          <Select
            aria-label="Filter by project"
            value={activeProject}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value={ALL}>All projects</option>
            {projects.map((project) => (
              <option key={project} value={project}>
                {project}
              </option>
            ))}
          </Select>
        </div>

        <div className="w-36">
          <Select
            aria-label="Filter by label"
            value={activeLabel}
            onChange={(e) => setLabelFilter(e.target.value)}
          >
            <option value={ALL}>All labels</option>
            {labels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </Select>
        </div>

        <div className="w-36">
          <Select
            aria-label="Filter by status"
            value={activeStatus}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value={HIDE_CLOSED}>Hide closed</option>
            <option value={ALL}>All statuses</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </Select>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {fetchedAt && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Updated {new Date(fetchedAt).toLocaleTimeString()}
            </span>
          )}
          <Button icon="refresh" loading={loading} onClick={() => refresh()}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
          {selectedCount > 0 && (
            <>
              <Button variant="ghost" disabled={batchRunning} onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
              <Button
                variant="primary"
                icon="play"
                loading={batchRunning}
                disabled={runBlock !== null}
                title={runBlock ?? undefined}
                onClick={handleRunSelected}
              >
                {batchRunning ? "Starting..." : `Run selected (${selectedCount})`}
              </Button>
            </>
          )}
        </div>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}
      <ReadyBanner problems={problems} />
      {runError && <Notice tone="danger">{runError}</Notice>}
      {batchMessage && (
        <Notice tone="info">
          <p className="whitespace-pre-wrap">
            {batchMessage}{" "}
            <Link
              to="/tasks?tab=history"
              className="rounded font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            >
              Open history
            </Link>
          </p>
        </Notice>
      )}

      {!error && tasks !== null && (
        <Card padded={false}>
          {filteredTasks.length === 0 ? (
            <EmptyState icon="search" title="No tasks match the current filters." />
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  aria-label="Select all shown tasks"
                  checked={filteredTasks.length > 0 && filteredTasks.every((task) => selected.has(task.id))}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(filteredTasks.map((t) => t.id)) : new Set())
                  }
                />
                <span>
                  {filteredTasks.length} task{filteredTasks.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {filteredTasks.map((task) => {
                  const latestRun = latestRunByTask.get(task.id);
                  return (
                    <li key={task.id} className="flex items-center gap-3 px-4 py-3">
                      <input
                        type="checkbox"
                        className={checkboxClass}
                        aria-label={`Select ${task.title}`}
                        checked={selected.has(task.id)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(task.id);
                            else next.delete(task.id);
                            return next;
                          })
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openUrl(task.url)}
                            title={task.title}
                            className="min-w-0 truncate rounded text-left font-medium text-zinc-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-zinc-100"
                          >
                            {task.title}
                          </button>
                          {latestRun && (
                            <Link
                              to={`/tasks/${latestRun.id}`}
                              title="Open the latest run for this task"
                              className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                            >
                              <RunStatusPill status={latestRun.status} />
                            </Link>
                          )}
                        </div>
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                          <Badge>
                            <Icon name="folder" className="size-3 shrink-0" />
                            <span className="max-w-48 truncate" title={task.project}>
                              {task.project}
                            </span>
                          </Badge>
                          <Badge tone={statusTone[task.status] ?? "info"}>
                            <span className="capitalize">{statusLabel(task.status)}</span>
                          </Badge>
                          {task.labels.map((label) => (
                            <Badge key={label}>
                              <span className="max-w-40 truncate" title={label}>
                                {label}
                              </span>
                            </Badge>
                          ))}
                          <span>Updated {new Date(task.updatedAt).toLocaleString()}</span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="list"
                          onClick={() => handleRun(task.id, true)}
                          disabled={startingTask !== null || planBlock !== null}
                          title={planBlock ?? "Produce a plan only: no changes are committed"}
                        >
                          Plan
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          icon="play"
                          loading={startingTask === task.id}
                          onClick={() => handleRun(task.id)}
                          disabled={startingTask !== null || runBlock !== null}
                          title={runBlock ?? undefined}
                        >
                          {startingTask === task.id ? "Starting..." : "Run"}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
