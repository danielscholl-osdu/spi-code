// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import {
  type SweepProgress,
  SweepProgressSchema,
  SweepReasonCodeSchema,
} from "@spi-code/contracts";
import { cacheSchema, createContext, emptyCache, type Facts } from "@spi-code/core";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ForgeError } from "../../../core/src/forge.js";
import { Sweeper, sweepReadProgress } from "../../../core/src/sweep/sweeper.js";
import {
  failedReadsReason,
  foldSweepProgress,
  SweepProgressFeed,
  safeSweepReason,
} from "./progress.js";

const epoch = Date.parse("2026-01-01T00:00:00Z");
const timers = {
  after(ms: number, callback: () => void) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};
const sensitive = "gh auth login stderr: token ghp_NOT_A_REAL_TOKEN_1234567890 code ABCD-1234";

afterEach(() => vi.useRealTimers());

it("folds every real core fake-sweep boundary through the strict contract", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  const feed = new SweepProgressFeed({
    timers,
    now: Date.now,
    onError: (error) => {
      throw error;
    },
  });
  feed.begin(true, null);
  const states: SweepProgress[] = [];
  const sweeper = new Sweeper({
    ctx: createContext({ clock: { now: () => new Date(Date.now()) } }),
    exec: {
      runJSON: async () => ({ ok: false, error: "offline", code: 1 }),
      runText: async () => ({ ok: true, data: "" }),
    },
    factsSchema: z.custom<Facts>(),
    cacheSchema,
    emptyCache,
    persist: { load: async () => undefined, save: async () => {} },
    progress: (event) => {
      if (!feed.latest) throw new Error("Missing sweep progress");
      states.push(SweepProgressSchema.parse(foldSweepProgress(feed.latest, event)));
      feed.report(event);
    },
    areas: [
      {
        name: "auth",
        read: async () => ({
          data: { gh: { ok: false, detail: sensitive }, glab: { ok: true, detail: "" } },
          code: "signin",
          reason: sensitive,
          reads: [
            {
              source: "gh",
              object: "auth",
              observedAt: new Date(epoch).toISOString(),
              completeness: { kind: "complete" },
              failure: sensitive,
            },
          ],
        }),
      },
      {
        name: "github",
        read: async ({ clock }) => ({
          data: { repos: {}, planned: {} },
          reads: [1, 2, 3].map((index) => ({
            source: "gh",
            object: `repo-${index}`,
            observedAt: clock.now().toISOString(),
            completeness:
              index < 3
                ? { kind: "cut" as const, reason: sensitive, read: 1, total: 10 }
                : { kind: "complete" as const },
          })),
        }),
      },
      {
        name: "details",
        shouldRead: () => ({
          state: "deferred",
          code: "budget",
          reason: sensitive,
          resumeAt: new Date(epoch + 3600_000).toISOString(),
        }),
        read: async () => {
          throw new Error("Not due");
        },
      },
      {
        name: "upstream",
        shouldRead: () => false,
        read: async () => {
          throw new Error("Not due");
        },
      },
      {
        name: "radar",
        shouldRead: () => ({
          state: "throttled",
          code: "throttled",
          reason: sensitive,
          resumeAt: new Date(epoch + 60_000).toISOString(),
        }),
        read: async () => {
          throw new Error("Not due");
        },
      },
      {
        name: "security",
        read: async () => {
          throw new ForgeError(sensitive, null, "throttle", new Date(epoch + 60_000).toISOString());
        },
      },
      {
        name: "fleet",
        read: async () => {
          throw new ForgeError(sensitive, 503, "gateway");
        },
      },
    ],
    afterAreas: async ({ progress, clock }) => {
      progress?.({
        kind: "source",
        source: "releases",
        state: "reading",
        startedAt: clock.now().toISOString(),
      });
      progress?.({
        kind: "throttle",
        source: "releases",
        code: "throttled",
        reason: sensitive,
        resumeAt: new Date(epoch + 60_000).toISOString(),
      });
      progress?.(sweepReadProgress("releases", [], clock.now().toISOString()));
    },
  });
  await sweeper.sweep();
  expect(states).toHaveLength(14);
  expect(feed.latest?.sources.map(({ source }) => source)).toEqual([
    "auth",
    "fleet",
    "github",
    "runs",
    "approvals",
    "lifecycle",
    "template",
    "details",
    "upstream",
    "radar",
    "security",
    "releases",
  ]);
  expect(feed.latest?.sources.find(({ source }) => source === "github")).toMatchObject({
    state: "cut",
    incomplete: { count: 2, total: 3 },
  });
  expect(feed.latest?.sources.find(({ source }) => source === "auth")).toMatchObject({
    state: "failed",
    code: "signin",
    reason: safeSweepReason("signin"),
  });
  for (const state of states) {
    const text = JSON.stringify(state);
    expect(text).not.toMatch(/ghp_|ABCD-1234|stderr|completeness/);
  }
});

