import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RunStatusPill } from "../components/RunStatus";
import { deleteRun, describeError, isFinished, listRuns, type RunRecord } from "../lib/api";
import { Badge, Button, Card, EmptyState, Icon, Input, Notice, Select } from "./ui";

const ALL = "__all__";

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

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (runs === null) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading...</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-3 bg-zinc-50 px-1 py-2 dark:bg-zinc-950">
        <div className="relative w-64">
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400 dark:text-zinc-500"
          />
          <Input
            className="pl-8"
            aria-label="Search runs"
            placeholder="Search title, project or branch..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-44">
          <Select
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
          </Select>
        </div>
      </div>

      {deleteError && <Notice tone="danger">{deleteError}</Notice>}

      <Card padded={false}>
        {filtered.length === 0 ? (
          <EmptyState
            icon={runs.length === 0 ? "history" : "search"}
            title={runs.length === 0 ? "No runs yet." : "No runs match the current filter."}
          />
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {filtered.map((run) => (
              <li key={run.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/tasks/${run.id}`}
                    title={run.taskTitle || run.id}
                    className="block truncate rounded font-medium text-zinc-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-zinc-100"
                  >
                    {run.taskTitle || run.id}
                  </Link>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <Badge>
                      <span className="max-w-48 truncate" title={run.project}>
                        {run.project}
                      </span>
                    </Badge>
                    <span>Started {new Date(run.createdAtMs).toLocaleString()}</span>
                    <span aria-hidden="true">·</span>
                    <span>Updated {new Date(run.updatedAtMs).toLocaleString()}</span>
                  </div>
                </div>
                <RunStatusPill status={run.status} />
                <div className="flex w-36 shrink-0 items-center justify-end gap-2">
                  {isFinished(run.status) &&
                    (confirmId === run.id ? (
                      <>
                        <Button size="sm" variant="danger" onClick={() => handleDelete(run.id)}>
                          Delete
                        </Button>
                        <Button size="sm" onClick={() => setConfirmId(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="trash"
                        aria-label={`Delete run ${run.taskTitle || run.id}`}
                        onClick={() => setConfirmId(run.id)}
                      >
                        Delete
                      </Button>
                    ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
