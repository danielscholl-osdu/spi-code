// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RunFact } from "../facts.js";

const FAILURES: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure"]);

export function workflowRunFailed(run: Pick<RunFact, "status" | "conclusion">): boolean {
  return run.status === "completed" && FAILURES.has(run.conclusion ?? "");
}

type WorkflowAttempt = Pick<RunFact, "createdAt" | "attempt" | "status" | "conclusion"> & {
  startedAt?: string | undefined;
};

/** The failure still active in one workflow's runs, if no later attempt succeeded. */
export function workflowFailure<T extends WorkflowAttempt>(runs: readonly T[]): T | undefined {
  let latest: T | undefined;
  let latestAt = 0;
  for (const run of runs) {
    if (run.status !== "completed" ||
        (run.conclusion !== "success" && !workflowRunFailed(run))) continue;
    const at = Date.parse(run.startedAt ?? run.createdAt);
    if (!latest || at > latestAt || (at === latestAt && run.attempt > latest.attempt)) {
      latest = run;
      latestAt = at;
    }
  }
  return latest?.conclusion === "success" ? undefined : latest;
}
