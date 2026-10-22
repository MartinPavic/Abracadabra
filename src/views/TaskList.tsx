import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { RunStatusPill } from "../components/RunStatus";
import {
  describeError,
  listRuns,
  listTasks,
  openUrl,
  type RunRecord,
  startRun,
  type Task,
} from "../lib/api";
import { getCachedTasks, isFresh, setCachedTasks } from "../lib/taskCache";
import { useConfig } from "../lib/useConfig";

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

const inputClass =
  "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

const statusBadgeClass: Record<string, string> = {
  opened: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  open: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  closed: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400",
};
const defaultStatusBadgeClass = "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";

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
      <div className="flex h-full flex-col items-center justify-center text-center text-zinc-500 dark:text-zinc-400">
        <h1 className="mb-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          No tasks yet
        </h1>
        <p className="max-w-sm text-sm">
          Add a git source in{" "}
          <Link to="/settings" className="underline">
            Settings
          </Link>{" "}
          to start pulling in assigned issues.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {gitSources.length > 1 && (
          <select
            className={inputClass}
            aria-label="Git source"
            value={sourceId ?? ""}
            onChange={(e) => setSourceId(e.target.value)}
          >
            {gitSources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        )}

        <input
          className={`${inputClass} w-56`}
          aria-label="Search by title"
          placeholder="Search by title..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <select
          className={inputClass}
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
        </select>

        <select
          className={inputClass}
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
        </select>

        <select
          className={inputClass}
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
        </select>

        {fetchedAt && (
          <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
            Updated {new Date(fetchedAt).toLocaleTimeString()}
          </span>
        )}
        <button
          type="button"
          onClick={() => refresh()}
          disabled={loading}
          className={`${fetchedAt ? "" : "ml-auto "}rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900`}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {runError && <p className="text-sm text-red-600 dark:text-red-400">{runError}</p>}
      {batchMessage && (
        <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
          {batchMessage}{" "}
          <Link to="/tasks?tab=history" className="underline">
            Open history
          </Link>
        </p>
      )}
      {filteredTasks.some((task) => selected.has(task.id)) && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={batchRunning}
            onClick={handleRunSelected}
            className="rounded-md border border-zinc-900 bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {batchRunning
              ? "Starting..."
              : `Run selected (${filteredTasks.filter((task) => selected.has(task.id)).length})`}
          </button>
          <button
            type="button"
            disabled={batchRunning}
            onClick={() => setSelected(new Set())}
            className="rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            Clear selection
          </button>
        </div>
      )}

      {!error && tasks !== null && (
        <div className="flex-1 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="w-8 px-4 py-2">
                  <input
                    type="checkbox"
                    aria-label="Select all shown tasks"
                    checked={
                      filteredTasks.length > 0 && filteredTasks.every((task) => selected.has(task.id))
                    }
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(filteredTasks.map((t) => t.id)) : new Set())
                    }
                  />
                </th>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Labels</th>
                <th className="px-4 py-2 font-medium">Updated</th>
                <th className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.map((task) => (
                <tr
                  key={task.id}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                >
                  <td className="w-8 px-4 py-2">
                    <input
                      type="checkbox"
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
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openUrl(task.url)}
                        className="text-left text-zinc-900 hover:underline dark:text-zinc-100"
                      >
                        {task.title}
                      </button>
                      {latestRunByTask.get(task.id) && (
                        <Link
                          to={`/tasks/${latestRunByTask.get(task.id)?.id}`}
                          title="Open the latest run for this task"
                        >
                          <RunStatusPill status={latestRunByTask.get(task.id)?.status ?? "queued"} />
                        </Link>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{task.project}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusBadgeClass[task.status] ?? defaultStatusBadgeClass}`}
                    >
                      {statusLabel(task.status)}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {task.labels.map((label) => (
                        <span
                          key={label}
                          className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                    {new Date(task.updatedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => handleRun(task.id, true)}
                        disabled={startingTask !== null}
                        title="Produce a plan only: no changes are committed"
                        className="min-w-20 whitespace-nowrap rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                      >
                        Plan
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRun(task.id)}
                        disabled={startingTask !== null}
                        className="min-w-24 whitespace-nowrap rounded-md border border-zinc-900 bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                      >
                        {startingTask === task.id ? "Starting..." : "Run"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredTasks.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                    No tasks match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
