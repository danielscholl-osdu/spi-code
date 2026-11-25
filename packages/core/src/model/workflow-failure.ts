// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RunFact } from "../facts.js";

const FAILURES: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure"]);

export function workflowRunFailed(run: Pick<RunFact, "status" | "conclusion">): boolean {
  return run.status === "completed" && FAILURES.has(run.conclusion ?? "");
}

type WorkflowAttempt = Pick<RunFact, "createdAt" | "attempt" | "status" | "conclusion"> & {
  id?: number;
  startedAt?: string | undefined;
};

/** When a completed run reached its result. */
export function runFailedAt(run: Pick<RunFact, "updatedAt">): string {
  return run.updatedAt;
}

const later = <T extends WorkflowAttempt>(a: { run: T; at: number }, b: { run: T; at: number }) =>
  (a.at - b.at || (a.run.id ?? 0) - (b.run.id ?? 0) || a.run.attempt - b.run.attempt ||
    Number(a.run.conclusion === "success") - Number(b.run.conclusion === "success")) > 0;

/** The failure still active in one workflow's runs, if no later attempt succeeded. */
export function workflowFailure<T extends WorkflowAttempt>(runs: readonly T[]): T | undefined {
  const byRun = new Map<number | T, { run: T; at: number }>();
  for (const run of runs) {
    if (run.status !== "completed" ||
        (run.conclusion !== "success" && !workflowRunFailed(run))) continue;
    const key = run.id ?? run;
    const at = Date.parse(run.startedAt ?? run.createdAt);
    const known = byRun.get(key);
    // A later attempt starts after every earlier one, so the run is as late as its latest known start.
    byRun.set(key, known
      ? { run: run.attempt > known.run.attempt ? run : known.run, at: Math.max(at, known.at) }
      : { run, at });
  }
  let latest: { run: T; at: number } | undefined;
  for (const entry of byRun.values()) if (!latest || later(entry, latest)) latest = entry;
  return latest?.run.conclusion === "success" ? undefined : latest?.run;
}
