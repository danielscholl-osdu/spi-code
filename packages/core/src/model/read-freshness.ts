// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts.js";
import type { SweepReads } from "../sweep/index.js";

export function inFlightReadFresh(
  area: "runs" | "github",
  repo: string | undefined,
  facts: Pick<Facts, "runs" | "github">,
  reads?: SweepReads,
): boolean {
  if (!repo || facts[area].error !== undefined) return false;
  return !reads?.[area]?.some((read) =>
    read.failure !== undefined && (area === "runs"
      ? read.source === repo && read.object === "fork-runs"
      : read.object === repo),
  );
}
