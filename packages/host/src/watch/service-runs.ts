// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Facts, serviceRuns } from "@spi-code/core";
import type { WatchInput } from "./project.js";
import { readEnvelope } from "./provenance.js";

export function projectServiceRuns(facts: Facts, repo: string) {
  const fact = facts.serviceRuns?.[repo];
  return fact ? { runHistory: serviceRuns(fact) } : {};
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
