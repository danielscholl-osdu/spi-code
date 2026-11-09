// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type SweepProgress, SweepProgressSchema } from "@spi-code/contracts";

export function smokeSweepProgress() {
  const start = Date.parse("2026-11-06T15:02:00.000Z");
  const after = (seconds: number) => new Date(start + seconds * 1000).toISOString();
  const read = (source: string, from: number, took: number) => ({
    source,
    state: "read" as const,
    startedAt: after(from),
    endedAt: after(from + took),
  });
  const running = SweepProgressSchema.parse({
    sweep: "smoke-first-sweep",
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
        resumeAt: "2026-11-06T15:10:00.000Z",
      },
      {
        source: "upstream",
        state: "failed",
        startedAt: after(117),
        endedAt: after(118),
        code: "signin",
        reason: "glab is not signed in to community.opengroup.org.",
      },
      { source: "radar", state: "reading", startedAt: after(118) },
      { source: "security", state: "waiting" },
      { source: "releases", state: "waiting" },
    ],
  });
  const committed = SweepProgressSchema.parse({
    ...running,
    outcome: "committed",
    sources: running.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? read(source.source, 118, 2)
        : source,
    ),
  });
  const stopped = SweepProgressSchema.parse({
    ...running,
    outcome: "failed",
    code: "timeout",
    failure: "GitHub did not answer in time.",
    source: "runs",
    nextAttemptAt: "2026-11-06T15:07:00.000Z",
    sources: running.sources.map((source, index) =>
      index < 3
        ? source
        : index === 3
          ? { source: source.source, state: "reading", startedAt: after(43) }
          : { source: source.source, state: "waiting" },
    ),
  });
  return {
    running,
    committed,
    stopped,
    stoppedSaving: SweepProgressSchema.parse({
      ...committed,
      outcome: "failed",
      code: "save",
      failure: "The disk is full.",
      nextAttemptAt: null,
    }),
    throttled: SweepProgressSchema.parse({
      ...running,
      sources: running.sources.map((source) =>
        source.source === "radar"
          ? { source: "radar", state: "waiting" }
          : source.source === "security"
            ? {
                source: "security",
                state: "throttled",
                startedAt: after(118),
                code: "throttled",
                reason: "GitHub asked SPI Code to slow down.",
                resumeAt: "2026-11-06T15:10:00.000Z",
              }
            : source,
      ),
    }),
    refresh: SweepProgressSchema.parse({
      ...running,
      sweep: "smoke-refresh",
      first: false,
      startedAt: after(80),
      sources: running.sources.map((source, index) =>
        index < 4
          ? read(source.source, 80 + index * 9, 9)
          : index === 4
            ? { source: source.source, state: "reading", startedAt: after(116) }
            : { source: source.source, state: "waiting" },
      ),
    }),
  } satisfies Record<string, SweepProgress>;
}
