// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";

export const RED_MAIN = {
  path: "Validation › Deploy and Test › Prove",
  evidence: "Lane deploy failed 08:44 in attempt 1",
};

/** A fork whose Main failed on the environment, as the service page draws it: a washed row and a red station. */
export function withRedMain(snapshot: ViewSnapshot, service: string): ViewSnapshot {
  const home = snapshot.services?.find((entry) => entry.service === service)?.home;
  if (!home) return snapshot;
  const id = `main:${service}`;
  const run = `https://github.com/Azure/osdu-spi-${service}/actions/runs/18842`;
  home.stations = home.stations.map((station) =>
    station.id === "main"
      ? { id: "main", state: "stopped", word: "Red", line: "Validation failed 08:46", row: id }
      : station,
  );
  home.overview.unshift({
    id,
    section: "blocked",
    headline: "Main build failed",
    cause: "Validation failed on main.",
    steps: [],
    links: [
      { label: "Attempt 1", url: `${run}/attempts/1`, kind: "run" },
      {
        label: "Deployments",
        url: `https://github.com/Azure/osdu-spi-${service}/deployments`,
        kind: "deploy",
      },
    ],
    failure: { path: RED_MAIN.path, reason: "environment timeout", verdict: "Environment" },
    evidence: RED_MAIN.evidence,
    jobs: "Failed in attempt 1: Deploy and Test (Prove). Validation Summary repeats it.",
    next: "Re-run the failed jobs once. If it fails again, diagnose.",
  });
  return snapshot;
}
