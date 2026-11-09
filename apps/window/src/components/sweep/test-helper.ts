// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  PROTOCOL_VERSION,
  type SweepProgress,
  SweepProgressSchema,
  type SweepStatus,
} from "@spi-code/contracts";

export const SWEEP_START = Date.parse("2026-11-09T08:00:00Z");

/** An instant `seconds` after the sweep started. */
export const after = (seconds: number) => new Date(SWEEP_START + seconds * 1000).toISOString();

export const sweepEvent = (type: string, payload: unknown, id = "host") => ({
  version: PROTOCOL_VERSION,
  id,
  kind: "event",
  type,
  payload,
});

export function sweepStatus(overrides: Partial<SweepStatus> = {}): SweepStatus {
  return {
    remaining: 4865,
    resetAt: after(3600),
    deferredAreas: [],
    nextSweepAt: after(430),
    schedule: {
      sweepMs: 300_000,
      gitlabMs: 1_800_000,
      securityMs: 1_800_000,
      releasesMs: 3_600_000,
    },
    lastSweep: null,
    forceCooldownUntil: null,
    ...overrides,
  };
}

export function savedSweep(): SweepProgress {
  return midSweep({
    first: false,
    outcome: "committed",
    sources: midSweep().sources.map(({ source }) => ({
      source,
      state: "read",
      startedAt: after(0),
      endedAt: after(120),
    })),
  });
}

const read = (source: string, from: number, took: number) => ({
  source,
  state: "read" as const,
  startedAt: after(from),
  endedAt: after(from + took),
});

/** The layout page's mid-sweep frame: nine of twelve settled, one partly failed, one failed on sign-in. */
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
        reason: "Run list page limit or short read: 60 of 100 runs read.",
        cutKind: "run-list",
        incomplete: { count: 6, total: 13 },
      },
      read("approvals", 95, 4),
      read("lifecycle", 99, 12),
      {
        source: "template",
        state: "cut",
        startedAt: after(111),
        endedAt: after(117),
        incomplete: { count: 0, total: 24, failed: 2 },
        failure: "Reads failed for 2 services: unit, crs-catalog.",
      },
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
