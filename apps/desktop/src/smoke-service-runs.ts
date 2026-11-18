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
    const pending = result === "in_progress" || result === "queued";
    return {
      id,
      workflowId,
      name,
      attempt: 1,
      status: pending ? result : "completed",
      ...(pending ? {} : { conclusion: result }),
      createdAt: startedAt,
      startedAt,
      url: `https://github.com/Azure/osdu-spi-search/actions/runs/${id}`,
      result,
      tone:
        result === "failure"
          ? "error"
          : result === "success"
            ? "success"
            : pending
              ? "work"
              : "neutral",
    } as const;
  }
  const scenarios = [
    ["Sync Upstream", ["success", "success", "success", "failure", "in_progress"]],
    ["Validation", ["success", "failure", "success", "cancelled", "skipped", "success"]],
    ["Cascade Integration", ["success", "success", "success", "success"]],
    ["Publish dependency reports for the release branch", ["success", "queued"]],
    ["Sync Template", ["success", "success", "success", "success", "success", "success"]],
    ["Copilot Code Review", ["success"]],
    ["Dependabot Updates", ["success", "success"]],
  ] as const;
  const workflows = scenarios.map(([name, results], index) => {
    const id = index + 1;
    return {
      id,
      name,
      runs: results.map((result, at) => entry(id, name, results.length - at, result)),
      ...(index >= 5 ? { automation: true as const } : {}),
    };
  });
  const failed = workflows[0]?.runs.find(({ result }) => result === "failure");
  const main = workflows[1]?.runs.find(({ result }) => result === "failure");
  if (!failed || !main)
    throw new Error("Runs capture requires failed Sync Upstream and Validation runs");
  return {
    ...snapshot,
    services: snapshot.services?.map((service) =>
      service.service === "search"
        ? {
            ...service,
            ...(service.home
              ? {
                  home: {
                    ...service.home,
                    stations: service.home.stations.map((station) =>
                      station.id === "main"
                        ? { ...station, state: "stopped" as const, word: "Red" }
                        : station,
                    ),
                  },
                }
              : {}),
            runHistory: {
              kind: "read",
              count: 2,
              cut: true,
              workflows,
              failing: [
                { run: failed, job: "Sync upstream", step: "Update upstream branch" },
                {
                  run: main,
                  main: {
                    id: main.id,
                    attempt: main.attempt,
                    url: main.url,
                    failedAt: main.startedAt,
                  },
                },
              ],
            },
          }
        : service,
    ),
  };
}
