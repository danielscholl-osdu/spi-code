// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RunFact } from "../facts.js";

const FAILURES: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure"]);

export function workflowRunFailed(run: Pick<RunFact, "status" | "conclusion">): boolean {
  return run.status === "completed" && FAILURES.has(run.conclusion ?? "");
}

/** The failure still active in one workflow's runs, if no later attempt succeeded. */
export function workflowFailure<T extends Pick<RunFact, "createdAt" | "attempt" | "status" | "conclusion">>(
  runs: readonly T[],
): T | undefined {
  let latest: T | undefined;
  for (const run of runs) {
    if (run.status !== "completed" ||
        (run.conclusion !== "success" && !workflowRunFailed(run))) continue;
    if (!latest || Date.parse(run.createdAt) > Date.parse(latest.createdAt) ||
        (Date.parse(run.createdAt) === Date.parse(latest.createdAt) && run.attempt > latest.attempt)) {
      latest = run;
    }
  }
  return latest?.conclusion === "success" ? undefined : latest;
}
