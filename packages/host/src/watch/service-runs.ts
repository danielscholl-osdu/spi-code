// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceHome } from "@spi-code/contracts";
import { type Facts, type LineModel, serviceRuns } from "@spi-code/core";
import type { WatchInput } from "./project.js";
import { readEnvelope } from "./provenance.js";

export function projectServiceRuns(facts: Facts, line: LineModel, home: ServiceHome | undefined) {
  const fact = facts.serviceRuns?.[line.fork.repo];
  const main = home?.stations.find(({ id }) => id === "main");
  return fact
    ? {
        runHistory: serviceRuns(fact, main?.state === "stopped" ? line.mainRed?.run : undefined),
      }
    : {};
}

export function serviceRunsProvenance(input: WatchInput, repo: string, path: string, now: Date) {
  const fact = input.facts.serviceRuns?.[repo];
  return fact
    ? [
        {
          path,
          areas: ["runs" as const],
          envelope: readEnvelope("runs", [fact.read, ...fact.jobs], input.intervalMs, now),
        },
      ]
    : [];
}
