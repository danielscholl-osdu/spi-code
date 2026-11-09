// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { LastSweep, SweepSchedule, SweepStatus } from "@spi-code/contracts";
import { GITLAB_EVERY_MS, RELEASES_EVERY_MS, SECURITY_EVERY_MS, SWEEP_MS } from "@spi-code/core";

export const SWEEP_SCHEDULE: SweepSchedule = Object.freeze({
  sweepMs: SWEEP_MS,
  gitlabMs: GITLAB_EVERY_MS,
  securityMs: SECURITY_EVERY_MS,
  releasesMs: RELEASES_EVERY_MS,
});

/** The scheduler's half of sweep.status; lastSweep is present only when a sweep just finished. */
export interface SweepSchedulerStatus {
  readonly nextSweepAt: string | null;
  readonly lastSweep?: LastSweep;
}

/** A sweep.status before any budget, timer or finished sweep is known. */
export function emptySweepStatus(): SweepStatus {
  return {
    remaining: null,
    resetAt: null,
    deferredAreas: [],
    nextSweepAt: null,
    schedule: SWEEP_SCHEDULE,
    lastSweep: null,
  };
}
