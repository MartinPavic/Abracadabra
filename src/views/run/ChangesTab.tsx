import { DiffViewer } from "../../components/DiffViewer";
import { FileReview } from "../../components/FileReview";
import { EmptyState } from "../../components/ui";
import type { RunRecord } from "../../lib/api";

export function ChangesTab({ run, reload }: { run: RunRecord; reload: () => Promise<void> }) {
  if ((run.status === "working" || run.status === "reviewing") && !run.planOnly) {
    return <DiffViewer runId={run.id} live />;
  }
  if (run.status === "awaiting_approval" && !run.planOnly) {
    return <FileReview run={run} onChanged={reload} />;
  }
  if (run.status === "awaiting_approval" || run.status === "approved") {
    return <DiffViewer runId={run.id} redone={Boolean(run.previousCommitSha)} />;
  }
  return <EmptyState icon="file" title="No changes to show yet." />;
}
