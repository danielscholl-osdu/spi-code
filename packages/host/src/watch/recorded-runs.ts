// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Facts, RunFact } from "@spi-code/core";

export interface RunHit {
  run: RunFact;
  repo: string;
  workflow: string;
  area: "runs" | "lifecycle" | "approvals";
}

/** Match the inspector and service lists against the same set of recorded runs. */
export function recordedRuns(facts: Facts, stackRepo: string): RunHit[] {
  const found = new Map<number, RunHit>();
  const add = (run: RunFact, repo: string, workflow: string, area: RunHit["area"]) => {
    if (!found.has(run.id)) found.set(run.id, { run, repo, workflow, area });
  };
  for (const [repo, lanes] of Object.entries(facts.runs.data ?? {})) {
    for (const workflow of ["sync", "template", "cascade", "main"] as const) {
      for (const run of lanes[workflow]) add(run, repo, workflow, "runs");
    }
  }
  for (const [workflow, list] of Object.entries(facts.lifecycle.data ?? {})) {
    for (const run of list) {
      const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\//.exec(run.url)?.[1];
      add(run, repo ?? stackRepo, workflow, "lifecycle");
    }
  }
  for (const [repo, list] of Object.entries(facts.approvals.data ?? {})) {
    for (const run of list) add(run, repo, "approval", "approvals");
  }
  return [...found.values()];
}
