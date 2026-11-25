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

function laterAttempt(run: WorkflowAttempt, than: WorkflowAttempt, at: number, thanAt: number) {
  if (run.id !== undefined && run.id === than.id) return run.attempt > than.attempt;
  return at > thanAt || (at === thanAt && run.attempt > than.attempt);
}

/** The failure still active in one workflow's runs, if no later attempt succeeded. */
export function workflowFailure<T extends WorkflowAttempt>(runs: readonly T[]): T | undefined {
  let latest: T | undefined;
  let latestAt = 0;
  for (const run of runs) {
    if (run.status !== "completed" ||
        (run.conclusion !== "success" && !workflowRunFailed(run))) continue;
    const at = Date.parse(run.startedAt ?? run.createdAt);
    if (!latest || laterAttempt(run, latest, at, latestAt)) {
      latest = run;
      latestAt = at;
    }
  }
  return latest?.conclusion === "success" ? undefined : latest;
}
