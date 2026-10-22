import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RunStatusPill } from "../components/RunStatus";
import { deleteRun, describeError, isFinished, listRuns, type RunRecord } from "../lib/api";

const ALL = "__all__";

const inputClass =
  "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

/** Past and current runs, newest first; each row opens the run view. */
export function RunHistory() {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [search, setSearch] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete(runId: string) {
    setDeleteError(null);
    try {
      await deleteRun(runId);
      setRuns((current) => current?.filter((r) => r.id !== runId) ?? null);
    } catch (err) {
      setDeleteError(describeError(err));
    } finally {
      setConfirmId(null);
    }
  }

  useEffect(() => {
    const load = () =>
      listRuns()
        .then((list) => {
          setRuns(list);
          setError(null);
        })
        .catch((err) => setError(describeError(err)));
    load();
    const unlisten = listen("run://status", load);
    return () => {
      unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, []);

  const statuses = useMemo(
    () => Array.from(new Set((runs ?? []).map((r) => r.status))).sort(),
    [runs],
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (runs ?? []).filter(
      (r) =>
        (statusFilter === ALL || r.status === statusFilter) &&
        (query === "" ||
          `${r.taskTitle} ${r.project} ${r.branch ?? ""} ${r.taskId}`.toLowerCase().includes(query)),
    );
  }, [runs, statusFilter, search]);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (runs === null) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</p>;

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center gap-3">
        <input
          className={`${inputClass} w-64`}
          aria-label="Search runs"
          placeholder="Search title, project or branch..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className={inputClass}
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value={ALL}>All statuses</option>
          {statuses.map((status) => (
            <option key={status} value={status}>
              {status.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        {deleteError && <span className="text-sm text-red-600 dark:text-red-400">{deleteError}</span>}
      </div>

      <div className="flex-1 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-2 font-medium">Task</th>
              <th className="px-4 py-2 font-medium">Project</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Started</th>
              <th className="px-4 py-2 font-medium">Updated</th>
              <th className="px-4 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((run) => (
              <tr
                key={run.id}
                className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
              >
                <td className="px-4 py-2">
                  <Link
                    to={`/tasks/${run.id}`}
                    className="text-zinc-900 hover:underline dark:text-zinc-100"
                  >
                    {run.taskTitle || run.id}
                  </Link>
                </td>
                <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{run.project}</td>
                <td className="px-4 py-2">
                  <RunStatusPill status={run.status} />
                </td>
                <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                  {new Date(run.createdAtMs).toLocaleString()}
                </td>
                <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                  {new Date(run.updatedAtMs).toLocaleString()}
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  {isFinished(run.status) &&
                    (confirmId === run.id ? (
                      <span className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleDelete(run.id)}
                          className="rounded-md border border-red-600 bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmId(null)}
                          className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Delete run ${run.taskTitle || run.id}`}
                        onClick={() => setConfirmId(run.id)}
                        className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
                      >
                        Delete
                      </button>
                    ))}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-zinc-500 dark:text-zinc-400">
                  {runs.length === 0 ? "No runs yet." : "No runs match the current filter."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
