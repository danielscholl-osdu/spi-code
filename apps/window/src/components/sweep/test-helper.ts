// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type SweepProgress, SweepProgressSchema } from "@spi-code/contracts";

export const SWEEP_START = Date.parse("2026-11-09T08:00:00Z");

/** An instant `seconds` after the sweep started. */
export const after = (seconds: number) => new Date(SWEEP_START + seconds * 1000).toISOString();

const read = (source: string, from: number, took: number) => ({
  source,
  state: "read" as const,
  startedAt: after(from),
  endedAt: after(from + took),
});

/** The layout page's mid-sweep frame: nine of twelve settled, one failed on sign-in. */
export function midSweep(overrides: Partial<SweepProgress> = {}): SweepProgress {
  return SweepProgressSchema.parse({
    sweep: "sweep-1",
    startedAt: after(0),
    first: true,
    usualMs: null,
    outcome: "running",
    nextAttemptAt: null,
    sources: [
      read("auth", 0, 3),
      read("fleet", 3, 9),
      read("github", 12, 31),
      {
        source: "runs",
        state: "cut",
        startedAt: after(43),
        endedAt: after(95),
        code: "limit",
        reason: "Some runs could not be read.",
        incomplete: { count: 6, total: 13 },
      },
      read("approvals", 95, 4),
      read("lifecycle", 99, 12),
      read("template", 111, 6),
      {
        source: "details",
        state: "deferred",
        startedAt: after(117),
        endedAt: after(117),
        code: "budget",
        reason: "GitHub budget is low.",
        resumeAt: "2026-11-09T09:10:00Z",
      },
      {
        source: "upstream",
        state: "failed",
        startedAt: after(117),
        endedAt: after(118),
        code: "signin",
        reason: "glab is not signed in to community.opengroup.org.",
      },
      { source: "radar", state: "reading", startedAt: after(116) },
      { source: "security", state: "waiting" },
      { source: "releases", state: "waiting" },
    ],
    ...overrides,
  });
}
