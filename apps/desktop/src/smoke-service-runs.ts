// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";

export const RUNS_ROUTE = "service/search/runs";
export const RUNS_FAILURE = ".service-page[aria-label=search] .service-run-failure";

export function withSmokeServiceRuns(snapshot: ViewSnapshot): ViewSnapshot {
  const end = Date.parse(snapshot.sweptAt);
  function entry(workflowId: number, name: string, index: number, result: string) {
    const id = 42100000000 + workflowId * 100 + index;
    const startedAt = new Date(end - index * 8 * 60 * 60 * 1000).toISOString();
    return {
      id,
      workflowId,
      name,
      attempt: 1,
      status: result === "in_progress" ? result : "completed",
      ...(result === "in_progress" ? {} : { conclusion: result }),
      createdAt: startedAt,
      startedAt,
      url: `https://github.com/Azure/osdu-spi-search/actions/runs/${id}`,
      result,
      tone:
        result === "failure"
          ? "error"
          : result === "success"
            ? "success"
            : result === "in_progress"
              ? "work"
              : "neutral",
    } as const;
  }
  const scenarios = [
    ["Sync Upstream", ["success", "success", "success", "failure", "in_progress"]],
    ["Validation", ["success", "failure", "success", "cancelled", "success", "success"]],
    ["Cascade Integration", ["success", "success", "success", "success"]],
    ["Sync Template", ["success", "success", "success", "success", "success", "success"]],
  ] as const;
  const workflows = scenarios.map(([name, results], index) => {
    const id = index + 1;
    return {
      id,
      name,
      runs: results.map((result, at) => entry(id, name, results.length - at, result)),
    };
  });
  const failed = workflows[0]?.runs.find(({ result }) => result === "failure");
  if (!failed) throw new Error("Runs capture requires a failed Sync Upstream run");
  return {
    ...snapshot,
    services: snapshot.services?.map((service) =>
      service.service === "search"
        ? {
            ...service,
            runHistory: {
              kind: "read",
              count: 1,
              cut: false,
              workflows,
              failing: [{ run: failed, job: "Sync upstream", step: "Update upstream branch" }],
            },
          }
        : service,
    ),
  };
}
