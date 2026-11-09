// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Facts, RunFact } from "../facts.js";
import { classifyPr } from "./attribution.js";
import type { LineModel } from "./lines.js";
import type { RolloutModel } from "./rollout.js";

function green(run: RunFact | undefined): boolean {
  return run?.status === "completed" && run.conclusion === "success";
}

// Forks verified on the target template revision (PS-09, PS-18): on the target, with a green
// main run since the template merge. Being on the revision is not enough, nor is a merged PR.
export function verifiedForks(
  lines: readonly LineModel[],
  rollout?: RolloutModel,
  runs?: Facts["runs"]["data"],
): number {
  if (rollout) {
    return rollout.forks.filter((fork) => {
      if (!fork.onTarget) return false;
      if (fork.mainRun) return green(fork.mainRun);
      const mergedAt = fork.merged?.at;
      return mergedAt !== undefined && (runs?.[fork.repo]?.main.some(
        (run) => green(run) && Date.parse(run.createdAt) >= Date.parse(mergedAt),
      ) ?? false);
    }).length;
  }
  return lines.filter((line) => {
    const merged = (line.past ?? [])
      .flatMap((pr) => pr.mergedAt && classifyPr(pr) === "template" ? [Date.parse(pr.mergedAt)] : []);
    return (
      line.template.behind === 0 &&
      green(line.mainRun) &&
      merged.length > 0 &&
      Date.parse(line.mainRun?.createdAt ?? "") >= Math.max(...merged)
    );
  }).length;
}