it("limits running updates to four a second and sends terminal states immediately", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  const sends: { at: number; outcome: string }[] = [];
  const feed = new SweepProgressFeed({
    timers,
    now: Date.now,
    onError: vi.fn(),
    send: ({ outcome }) => sends.push({ at: Date.now(), outcome }),
  });
  feed.begin(true, null);
  for (let index = 0; index < 100; index++) {
    feed.report({
      kind: "source",
      source: "auth",
      state: "reading",
      startedAt: new Date(Date.now()).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(10);
  }
  feed.finish("failed", new Date(epoch + 300_000).toISOString(), "timeout");
  expect(sends.at(-1)).toEqual({ at: epoch + 1000, outcome: "failed" });
  await vi.advanceTimersByTimeAsync(250);
  const running = sends.filter(({ outcome }) => outcome === "running");
  for (let index = 1; index < running.length; index++) {
    expect((running[index]?.at ?? 0) - (running[index - 1]?.at ?? 0)).toBeGreaterThanOrEqual(250);
  }
  expect(sends.at(-1)?.outcome).toBe("failed");
  expect(sends.filter(({ at }) => at < epoch + 1000)).toHaveLength(4);
});

it.each([
  {
    source: "lifecycle" as const,
    reason: "Job log character limit",
    count: 1,
    total: 69,
    read: 64_000,
    size: 92_438,
    cutKind: "job-log",
    safeReason: "Job log character limit: 64,000 of 92,438 characters read.",
  },
  {
    source: "radar" as const,
    reason: "GitLab omitted oversized or collapsed classification hunks",
    count: 2,
    total: 10,
    read: 75,
    size: 79,
    cutKind: "diff",
    safeReason: "Oversized or collapsed diffs: 150 of 158 files read.",
  },
])("carries the kind and safe read limits for $source cuts", (example) => {
  const feed = new SweepProgressFeed({ timers, now: () => epoch, onError: vi.fn() });
  feed.begin(true, null);
  feed.report(
    sweepReadProgress(
      example.source,
      Array.from({ length: example.total }, (_, index) => ({
        source: sensitive,
        object: `read-${index}`,
        observedAt: new Date(epoch).toISOString(),
        completeness:
          index < example.count
            ? {
                kind: "cut" as const,
                reason: example.reason,
                read: example.read,
                total: example.size,
              }
            : { kind: "complete" as const },
      })),
      new Date(epoch).toISOString(),
    ),
  );
  expect(feed.latest?.sources.find(({ source }) => source === example.source)).toMatchObject({
    state: "cut",
    cutKind: example.cutKind,
    incomplete: { count: example.count, total: example.total },
    reason: example.safeReason,
  });
  expect(JSON.stringify(feed.latest)).not.toMatch(/ghp_|ABCD-1234|stderr/);
});

it.each([
  "Run jobs page limit or short read",
  "repos/example/fork/actions/runs: run read cut; Run jobs page limit or short read",
  "Run jobs page limit or short read; repos/example/fork/actions/runs: run read cut",
])("does not label a jobs-page cut as a run list: %s", (reason) => {
  const feed = new SweepProgressFeed({ timers, now: () => epoch, onError: vi.fn() });
  feed.begin(true, null);
  const report = (cutReason: string) =>
    feed.report(
      sweepReadProgress(
        "runs",
        [
          {
            source: "example/fork",
            object: "runs",
            observedAt: new Date(epoch).toISOString(),
            completeness: { kind: "cut", reason: cutReason, read: 30, total: 45 },
          },
          {
            source: "example/fork",
            object: "fork-runs",
            observedAt: new Date(epoch).toISOString(),
            completeness: { kind: "complete" },
          },
        ],
        new Date(epoch).toISOString(),
      ),
    );
  report(reason);
  expect(feed.latest?.sources.find(({ source }) => source === "runs")).toMatchObject({
    cutKind: "read",
    incomplete: { count: 1, total: 2 },
    reason: safeSweepReason("limit"),
  });
  report(
    "repos/example/fork/actions/workflows/main/runs: run read cut; repos/example/fork/actions/workflows/cascade/runs: run read cut",
  );
  expect(feed.latest?.sources.find(({ source }) => source === "runs")).toMatchObject({
    cutKind: "run-list",
    incomplete: { count: 1, total: 2 },
    reason: "Run list page limit or short read: 30 of 45 runs read.",
  });
});

it("omits mixed-unit totals when job-log and jobs-page reads are cut", () => {
  const feed = new SweepProgressFeed({ timers, now: () => epoch, onError: vi.fn() });
  feed.begin(true, null);
  feed.report(
    sweepReadProgress(
      "lifecycle",
      [
        {
          source: "example/stack",
          object: "job-log",
          observedAt: new Date(epoch).toISOString(),
          completeness: {
            kind: "cut",
            reason: "Job log character limit",
            read: 64_000,
            total: 92_438,
          },
        },
        {
          source: "example/stack",
          object: "jobs",
          observedAt: new Date(epoch).toISOString(),
          completeness: {
            kind: "cut",
            reason: "Run jobs page limit or short read",
            read: 30,
            total: 45,
          },
        },
        {
          source: "example/stack",
          object: "runs",
          observedAt: new Date(epoch).toISOString(),
          completeness: { kind: "complete" },
        },
      ],
      new Date(epoch).toISOString(),
    ),
  );
  const source = feed.latest?.sources.find(({ source }) => source === "lifecycle");
  expect(source).toMatchObject({
    cutKind: "read",
    incomplete: { count: 2, total: 3 },
    reason: safeSweepReason("limit"),
  });
  expect(JSON.stringify(source)).not.toMatch(/64,030|92,483/);
});

it.each(["failed", "committed", "cancelled"] as const)(
  "sends %s synchronously before a new sweep begins",
  async (outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(epoch);
    const sends: SweepProgress[] = [];
    const feed = new SweepProgressFeed({
      timers,
      now: Date.now,
      onError: vi.fn(),
      send: (progress) => sends.push(progress),
    });
    feed.begin(true, null);
    const previous = feed.latest?.sweep;
    feed.report({
      kind: "source",
      source: "auth",
      state: "reading",
      startedAt: new Date(epoch).toISOString(),
    });
    feed.finish(outcome, outcome === "failed" ? new Date(epoch + 300_000).toISOString() : null);
    feed.begin(true, null);
    expect(sends.map(({ outcome }) => outcome)).toEqual(["running", outcome, "running"]);
    expect(sends[1]?.sweep).toBe(previous);
    expect(sends[2]?.sweep).not.toBe(previous);
    await vi.advanceTimersByTimeAsync(250);
    expect(sends).toHaveLength(3);
  },
);

it("normalizes unknown source reason codes in the fold and report", () => {
  const onError = vi.fn();
  const feed = new SweepProgressFeed({ timers, now: () => epoch, onError });
  feed.begin(true, null);
  const event = {
    kind: "source" as const,
    source: "auth" as const,
    state: "failed" as const,
    endedAt: new Date(epoch).toISOString(),
    code: "other" as const,
    reason: sensitive,
  };
  Reflect.set(event, "code", sensitive);
  if (!feed.latest) throw new Error("Missing sweep progress");
  const folded = SweepProgressSchema.parse(foldSweepProgress(feed.latest, event));
  expect(folded.sources[0]).toMatchObject({
    state: "failed",
    code: "other",
    reason: safeSweepReason("other"),
  });
  feed.report(event);
  expect(feed.latest?.sources[0]).toEqual(folded.sources[0]);
  expect(onError).not.toHaveBeenCalled();
});

it("normalizes unknown terminal report and finish codes instead of dropping the failure", () => {
  const onError = vi.fn();
  const send = vi.fn();
  const feed = new SweepProgressFeed({ timers, now: () => epoch, onError, send });
  const event = {
    kind: "failed" as const,
    endedAt: new Date(epoch).toISOString(),
    code: "other" as const,
    reason: sensitive,
  };
  Reflect.set(event, "code", sensitive);
  feed.begin(true, null);
  feed.report(event);
  feed.finish("failed", null);
  expect(SweepProgressSchema.parse(feed.latest)).toMatchObject({
    outcome: "failed",
    code: "other",
    failure: safeSweepReason("other"),
  });
  feed.begin(true, null);
  feed.finish("failed", null, sensitive);
  expect(SweepProgressSchema.parse(feed.latest)).toMatchObject({
    outcome: "failed",
    code: "other",
    failure: safeSweepReason("other"),
  });
  expect(send.mock.calls.map(([progress]) => progress.outcome)).toEqual([
    "running",
    "failed",
    "running",
    "failed",
  ]);
  expect(onError).not.toHaveBeenCalled();
});

it.each(["read", "cut", "deferred", "skipped", "failed"] as const)(
  "names no failure source after its %s outcome",
  (state) => {
    const feed = new SweepProgressFeed({ timers, now: () => epoch, onError: vi.fn() });
    feed.begin(true, null);
    feed.report({
      kind: "source",
      source: "auth",
      state: "reading",
      startedAt: new Date(epoch).toISOString(),
    });
    feed.report({
      kind: "source",
      source: "auth",
      state,
      endedAt: new Date(epoch).toISOString(),
      code: "other",
      reason: sensitive,
      incomplete: { count: 1, total: 1 },
      resumeAt: new Date(epoch + 1000).toISOString(),
    });
    feed.finish("failed", null);
    expect(SweepProgressSchema.parse(feed.latest)).not.toHaveProperty("source");
  },
);

it("names a failure source only while it is reading", () => {
  const feed = new SweepProgressFeed({ timers, now: () => epoch, onError: vi.fn() });
  feed.begin(true, null);
  feed.report({
    kind: "source",
    source: "auth",
    state: "reading",
    startedAt: new Date(epoch).toISOString(),
  });
  feed.finish("failed", null);
  expect(SweepProgressSchema.parse(feed.latest)).toHaveProperty("source", "auth");
});

it("drops and logs invalid reports without disturbing the sweep or leaking their values", () => {
  const onError = vi.fn();
  const send = vi.fn();
  const feed = new SweepProgressFeed({ timers, now: () => epoch, onError, send });
  feed.begin(true, null);
  const before = feed.latest;
  feed.report({ kind: "source", source: "auth", state: "reading", startedAt: sensitive });
  feed.report({
    kind: "source",
    source: "github",
    state: "cut",
    endedAt: new Date(epoch).toISOString(),
    incomplete: { count: 4, total: 3 },
  });
  feed.report({
    kind: "source",
    source: "radar",
    state: "throttled",
    endedAt: new Date(epoch).toISOString(),
  });
  expect(feed.latest).toBe(before);
  expect(send).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledTimes(3);
  expect(onError.mock.calls.map(([error]) => String(error)).join(" ")).not.toContain(sensitive);
});

it("maps every closed reason code to a fixed bounded phrase", () => {
  for (const code of SweepReasonCodeSchema.options) {
    expect(safeSweepReason(code).length).toBeGreaterThan(0);
    expect(safeSweepReason(code).length).toBeLessThanOrEqual(200);
  }
});

const recordedRadar = z
  .object({
    recordedAt: z.iso.datetime(),
    reads: z.array(
      z.object({
        source: z.string(),
        object: z.string(),
        completeness: z.union([
          z.object({ kind: z.literal("complete") }),
          z.object({
            kind: z.literal("cut"),
            reason: z.string(),
            read: z.number(),
            total: z.number(),
          }),
        ]),
        failure: z.string().optional(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL("./fixtures/radar-partial-sweep.json", import.meta.url), "utf8"),
    ),
  );

async function sweepRadar(reads: typeof recordedRadar.reads, code?: "unavailable") {
  const at = recordedRadar.recordedAt;
  const feed = new SweepProgressFeed({ timers, now: () => Date.parse(at), onError: vi.fn() });
  feed.begin(true, null);
  await new Sweeper({
    ctx: createContext({ clock: { now: () => new Date(at) } }),
    exec: {
      runJSON: async <T>() => ({ ok: true, data: {} as T }),
      runText: async () => ({ ok: true, data: "" }),
    },
    factsSchema: z.custom<Facts>(),
    cacheSchema,
    emptyCache,
    persist: { load: async () => undefined, save: async () => {} },
    progress: (event) => feed.report(event),
    areas: [
      {
        name: "radar",
        read: async () => ({
          data: { filters: {}, services: {} } as unknown as NonNullable<Facts["radar"]["data"]>,
          ...(code === undefined ? {} : { code }),
          reads: reads.map(({ failure, ...read }) => ({
            ...read,
            ...(failure === undefined ? {} : { failure }),
            observedAt: at,
          })),
        }),
      },
    ],
  }).sweep({ force: true });
  return feed.latest?.sources.find(({ source }) => source === "radar");
}

it("replays the recorded radar outcome as a partial read naming the services that failed", async () => {
  const cut = recordedRadar.reads.filter((read) => read.completeness.kind === "cut");
  expect(recordedRadar.reads.filter((read) => read.failure)).toHaveLength(3);
  const radar = await sweepRadar(recordedRadar.reads);
  expect(radar).toMatchObject({
    state: "cut",
    cutKind: "diff",
    code: "limit",
    incomplete: { count: cut.length, total: recordedRadar.reads.length, failed: 3 },
    reason: "Oversized or collapsed diffs: 1,607 of 1,696 files read.",
    failure: "Reads failed for 3 services: unit, crs-catalog, crs-conversion.",
  });
  expect(JSON.stringify(radar)).not.toMatch(/pom\.xml|not readable|Azure\//);
});

it("names failed reads without cut reads, and stays failed with its code when nothing read", async () => {
  const complete = recordedRadar.reads.map(({ completeness: _, ...read }) => ({
    ...read,
    completeness: { kind: "complete" as const },
  }));
  const partial = await sweepRadar(complete);
  expect(partial).toEqual(
    expect.objectContaining({
      state: "cut",
      incomplete: { count: 0, total: complete.length, failed: 3 },
      failure: "Reads failed for 3 services: unit, crs-catalog, crs-conversion.",
    }),
  );
  expect(partial).not.toHaveProperty("cutKind");
  expect(partial).not.toHaveProperty("code");
  const failed = recordedRadar.reads
    .filter((read) => read.failure)
    .map(({ completeness: _, ...read }) => ({
      ...read,
      completeness: { kind: "complete" as const },
    }));
  expect(await sweepRadar(failed, "unavailable")).toMatchObject({
    state: "failed",
    code: "unavailable",
    reason: safeSweepReason("unavailable"),
  });
  expect(await sweepRadar(failed)).toMatchObject({ state: "failed", code: "other" });
});

it("names failed services only from safe fleet ids", () => {
  expect(failedReadsReason({ count: 1, services: ["unit"] })).toBe(
    "Reads failed for 1 service: unit.",
  );
  expect(failedReadsReason({ count: 2, services: [] })).toBeUndefined();
  expect(failedReadsReason({ count: 1, services: [sensitive] })).toBeUndefined();
  const many = Array.from({ length: 30 }, (_, index) => `service-name-${index}`);
  const capped = failedReadsReason({ count: 30, services: many });
  expect(capped).toMatch(/^Reads failed for 30 services: service-name-0, .* and \d+ more\.$/);
  expect(capped?.length).toBeLessThanOrEqual(200);
});
