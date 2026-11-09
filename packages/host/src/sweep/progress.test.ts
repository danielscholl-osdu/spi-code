// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

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
import { foldSweepProgress, SweepProgressFeed, safeSweepReason } from "./progress.js";

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

it("limits sends to four a second and always sends the last terminal state", async () => {
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
  await vi.advanceTimersByTimeAsync(250);
  for (let index = 1; index < sends.length; index++) {
    expect((sends[index]?.at ?? 0) - (sends[index - 1]?.at ?? 0)).toBeGreaterThanOrEqual(250);
  }
  expect(sends.at(-1)?.outcome).toBe("failed");
  expect(sends.filter(({ at }) => at < epoch + 1000)).toHaveLength(4);
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
