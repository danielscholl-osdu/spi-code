// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";

/** The environment's Running fact: the version core read and, while a run is in flight, that run. */
export function runningFact(snapshot: Pick<ViewSnapshot, "briefing">) {
  return snapshot.briefing.environment.facts.find(({ label }) => label === "Running");
}

/** The stop's tone: warning while a run is in flight, failed while not deployable, else nothing. */
export function holdTone(snapshot: Pick<ViewSnapshot, "briefing">): "warn" | "bad" | undefined {
  const running = runningFact(snapshot);
  if (!running || running.figure === "?") return undefined;
  if (running.tone === "warn") return "warn";
  return snapshot.briefing.environment.deployable === "no" ? "bad" : undefined;
}
