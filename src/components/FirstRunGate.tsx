import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useConfig } from "../lib/useConfig";

export const SETUP_SKIPPED_KEY = "setup-skipped";

/** Must be the route element itself so it re-reads the config per visit; a stale one would loop. */
export function FirstRunGate({ children }: { children: ReactNode }) {
  const { config, loading } = useConfig();
  if (loading) return null;
  if (
    config &&
    config.gitSources.length === 0 &&
    localStorage.getItem(SETUP_SKIPPED_KEY) === null
  ) {
    return <Navigate to="/setup" replace />;
  }
  // A config that failed to load must not trap the user; the page shows its own error.
  return children;
}
