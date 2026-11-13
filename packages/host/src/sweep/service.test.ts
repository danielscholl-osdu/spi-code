// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { type SweepProgress, SweepProgressSchema } from "@spi-code/contracts";
import {
  BudgetPacer,
  cacheSchema,
  createContext,
  createSweeper,
  type Exec,
  emptyCache,
  emptyFacts,
  type Facts,
  fleetOf,
  INFLIGHT_POLL_MS,
  LEAD_TIME_MS,
  SWEEP_MS,
  type SweepArea,
  type SweepInput,
} from "@spi-code/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ForgeError } from "../../../core/src/forge.js";
import { Sweeper } from "../../../core/src/sweep/sweeper.js";
import { fixtureInput } from "../../test/watch/snapshot-fixture.js";
import { createLeaseStore } from "../store/leases.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { openRunStore } from "../store/store.js";
import * as project from "../watch/project.js";
import { DAY_MS, FORCE_COOLDOWN_MS, SweepService, type SweepServiceOptions } from "./service.js";
import type { SweepSchedulerStatus } from "./status.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
    linkSync: vi.fn(actual.linkSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
let directory: string;
let db: DatabaseSync;
let path: string;
const services: SweepService[] = [];
const epoch = Date.parse("2026-01-01T00:00:00Z");
const factsSchema = z.custom<Facts>();
const auth = { gh: { ok: true, detail: "signed in" }, glab: { ok: true, detail: "signed in" } };
const exec: Exec = {
  runText: async () => ({ ok: true, data: "" }),
  runJSON: async <T>() => ({ ok: true, data: {} as T }),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  directory = mkdtempSync(join(tmpdir(), "spi-sweep-"));
  path = join(directory, "store.sqlite");
  openRunStore(path).close();
  db = new DatabaseSync(path);
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  db.close();
  for (const fn of [openSync, writeFileSync, fsyncSync, closeSync, linkSync, renameSync]) {
    vi.mocked(fn).mockReset();
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

function service(
  areas: readonly SweepArea<ReturnType<typeof emptyCache>>[] = [],
  overrides: Partial<SweepServiceOptions> = {},
) {
  const instance = new SweepService({
    db,
    fleet: "test",
    ctx: createContext({ clock: { now: () => new Date(Date.now()) } }),
    exec,
    factsSchema,
    appData: directory,
    doctor: () => ({ state: "clear", problems: [] }),
    ttlMs: 3000,
    onError: (error) => {
      throw error;
    },
    createSweeper: (options) =>
      new Sweeper({
        ...options,
        areas,
        cacheSchema,
        emptyCache,
      }),
    ...overrides,
  });
  services.push(instance);
  return instance;
}

function budgets() {
  return readFileSync(join(directory, "sweep-budget.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function traceBudgetIO(beforeSync: (file: string | undefined) => void = () => {}) {
  const files = new Map<number, string>();
  const events: string[] = [];
  vi.mocked(openSync).mockImplementation((file, flags, mode) => {
    const fd = realFs.openSync(file === directory ? path : file, flags, mode);
    files.set(fd, String(file));
    return fd;
  });
  vi.mocked(writeFileSync).mockImplementation((file, contents, options) => {
    events.push(`write:${typeof file === "number" ? files.get(file) : file}`);
    realFs.writeFileSync(file, contents, options);
  });
  vi.mocked(fsyncSync).mockImplementation((fd) => {
    const file = files.get(fd);
    events.push(`fsync:${file}`);
    beforeSync(file);
    if (file !== directory) realFs.fsyncSync(fd);
  });
  vi.mocked(closeSync).mockImplementation((fd) => {
    events.push(`close:${files.get(fd)}`);
    files.delete(fd);
    realFs.closeSync(fd);
  });
  vi.mocked(renameSync).mockImplementation((from, to) => {
    events.push(`rename:${from}`);
    realFs.renameSync(from, to);
  });
  vi.mocked(linkSync).mockImplementation((from, to) => {
    events.push(`link:${from}`);
    realFs.linkSync(from, to);
  });
  return events;
}

it("renews at ttl/3, excludes a second service and schedules full sweeps at SWEEP_MS", async () => {
  const read = vi.fn(async () => ({ data: auth, reads: [] }));
  const { timers, fire } = controlledTimers();
  const after = vi.spyOn(timers, "after");
  const first = service([{ name: "auth", read }], { timers });
  const second = service([{ name: "auth", read }]);
  expect(await first.start()).toBe(true);
  expect(await second.start()).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  vi.setSystemTime(epoch + 1000);
  await fire(1000);
  expect(after).toHaveBeenCalledWith(1000, expect.any(Function));
  expect(db.prepare("SELECT expires_at FROM leases").get()?.expires_at).toBe(epoch + 4000);
  expect(after).toHaveBeenCalledWith(SWEEP_MS, expect.any(Function));
  await fire(SWEEP_MS);
  expect(read).toHaveBeenCalledTimes(2);
  expect(first.latest()?.cursor).toBe(2);
  expect(budgets()).toHaveLength(2);
  await first.stop();
  expect(await second.sweep()).toBe(true);
  expect(second.latest()?.cursor).toBe(3);
});

it("sends no progress while another host holds the fleet lease", async () => {
  const first = service();
  await first.start();
  const onProgress = vi.fn();
  const onError = vi.fn();
  const second = service([], { onProgress, onError });
  await expect(second.start()).resolves.toBe(false);
  expect(second.progress).toBeUndefined();
  expect(onProgress).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it("aborts an in-progress Exec when renewal runs after expiry and refuses its stale write", async () => {
  let signal: AbortSignal | undefined;
  const blocked: Exec = {
    ...exec,
    runText: (_cmd, _args, options) =>
      new Promise((resolve) => {
        signal = options?.signal;
        signal?.addEventListener("abort", () =>
          resolve({ ok: false, code: null, error: "aborted" }),
        );
      }),
  };
  const read = vi.fn(async (input: SweepInput<ReturnType<typeof emptyCache>>) => {
    await input.exec.runText("gh", []);
    return { data: auth, reads: [] };
  });
  const onError = vi.fn();
  const first = service([{ name: "auth", read }], { exec: blocked, onError });
  const running = first.start();
  const rejected = expect(running).rejects.toThrow("Lease lost");
  await vi.advanceTimersByTimeAsync(0);
  expect(signal?.aborted).toBe(false);
  vi.setSystemTime(epoch + 3000);
  expect(() =>
    createSnapshotStore(db).writeSnapshot(
      { fleet: "test", owner: first.owner, fence: 1 },
      {},
      {},
      Date.now(),
    ),
  ).toThrow("Stale lease");
  await vi.advanceTimersByTimeAsync(1000);
  await rejected;
  expect(SweepProgressSchema.parse(first.progress)).toMatchObject({
    outcome: "failed",
    code: "other",
    source: "auth",
    failure: "SPI Code could not complete the read.",
    nextAttemptAt: new Date(epoch + SWEEP_MS).toISOString(),
  });
  expect(signal?.aborted).toBe(true);
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Lease lost: sweep aborted" }),
  );
  expect(first.latest()).toBeUndefined();
  expect(budgets()).toHaveLength(1);
  expect(createLeaseStore(db).acquire("test", "replacement", 3000, Date.now())).toBe(2);
});

it("rejects a late save even before the delayed renewal timer runs", async () => {
  let finish: (() => void) | undefined;
  const first = service([
    {
      name: "auth",
      read: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { data: auth, reads: [] };
      },
    },
  ]);
  const running = first.start();
  const rejected = expect(running).rejects.toThrow("Lease lost");
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(epoch + 3000);
  finish?.();
  await rejected;
  expect(first.latest()).toBeUndefined();
  expect(budgets()).toHaveLength(1);
});

it("logs every budget field once per sweep and persists a validated projection with its cursor", async () => {
  const first = service([], {
    createSweeper: (options) =>
      new Sweeper({
        ...options,
        areas: [],
        cacheSchema,
        emptyCache,
        afterAreas: async ({ cache }) => {
          cache.budget = {
            cost: 2,
            remaining: 90,
            resetAt: new Date(epoch + 3600_000).toISOString(),
            deferred: [{ area: "security", reason: "floor" }],
            calls: 1,
          };
        },
      }),
  });
  await first.start();
  expect(budgets()).toEqual([
    {
      fleet: "test",
      cursor: 1,
      startedAt: new Date(epoch).toISOString(),
      endedAt: new Date(epoch).toISOString(),
      cost: 2,
      remaining: 90,
      resetAt: new Date(epoch + 3600_000).toISOString(),
      deferred: [{ area: "security", reason: "floor" }],
      calls: 1,
    },
  ]);
  const snapshot = first.latest();
  expect(snapshot?.cursor).toBe(1);
  expect(snapshot?.briefing).toBeDefined();
  expect(snapshot?.areas).toBeDefined();
  expect(createSnapshotStore(db).latestSnapshot("test")?.fence).toBe(1);
});

it("ends throwing sweeps safely and retries at the published timer, not the budget reset", async () => {
  const failure = new ForgeError(
    "gh stderr: ghp_NOT_A_REAL_TOKEN_1234567890 device code ABCD-1234",
    503,
    "gateway",
  );
  const sends: SweepProgress[] = [];
  let attempts = 0;
  const first = service([], {
    intervalMs: 1000,
    onError: vi.fn(),
    onProgress: (progress) => sends.push(progress),
    createSweeper: (options) =>
      new Sweeper({
        ...options,
        areas: [],
        cacheSchema,
        emptyCache,
        afterAreas: async ({ progress, clock, cache }) => {
          attempts++;
          cache.budget.resetAt = new Date(epoch + 3600_000).toISOString();
          progress?.({
            kind: "source",
            source: "releases",
            state: "reading",
            startedAt: clock.now().toISOString(),
          });
          if (attempts < 3) throw failure;
          progress?.({
            kind: "source",
            source: "releases",
            state: "read",
            endedAt: clock.now().toISOString(),
          });
        },
      }),
  });
  await expect(first.start()).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(250);
  expect(sends.at(-1)).toMatchObject({
    outcome: "failed",
    code: "unavailable",
    source: "releases",
    failure: "The source is unavailable.",
    nextAttemptAt: new Date(epoch + 1000).toISOString(),
  });
  expect(JSON.stringify(sends)).not.toMatch(/ghp_|ABCD-1234|stderr/);
  expect(budgets()[0]?.resetAt).not.toBe(first.progress?.nextAttemptAt);
  await vi.advanceTimersByTimeAsync(750);
  expect(attempts).toBe(2);
  expect(first.progress).toMatchObject({
    outcome: "failed",
    nextAttemptAt: new Date(epoch + 2000).toISOString(),
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(attempts).toBe(3);
  expect(first.progress).toMatchObject({ outcome: "committed", nextAttemptAt: null });
  expect(first.latest()?.cursor).toBe(1);
});

it("a failed snapshot transaction ends failed/save with no source and no persisted progress", async () => {
  db.exec(`CREATE TEMP TRIGGER reject_snapshot BEFORE INSERT ON facts_snapshots
    BEGIN SELECT RAISE(ABORT, 'fixture commit failed ghp_NOT_A_REAL_TOKEN ABCD-1234'); END`);
  const sends: SweepProgress[] = [];
  const first = service([{ name: "auth", read: async () => ({ data: auth, reads: [] }) }], {
    onError: vi.fn(),
    onProgress: (progress) => sends.push(progress),
  });
  await expect(first.start()).rejects.toThrow("fixture commit failed");
  await vi.advanceTimersByTimeAsync(250);
  expect(SweepProgressSchema.parse(sends.at(-1))).toMatchObject({
    outcome: "failed",
    code: "save",
    failure: "SPI Code could not save the sweep.",
    nextAttemptAt: new Date(epoch + SWEEP_MS).toISOString(),
  });
  expect(first.progress).not.toHaveProperty("source");
  expect(JSON.stringify(sends)).not.toMatch(/ghp_|ABCD-1234|fixture commit/);
  expect(first.latest()).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS count FROM facts_snapshots").get()?.count).toBe(0);
  expect(JSON.stringify(budgets())).not.toMatch(
    /sources|usualMs|nextAttemptAt|outcome|sweep.progress/,
  );
  db.exec("DROP TRIGGER reject_snapshot");
  await vi.advanceTimersByTimeAsync(SWEEP_MS - 250);
  const record = createSnapshotStore(db).latestSnapshot("test");
  expect(JSON.stringify(record)).not.toMatch(/sources|usualMs|nextAttemptAt|sweep.progress/);
  expect(first.latest()?.cursor).toBe(1);
});

it("takes first and usual duration from the fleet's persisted snapshot, with a fresh id on restart", async () => {
  const read = async () => {
    vi.setSystemTime(Date.now() + 100);
    return { data: auth, reads: [] };
  };
  const first = service([{ name: "auth", read }]);
  await first.start();
  expect(first.progress).toMatchObject({ first: true, usualMs: null });
  const sweep = first.progress?.sweep;
  await first.stop();
  const next = service([{ name: "auth", read }]);
  await next.start();
  expect(next.progress).toMatchObject({ first: false, usualMs: 100 });
  expect(next.progress?.sweep).not.toBe(sweep);
  const other = service([], { fleet: "other" });
  await other.start();
  expect(other.progress).toMatchObject({ first: true, usualMs: null });
});

it("logs the real collector's per-sweep GraphQL charges rather than accumulating prior sweeps", async () => {
  let calls = 0;
  const resetAt = new Date(epoch + 3600_000).toISOString();
  const first = service([], {
    ctx: createContext({
      fleet: fleetOf([]),
      clock: { now: () => new Date(Date.now()) },
    }),
    createSweeper,
    exec: {
      runJSON: async () => ({ ok: false, code: 1, error: "offline fixture" }),
      runText: async (_cmd, args) => {
        if (args[1] !== "graphql") return { ok: false, code: 1, error: "offline fixture" };
        calls++;
        return {
          ok: true,
          exitCode: 0,
          data: JSON.stringify({
            data: {
              spicodeBudget: { cost: 2, remaining: 50, resetAt },
            },
          }),
        };
      },
    },
  });
  await first.start();
  expect(calls).toBeGreaterThan(0);
  expect(budgets()[0]).toMatchObject({ calls, cost: calls * 2, resetAt });
  const before = calls;
  await first.sweep(true);
  expect(budgets()).toHaveLength(2);
  expect(budgets()[1]).toMatchObject({
    cursor: 2,
    calls: calls - before,
    cost: (calls - before) * 2,
  });
  expect(budgets()[0].deferred).toContainEqual({ area: "security", reason: expect.any(String) });
});

it("logs charges when collectors abort before publishing the budget, without double counting", async () => {
  let calls = 0;
  let fail = true;
  const failure = new Error("budget pacing interrupted");
  const resetAt = new Date(epoch + 3600_000).toISOString();
  const pacer = new BudgetPacer({ floor: 100, resetBudget: 5000 });
  const plan = pacer.plan.bind(pacer);
  vi.spyOn(pacer, "plan").mockImplementation((input) => {
    if (fail && calls > 0) throw failure;
    return plan(input);
  });
  const first = service([], {
    ctx: createContext({ fleet: fleetOf([]), clock: { now: () => new Date(Date.now()) } }),
    createSweeper,
    pacer,
    exec: {
      runJSON: async () => ({ ok: false, code: 1, error: "offline fixture" }),
      runText: async (_cmd, args) => {
        if (args[1] !== "graphql") return { ok: false, code: 1, error: "offline fixture" };
        calls++;
        return {
          ok: true,
          data: JSON.stringify({
            data: { spicodeBudget: { cost: 2, remaining: 1000, resetAt } },
          }),
        };
      },
    },
  });
  await expect(first.start()).rejects.toBe(failure);
  const abortedCalls = calls;
  expect(abortedCalls).toBeGreaterThan(0);
  expect(budgets()).toHaveLength(1);
  expect(budgets()[0]).toMatchObject({
    cursor: 0,
    calls: abortedCalls,
    cost: abortedCalls * 2,
    remaining: 1000,
    resetAt,
  });
  fail = false;
  await first.sweep(true);
  expect(budgets()).toHaveLength(2);
  expect(budgets()[1]).toMatchObject({
    cursor: 1,
    calls: calls - abortedCalls,
    cost: (calls - abortedCalls) * 2,
  });
});

it("does not log an attempt rejected by the first guard as another sweep", async () => {
  const afterAreas = vi.fn(async ({ cache }: SweepInput<ReturnType<typeof emptyCache>>) => {
    cache.budget = {
      ...cache.budget,
      cost: 7,
      calls: 3,
      deferred: [{ area: "security", reason: "floor" }],
    };
  });
  const first = service([], {
    createSweeper: (options) =>
      new Sweeper({
        ...options,
        areas: [],
        cacheSchema,
        emptyCache,
        afterAreas,
      }),
  });
  await first.start();
  vi.setSystemTime(epoch + 3000);
  await expect(first.sweep()).rejects.toThrow("Lease lost");
  expect(afterAreas).toHaveBeenCalledTimes(1);
  expect(budgets().map(({ cost, calls }) => [cost, calls])).toEqual([[7, 3]]);
});

it.each([false, true])(
  "resets prior charges before a sweep fails (restored: %s)",
  async (restore) => {
    let fail = false;
    const failure = new Error("collector failed before updating the budget");
    const options: Partial<SweepServiceOptions> = {
      createSweeper: (options) =>
        new Sweeper({
          ...options,
          areas: [],
          cacheSchema,
          emptyCache,
          afterAreas: async ({ cache }) => {
            if (fail) throw failure;
            cache.budget = {
              ...cache.budget,
              cost: 7,
              calls: 3,
              deferred: [{ area: "security", reason: "floor" }],
            };
          },
        }),
    };
    const charged = service([], options);
    await charged.start();
    fail = true;
    if (restore) {
      await charged.stop();
      await expect(service([], options).start()).rejects.toBe(failure);
    } else {
      await expect(charged.sweep()).rejects.toBe(failure);
    }
    expect(budgets().map(({ cost, calls, deferred }) => ({ cost, calls, deferred }))).toEqual([
      { cost: 7, calls: 3, deferred: [{ area: "security", reason: "floor" }] },
      { cost: 0, calls: 0, deferred: [] },
    ]);
  },
);

it("projects with a two-hour lead time by default and each sweep's items as the previous", async () => {
  expect(LEAD_TIME_MS).toBe(2 * 60 * 60 * 1000);
  const carried = project.projectWatch(fixtureInput()).briefing.focus[0];
  if (!carried) throw new Error("Missing fixture item");
  const { id, ids, rung, attention, owned } = carried;
  const prior = { id, ids, rung, attention, owned };
  const real = project.projectWatch;
  const watch = vi.spyOn(project, "projectWatch").mockImplementation((input) => {
    const view = real(input);
    return { ...view, briefing: { ...view.briefing, focus: [carried] } };
  });
  const first = service();
  expect(first.leadTime).toBe(LEAD_TIME_MS);
  await first.start();
  await first.sweep(true);
  expect(watch.mock.calls.map(([input]) => input.attention)).toEqual([
    { leadTimeMs: LEAD_TIME_MS, previous: [] },
    { leadTimeMs: LEAD_TIME_MS, previous: [prior], previousThemes: [] },
  ]);
  await first.stop();

  watch.mockClear();
  const next = service([], { leadTimeMs: 60_000 });
  await next.start();
  expect(watch.mock.calls[0]?.[0].attention).toEqual({
    leadTimeMs: 60_000,
    previous: [prior],
    previousThemes: [],
  });
  expect(() => service([], { leadTimeMs: -1 })).toThrow(RangeError);
});

it("logs the returned commit cursor without decoding the saved snapshot again", async () => {
  let restore: (() => void) | undefined;
  const first = service([], {
    createSweeper: (options) =>
      new Sweeper({
        ...options,
        areas: [],
        cacheSchema,
        emptyCache,
        persist: {
          load: options.persist.load,
          save: async (state) => {
            await options.persist.save(state);
            const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
              throw new Error("Unexpected snapshot decode after commit");
            });
            restore = () => parse.mockRestore();
          },
        },
      }),
  });
  try {
    expect(await first.start()).toBe(true);
  } finally {
    restore?.();
  }
  expect(budgets()).toHaveLength(1);
  expect(budgets()[0].cursor).toBe(1);
});

it("preserves the sweep failure alongside a budget-log failure", async () => {
  const failure = new Error("original collector failure");
  const onError = vi.fn();
  mkdirSync(join(directory, "sweep-budget.jsonl"));
  const first = service([], {
    onError,
    createSweeper: (options) =>
      new Sweeper({
        ...options,
        areas: [],
        cacheSchema,
        emptyCache,
        afterAreas: async () => {
          throw failure;
        },
      }),
  });
  await expect(first.start()).rejects.toMatchObject({
    cause: failure,
    errors: [failure, expect.objectContaining({ code: "EISDIR" })],
  });
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "EISDIR" }));
});

it("rejects a budget-log failure even when the sweep itself succeeds", async () => {
  const onError = vi.fn();
  mkdirSync(join(directory, "sweep-budget.jsonl"));
  const first = service([], { onError });
  await expect(first.start()).rejects.toMatchObject({ code: "EISDIR" });
  expect(first.latest()?.cursor).toBe(1);
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "EISDIR" }));
});

it("coalesces requests, aborts on stop and sends no further Exec calls after cancellation", async () => {
  let signal: AbortSignal | undefined;
  const runText = vi.fn<Exec["runText"]>(
    (_cmd, _args, options) =>
      new Promise((resolve) => {
        signal = options?.signal;
        signal?.addEventListener("abort", () =>
          resolve({ ok: false, code: null, error: "aborted" }),
        );
      }),
  );
  const first = service(
    [
      {
        name: "auth",
        read: async (input) => {
          await input.exec.runText("gh", []);
          await input.exec.runText("gh", []);
          return { data: auth, reads: [] };
        },
      },
    ],
    { exec: { ...exec, runText } },
  );
  const running = first.start();
  const rejected = expect(running).rejects.toThrow("Sweep service stopped");
  expect(first.sweep()).toBe(running);
  await vi.advanceTimersByTimeAsync(0);
  await first.stop();
  await rejected;
  expect(signal?.aborted).toBe(true);
  expect(runText).toHaveBeenCalledTimes(1);
  expect(first.latest()).toBeUndefined();
  expect(budgets()).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(createLeaseStore(db).acquire("test", "next", 3000, Date.now())).toBe(2);
});

it.each([false, true])(
  "resolves concurrent and repeated stops while a sweep unwinds (restart: %s)",
  async (restart) => {
    let finish: (() => void) | undefined;
    const first = service([
      {
        name: "auth",
        read: async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { data: auth, reads: [] };
        },
      },
    ]);
    const rejected = expect(first.start()).rejects.toThrow("Sweep service stopped");
    await vi.advanceTimersByTimeAsync(0);
    expect(finish).toBeTypeOf("function");
    const stopped = first.stop();
    const restarted = restart
      ? expect(first.start()).rejects.toThrow("Sweep service stopped")
      : undefined;
    const stops = expect(Promise.all([stopped, first.stop()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    finish?.();
    await stops;
    await rejected;
    await restarted;
    await expect(first.stop()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(budgets()).toHaveLength(1);
    expect(createLeaseStore(db).acquire("test", "next", 3000, Date.now())).toBe(2);
  },
);

it("does not report intentional stop cancellation from a background sweep", async () => {
  const onError = vi.fn();
  let blocked = false;
  const first = service(
    [
      {
        name: "auth",
        read: async (input) => {
          if (blocked) await input.exec.runText("gh", []);
          return { data: auth, reads: [] };
        },
      },
    ],
    {
      onError,
      intervalMs: 100,
      exec: {
        ...exec,
        runText: (_cmd, _args, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
          }),
      },
    },
  );
  await first.start();
  blocked = true;
  await vi.advanceTimersByTimeAsync(100);
  expect(first.sweeping).toBe(true);
  await first.stop();
  expect(onError).not.toHaveBeenCalled();
  expect(budgets()).toHaveLength(2);
});

it("does not rearm an old timer generation when restarted during its sweep", async () => {
  let finish: (() => void) | undefined;
  let blocked = false;
  const first = service(
    [
      {
        name: "auth",
        read: async () => {
          if (blocked)
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
          return { data: auth, reads: [] };
        },
      },
    ],
    { intervalMs: 100, onError: vi.fn() },
  );
  await first.start();
  blocked = true;
  await vi.advanceTimersByTimeAsync(100);
  expect(finish).toBeTypeOf("function");
  const stopped = first.stop();
  const restarted = expect(first.start()).rejects.toThrow("Sweep service stopped");
  finish?.();
  await stopped;
  await restarted;
  await vi.advanceTimersByTimeAsync(0);
  // Only the new full-sweep, poll and daily-prune chains remain.
  expect(vi.getTimerCount()).toBe(3);
  blocked = false;
  await vi.advanceTimersByTimeAsync(100);
  expect(first.latest()?.cursor).toBe(2);
  await first.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("trims budget logs on the daily prune clock, retaining a full day across fleets", async () => {
  const first = service([], { intervalMs: 2 * DAY_MS, ttlMs: 3 * DAY_MS });
  await first.start();
  const log = join(directory, "sweep-budget.jsonl");
  const records = [
    { ...budgets()[0], fleet: "other", endedAt: new Date(epoch - 1).toISOString() },
    budgets()[0],
    { ...budgets()[0], endedAt: new Date(epoch + 1).toISOString() },
  ];
  writeFileSync(log, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  await vi.advanceTimersByTimeAsync(DAY_MS - 1);
  expect(budgets()).toEqual(records);
  await vi.advanceTimersByTimeAsync(1);
  expect(budgets()).toEqual(records.slice(1));
});

it("trims budget logs on startup across sessions shorter than a day", async () => {
  const seed = service();
  await seed.start();
  await seed.stop();
  const record = budgets()[0];
  const old = { ...record, endedAt: new Date(epoch - 30 * DAY_MS).toISOString() };
  const boundary = { ...record, endedAt: new Date(epoch - DAY_MS).toISOString() };
  writeFileSync(
    join(directory, "sweep-budget.jsonl"),
    `${[old, boundary, record].map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  for (let session = 0; session < 3; session++) {
    vi.setSystemTime(epoch + (session * DAY_MS) / 2);
    const next = service([], { intervalMs: 2 * DAY_MS, ttlMs: 3 * DAY_MS });
    await expect(next.start()).resolves.toBe(true);
    expect(budgets()).not.toContainEqual(old);
    if (session === 0) expect(budgets()).toContainEqual(boundary);
    else expect(budgets()).not.toContainEqual(boundary);
    expect(budgets()).toContainEqual(record);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await next.stop();
  }
});

it.each(["startup", "append", "daily trim"])(
  "quarantines a torn budget-log tail before %s and keeps trimming",
  async (recovery) => {
    const onError = vi.fn();
    const first = service([], { intervalMs: 2 * DAY_MS, ttlMs: 3 * DAY_MS, onError });
    await first.start();
    const record = budgets()[0];
    const old = { ...record, endedAt: new Date(epoch - 2 * DAY_MS).toISOString() };
    const log = join(directory, "sweep-budget.jsonl");
    const fragment = Buffer.concat([
      Buffer.from('{"fleet":"torn","cost":7,"detail":"'),
      Buffer.from([0xe2, 0x82]),
    ]);
    writeFileSync(
      log,
      Buffer.concat([
        Buffer.from(`${[old, record].map((line) => JSON.stringify(line)).join("\n")}\n`),
        fragment,
      ]),
    );
    if (recovery === "startup") {
      await first.stop();
      await first.start();
    } else if (recovery === "append") {
      await first.sweep(true);
    } else {
      await vi.advanceTimersByTimeAsync(DAY_MS);
    }
    const quarantines = readdirSync(directory).filter((name) =>
      /^sweep-budget\.jsonl\..+\.torn$/.test(name),
    );
    expect(quarantines).toHaveLength(1);
    expect(readFileSync(join(directory, quarantines[0] ?? ""))).toEqual(fragment);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining(join(directory, quarantines[0] ?? "")),
      }),
    );
    expect(budgets()).toContainEqual(record);
    if (recovery !== "append") expect(budgets()).not.toContainEqual(old);
    await first.sweep(true);
    expect(budgets().at(-1)?.cursor).toBe(recovery === "daily trim" ? 2 : 3);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(budgets()).not.toContainEqual(old);
    expect(readFileSync(join(directory, quarantines[0] ?? ""))).toEqual(fragment);
    expect(onError).toHaveBeenCalledOnce();
  },
);

it("quarantines a wholly torn budget log before the next sweep", async () => {
  const fragment = '{"fleet":"test","cost":';
  writeFileSync(join(directory, "sweep-budget.jsonl"), fragment);
  const first = service([], { onError: vi.fn() });
  await expect(first.start()).resolves.toBe(true);
  expect(budgets()).toHaveLength(1);
  const quarantines = readdirSync(directory).filter((name) => name.endsWith(".torn"));
  expect(quarantines).toHaveLength(1);
  expect(readFileSync(join(directory, quarantines[0] ?? ""), "utf8")).toBe(fragment);
});

it.each(["sweep", "daily trim"])(
  "reuses one content-addressed quarantine after a failed rename and a later %s",
  async (recovery) => {
    const onError = vi.fn();
    const first = service([], { intervalMs: 2 * DAY_MS, ttlMs: 3 * DAY_MS, onError });
    await first.start();
    const log = join(directory, "sweep-budget.jsonl");
    const fragment = Buffer.from([0x7b, 0x22, 0xe2, 0x82]);
    const contents = Buffer.concat([readFileSync(log), fragment]);
    writeFileSync(log, contents);
    const failure = Object.assign(new Error("held Windows handle"), { code: "EPERM" });
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw failure;
    });
    await expect(first.sweep(true)).rejects.toBe(failure);
    expect(readFileSync(log)).toEqual(contents);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    if (recovery === "sweep") await first.sweep(true);
    else await vi.advanceTimersByTimeAsync(DAY_MS);
    await first.sweep(true);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    const quarantine = `${log}.${createHash("sha256").update(fragment).digest("hex")}.torn`;
    expect(readdirSync(directory).filter((name) => name.endsWith(".torn"))).toEqual([
      basename(quarantine),
    ]);
    expect(readFileSync(quarantine)).toEqual(fragment);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining(quarantine) }),
    );
    expect(budgets().at(-1)?.fleet).toBe("test");
  },
);

it.each(["other evidence", "", '{"to'])(
  "refuses mismatched quarantine bytes %j without overwriting",
  async (existing) => {
    const first = service();
    await first.start();
    const log = join(directory, "sweep-budget.jsonl");
    const fragment = Buffer.from('{"torn":');
    const contents = Buffer.concat([readFileSync(log), fragment]);
    writeFileSync(log, contents);
    const quarantine = `${log}.${createHash("sha256").update(fragment).digest("hex")}.torn`;
    writeFileSync(quarantine, existing);
    await expect(first.sweep(true)).rejects.toThrow("Quarantine contents differ");
    expect(readFileSync(quarantine, "utf8")).toBe(existing);
    expect(readFileSync(log)).toEqual(contents);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  },
);

it.each(["sweep", "daily trim"])(
  "retries a partial quarantine write on a later %s without poisoning its final name",
  async (recovery) => {
    const onError = vi.fn();
    const first = service([], { intervalMs: 2 * DAY_MS, ttlMs: 3 * DAY_MS, onError });
    await first.start();
    const log = join(directory, "sweep-budget.jsonl");
    const fragment = Buffer.from('{"torn":"unfinished');
    const contents = Buffer.concat([readFileSync(log), fragment]);
    writeFileSync(log, contents);
    const quarantine = `${log}.${createHash("sha256").update(fragment).digest("hex")}.torn`;
    const failure = Object.assign(new Error("disk full during quarantine write"), {
      code: "ENOSPC",
    });
    vi.mocked(writeFileSync).mockImplementationOnce((file) => {
      realFs.writeFileSync(file, fragment.subarray(0, 4));
      throw failure;
    });
    await expect(first.sweep(true)).rejects.toBe(failure);
    expect(readFileSync(log)).toEqual(contents);
    expect(readdirSync(directory).filter((name) => name.endsWith(".torn"))).toEqual([]);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    if (recovery === "sweep") await first.sweep(true);
    else await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(readFileSync(quarantine)).toEqual(fragment);
    expect(readdirSync(directory).filter((name) => name.endsWith(".torn"))).toEqual([
      basename(quarantine),
    ]);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: expect.stringContaining(quarantine) }),
    );
    expect(budgets()[0]?.fleet).toBe("test");
  },
);

it.each(["EPERM", "ENOTSUP", "EXDEV"])(
  "atomically publishes and reuses a complete quarantine when links fail with %s",
  async (code) => {
    const onError = vi.fn();
    const first = service([], { onError });
    await first.start();
    const log = join(directory, "sweep-budget.jsonl");
    const fragment = Buffer.from('{"torn":"unfinished');
    const contents = Buffer.concat([readFileSync(log), fragment]);
    writeFileSync(log, contents);
    const quarantine = `${log}.${createHash("sha256").update(fragment).digest("hex")}.torn`;
    vi.mocked(linkSync).mockImplementation(() => {
      throw Object.assign(new Error("unsupported hard links"), { code });
    });
    const failure = new Error("active log rewrite failed");
    let failed = false;
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (to === log && !failed) {
        failed = true;
        throw failure;
      }
      if (to === quarantine) expect(readFileSync(from)).toEqual(fragment);
      realFs.renameSync(from, to);
    });
    await expect(first.sweep(true)).rejects.toBe(failure);
    expect(readFileSync(log)).toEqual(contents);
    expect(readFileSync(quarantine)).toEqual(fragment);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await first.sweep(true);
    expect(linkSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(renameSync).mock.calls.filter(([, to]) => to === quarantine)).toHaveLength(1);
    expect(openSync).not.toHaveBeenCalledWith(quarantine, "wx");
    expect(readFileSync(quarantine)).toEqual(fragment);
    expect(readdirSync(directory).filter((name) => name.endsWith(".torn"))).toEqual([
      basename(quarantine),
    ]);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
  },
);

it.each(["repair", "daily trim"])(
  "flushes and closes budget evidence before %s renames and flushes its directory",
  async (operation) => {
    const first = service([], {
      intervalMs: 2 * DAY_MS,
      ttlMs: 3 * DAY_MS,
      onError: vi.fn(),
    });
    await first.start();
    const log = join(directory, "sweep-budget.jsonl");
    const fragment = Buffer.from('{"torn":');
    if (operation === "repair") {
      writeFileSync(log, Buffer.concat([readFileSync(log), fragment]));
    }
    const events = traceBudgetIO();
    if (operation === "repair") await first.sweep(true);
    else await vi.advanceTimersByTimeAsync(DAY_MS);
    const temporary = String(vi.mocked(renameSync).mock.calls[0]?.[0]);
    expect(temporary).toMatch(/\.tmp$/);
    const expected: string[] = [];
    if (operation === "repair") {
      const quarantine = `${log}.${createHash("sha256").update(fragment).digest("hex")}.torn`;
      const staged = String(vi.mocked(linkSync).mock.calls[0]?.[0]);
      expect(staged).toMatch(/\.torn\..+\.tmp$/);
      expect(openSync).toHaveBeenCalledWith(staged, "wx");
      expect(linkSync).toHaveBeenCalledWith(staged, quarantine);
      expected.push(
        `write:${staged}`,
        `fsync:${staged}`,
        `close:${staged}`,
        `link:${staged}`,
        `fsync:${directory}`,
        `close:${directory}`,
      );
    }
    expect(events).toEqual([
      ...expected,
      `write:${temporary}`,
      `fsync:${temporary}`,
      `close:${temporary}`,
      `rename:${temporary}`,
      `fsync:${directory}`,
      `close:${directory}`,
    ]);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  },
);

it.each(["EPERM", "EISDIR"])(
  "skips unsupported Windows directory opens with %s after the rewrite",
  async (code) => {
    const onError = vi.fn();
    const first = service([], { intervalMs: 2 * DAY_MS, ttlMs: 3 * DAY_MS, onError });
    await first.start();
    vi.mocked(openSync).mockImplementation((file, flags, mode) => {
      if (file === directory) {
        throw Object.assign(new Error("unsupported directory open"), { code });
      }
      return realFs.openSync(file, flags, mode);
    });
    vi.stubGlobal("process", { ...process, platform: "win32" });
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(openSync).toHaveBeenCalledWith(directory, "r");
    expect(renameSync).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(budgets()).toHaveLength(1);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  },
);

it.each(["quarantine", "rewrite"])(
  "keeps the active log intact when a %s fsync fails and durably retries",
  async (operation) => {
    const onError = vi.fn();
    const first = service([], { onError });
    await first.start();
    const log = join(directory, "sweep-budget.jsonl");
    const fragment = Buffer.from('{"torn":');
    const contents = Buffer.concat([readFileSync(log), fragment]);
    writeFileSync(log, contents);
    const failure = new Error("fsync failed");
    let failed = false;
    const events = traceBudgetIO((file) => {
      if (
        !failed &&
        file?.endsWith(".tmp") &&
        file.includes(".torn.") === (operation === "quarantine")
      ) {
        failed = true;
        throw failure;
      }
    });
    await expect(first.sweep(true)).rejects.toBe(failure);
    expect(readFileSync(log)).toEqual(contents);
    expect(renameSync).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    events.length = 0;
    await first.sweep(true);
    const quarantineSync = events.findIndex(
      (event) => event.startsWith("fsync:") && event.includes(".torn."),
    );
    expect(quarantineSync).toBeGreaterThanOrEqual(0);
    expect(quarantineSync).toBeLessThan(events.findIndex((event) => event.startsWith("rename:")));
    expect(readdirSync(directory).filter((name) => name.endsWith(".torn"))).toHaveLength(1);
    expect(onError).toHaveBeenCalledOnce();
  },
);

it.each([
  ["win32", "EPERM", false],
  ["win32", "EISDIR", false],
  ["win32", "EIO", true],
  ["darwin", "EPERM", true],
  ["darwin", "EISDIR", true],
] as const)(
  "handles directory fsync on %s with %s (reported: %s)",
  async (platform, code, reported) => {
    const onError = vi.fn();
    const first = service([], { intervalMs: 2 * DAY_MS, ttlMs: 3 * DAY_MS, onError });
    await first.start();
    const failure = Object.assign(new Error("directory fsync failed"), { code });
    traceBudgetIO((file) => {
      if (file === directory) throw failure;
    });
    vi.stubGlobal("process", { ...process, platform });
    await vi.advanceTimersByTimeAsync(DAY_MS);
    if (reported) expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    else expect(onError).not.toHaveBeenCalled();
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  },
);

it("separates a complete unterminated budget record from the next append", async () => {
  const first = service();
  await first.start();
  const record = budgets()[0];
  writeFileSync(join(directory, "sweep-budget.jsonl"), JSON.stringify(record));
  await first.sweep(true);
  expect(budgets()).toEqual([record, { ...record, cursor: 2 }]);
  expect(readdirSync(directory).filter((name) => name.endsWith(".torn"))).toEqual([]);
});

it("rejects asynchronously when the startup trim error sink throws", async () => {
  const log = join(directory, "sweep-budget.jsonl");
  const contents = "{not-json}\n";
  writeFileSync(log, contents);
  const failure = new Error("error sink failed");
  const onError = vi.fn(() => {
    throw failure;
  });
  const first = service([], { onError });
  let started: Promise<boolean> | undefined;
  expect(() => {
    started = first.start();
  }).not.toThrow();
  await expect(started).rejects.toBe(failure);
  expect(onError).toHaveBeenCalledWith(expect.any(SyntaxError));
  expect(readFileSync(log, "utf8")).toBe(contents);
  expect(first.latest()).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("reports malformed startup budget evidence without blocking the immediate sweep", async () => {
  const onError = vi.fn();
  const log = join(directory, "sweep-budget.jsonl");
  const contents = "{not-json}\n";
  writeFileSync(log, contents);
  const first = service([], { onError });
  await expect(first.start()).resolves.toBe(true);
  expect(onError).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledWith(expect.any(SyntaxError));
  expect(first.latest()?.cursor).toBe(1);
  expect(readFileSync(log, "utf8").startsWith(contents)).toBe(true);
});

it("reports malformed budget evidence without replacing the log", async () => {
  const onError = vi.fn();
  const first = service([], { intervalMs: 2 * DAY_MS, ttlMs: 3 * DAY_MS, onError });
  await first.start();
  const log = join(directory, "sweep-budget.jsonl");
  const contents = `${readFileSync(log, "utf8")}{"endedAt":"invalid"}\n`;
  writeFileSync(log, contents);
  await vi.advanceTimersByTimeAsync(DAY_MS);
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Invalid sweep budget log timestamp" }),
  );
  expect(readFileSync(log, "utf8")).toBe(contents);
});

it("prunes daily on the injected clock, retaining seven days and each fleet's latest snapshot", async () => {
  const leases = createLeaseStore(db);
  const snapshots = createSnapshotStore(db);
  const old = epoch - 8 * DAY_MS;
  leases.acquire("old", "writer", 2 * DAY_MS, old);
  const lease = { fleet: "old", owner: "writer", fence: 1 };
  snapshots.writeSnapshot(lease, {}, {}, old);
  snapshots.writeSnapshot(lease, {}, {}, epoch - 7 * DAY_MS + 1);
  snapshots.writeSnapshot(lease, {}, {}, epoch - 7 * DAY_MS + 2);
  const first = service([], { intervalMs: 2 * DAY_MS, ttlMs: 3 * DAY_MS });
  await first.start();
  expect(snapshots.snapshotsSince(0).map((row) => row.cursor)).toEqual([2, 3, 4]);
  await vi.advanceTimersByTimeAsync(DAY_MS - 1);
  expect(snapshots.snapshotsSince(0)).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(snapshots.snapshotsSince(0).map((row) => row.cursor)).toEqual([3, 4]);
  await first.stop();
  await vi.advanceTimersByTimeAsync(DAY_MS);
  expect(vi.getTimerCount()).toBe(0);
});

it("prunes on startup even as a lease contender, retaining every fleet's latest cursor", async () => {
  const leases = createLeaseStore(db);
  const snapshots = createSnapshotStore(db);
  const old = epoch - 8 * DAY_MS;
  leases.acquire("old", "writer", 100, old);
  const lease = { fleet: "old", owner: "writer", fence: 1 };
  snapshots.writeSnapshot(lease, {}, {}, old);
  snapshots.writeSnapshot(lease, {}, {}, old + 1);
  leases.acquire("test", "other holder", 3000, epoch);
  const first = service();
  await expect(first.start()).resolves.toBe(false);
  expect(snapshots.snapshotsSince(0).map((row) => row.cursor)).toEqual([2]);
});

it("polls in-flight work between sweeps without overlapping a full sweep", async () => {
  const poll = vi.fn(async () => ({ changed: false, settled: false }));
  const first = service([], {
    createSweeper: (options) =>
      new Sweeper({
        ...options,
        areas: [],
        cacheSchema,
        emptyCache,
        inflight: { has: () => true, poll },
      }),
  });
  await first.start();
  await vi.advanceTimersByTimeAsync(INFLIGHT_POLL_MS);
  expect(poll).toHaveBeenCalledTimes(1);
  expect(budgets()).toHaveLength(1);
  expect(first.latest()?.cursor).toBe(1);
  poll.mockResolvedValueOnce({ changed: true, settled: true });
  await vi.advanceTimersByTimeAsync(INFLIGHT_POLL_MS);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(budgets()).toHaveLength(2);
  expect(first.latest()?.cursor).toBe(2);
});

it("queues a full forced sweep behind a poll instead of joining it", async () => {
  const forces: boolean[] = [];
  let finishPoll: (() => void) | undefined;
  const first = service([], {
    createSweeper: (options) =>
      new Sweeper({
        ...options,
        areas: [],
        cacheSchema,
        emptyCache,
        afterAreas: async (input) => {
          forces.push(input.force);
        },
        inflight: {
          has: () => true,
          poll: async () => {
            await new Promise<void>((resolve) => {
              finishPoll = resolve;
            });
            return { changed: false, settled: false };
          },
        },
      }),
  });
  await first.start();
  await vi.advanceTimersByTimeAsync(INFLIGHT_POLL_MS);
  expect(finishPoll).toBeTypeOf("function");
  const queued = first.sweep();
  const forced = first.sweep(true);
  expect(forced).toBe(queued);
  expect(forces).toEqual([false]);
  finishPoll?.();
  await expect(forced).resolves.toBe(true);
  expect(forces).toEqual([false, true]);
  expect(budgets()).toHaveLength(2);
  expect(first.latest()?.cursor).toBe(2);
});

it("runs a queued forced sweep even when the preceding poll fails", async () => {
  const forces: boolean[] = [];
  let failPoll: ((error: Error) => void) | undefined;
  const onError = vi.fn();
  const first = service([], {
    onError,
    createSweeper: (options) =>
      new Sweeper({
        ...options,
        areas: [],
        cacheSchema,
        emptyCache,
        afterAreas: async (input) => {
          forces.push(input.force);
        },
        inflight: {
          has: () => true,
          poll: async () => {
            await new Promise<void>((_resolve, reject) => {
              failPoll = reject;
            });
            return { changed: false, settled: false };
          },
        },
      }),
  });
  await first.start();
  await vi.advanceTimersByTimeAsync(INFLIGHT_POLL_MS);
  const forced = first.sweep(true);
  const result = expect(forced).resolves.toBe(true);
  const failure = new Error("poll failed");
  failPoll?.(failure);
  await result;
  expect(onError).toHaveBeenCalledWith(failure);
  expect(forces).toEqual([false, true]);
  expect(budgets()).toHaveLength(2);
});

it("a SIGKILLed holder is excluded until expiry, then its successor resumes state and cursor", async () => {
  vi.useRealTimers();
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./holder.mjs", import.meta.url)), path, directory, String(epoch)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout });
  const exited = once(child, "exit");
  try {
    const ready = await Promise.race([
      once(lines, "line").then(([line]) => String(line)),
      exited.then(() => {
        throw new Error(`Holder exited: ${stderr}`);
      }),
    ]);
    expect(ready).toBe("committed 1");
    let now = epoch;
    const observed: unknown[] = [];
    const next = service(
      [
        {
          name: "auth",
          read: async (input) => {
            observed.push(input.facts.auth.data);
            return { data: auth, reads: [] };
          },
        },
      ],
      { ctx: createContext({ clock: { now: () => new Date(now) } }) },
    );
    expect(await next.start()).toBe(false);
    child.kill("SIGKILL");
    await exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(await next.sweep()).toBe(false);
    now += 3000;
    expect(await next.sweep()).toBe(true);
    expect(observed).toEqual([auth]);
    expect(next.latest()?.cursor).toBe(2);
    expect(createSnapshotStore(db).latestSnapshot("test")?.fence).toBe(2);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    lines.close();
  }
}, 30_000);

it("recovers a complete snapshot and cursor after SIGKILL during writeSnapshot", async () => {
  vi.useRealTimers();
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./holder.mjs", import.meta.url)),
      path,
      directory,
      String(epoch),
      "mid-write",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout });
  const exited = once(child, "exit");
  try {
    const ready = await Promise.race([
      once(lines, "line").then(([line]) => String(line)),
      exited.then(() => {
        throw new Error(`Holder exited: ${stderr}`);
      }),
    ]);
    expect(ready).toBe("writing snapshot 2");
    const snapshots = createSnapshotStore(db);
    const old = snapshots.latestSnapshot("test");
    expect(old?.cursor).toBe(1);
    expect(old?.facts).toMatchObject({ facts: { auth: { data: auth } } });
    const contender = new DatabaseSync(path);
    try {
      contender.exec("PRAGMA busy_timeout = 0");
      expect(() => contender.exec("BEGIN IMMEDIATE")).toThrow(
        expect.objectContaining({ errcode: 5 }),
      );
    } finally {
      contender.close();
    }
    child.kill("SIGKILL");
    await exited;
    expect(child.signalCode).toBe("SIGKILL");
    const recovered = snapshots.latestSnapshot("test");
    expect(recovered).toEqual(old);
    expect(snapshots.snapshotsSince(0)).toEqual([old]);
    const observed: unknown[] = [];
    const next = service(
      [
        {
          name: "auth",
          read: async (input) => {
            observed.push(input.facts.auth.data);
            return { data: auth, reads: [] };
          },
        },
      ],
      { ctx: createContext({ clock: { now: () => new Date(epoch + 3000) } }) },
    );
    expect(await next.start()).toBe(true);
    expect(observed).toEqual([auth]);
    expect(next.latest()?.cursor).toBe(2);
    expect(snapshots.latestSnapshot("test")?.fence).toBe(2);
    expect(snapshots.snapshotsSince(0).map((snapshot) => snapshot.cursor)).toEqual([1, 2]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    lines.close();
  }
}, 30_000);

function controlledTimers() {
  const pending = new Set<{ ms: number; callback: () => void }>();
  const deadlines: number[] = [];
  const timers = {
    after(ms: number, callback: () => void) {
      if (ms === SWEEP_MS) deadlines.push(Date.now() + ms);
      const timer = { ms, callback };
      pending.add(timer);
      return () => pending.delete(timer);
    },
  };
  const fire = async (ms: number) => {
    const timer = [...pending].find((timer) => timer.ms === ms);
    expect(timer).toBeDefined();
    if (!timer) throw new Error(`No timer armed for ${ms} ms`);
    pending.delete(timer);
    timer.callback();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { deadlines, timers, fire };
}

function scheduled() {
  const deadlines: number[] = [];
  const after = (ms: number, callback: () => void) => {
    if (ms === SWEEP_MS) deadlines.push(Date.now() + ms);
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  };
  return { deadlines, timers: { after } };
}

function gated() {
  const waiting: (() => void)[] = [];
  let opened = 0;
  const gate = {
    open: async () => {
      const resolve = waiting.shift();
      if (resolve) resolve();
      else opened++;
      await vi.advanceTimersByTimeAsync(0);
    },
  };
  const read = vi.fn(async () => {
    if (opened > 0) opened--;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    return { data: auth, reads: [] };
  });
  return { gate, read };
}

it("reports the armed timer's deadline as the next sweep, null while one runs", async () => {
  const { deadlines, timers, fire } = controlledTimers();
  const { gate, read } = gated();
  const statuses: SweepSchedulerStatus[] = [];
  const first = service([{ name: "auth", read }], {
    timers,
    ttlMs: 10 * SWEEP_MS,
    onStatus: (status) => statuses.push(status),
  });
  const started = first.start();
  expect(statuses).toEqual([
    { nextSweepAt: new Date(epoch + SWEEP_MS).toISOString(), forceCooldownUntil: null },
    { nextSweepAt: null, forceCooldownUntil: null },
  ]);
  vi.setSystemTime(epoch + 4000);
  await gate.open();
  await expect(started).resolves.toBe(true);
  expect(deadlines).toEqual([epoch + SWEEP_MS]);
  expect(statuses.at(-1)).toMatchObject({
    nextSweepAt: new Date(epoch + SWEEP_MS).toISOString(),
    lastSweep: { outcome: "committed" },
  });

  vi.setSystemTime(epoch + SWEEP_MS);
  await fire(SWEEP_MS);
  expect(statuses.at(-1)).toEqual({ nextSweepAt: null, forceCooldownUntil: null });
  vi.setSystemTime(epoch + SWEEP_MS + 2000);
  await gate.open();
  await vi.advanceTimersByTimeAsync(0);
  expect(deadlines).toEqual([epoch + SWEEP_MS, epoch + 2 * SWEEP_MS + 2000]);
  expect(statuses.at(-1)?.nextSweepAt).toBe(new Date(epoch + 2 * SWEEP_MS + 2000).toISOString());

  vi.setSystemTime(epoch + SWEEP_MS + 62_000);
  const requested = first.sweep(false, true);
  expect(statuses.at(-1)).toEqual({ nextSweepAt: null, forceCooldownUntil: null });
  await gate.open();
  await requested;
  expect(deadlines).toEqual([
    epoch + SWEEP_MS,
    epoch + 2 * SWEEP_MS + 2000,
    epoch + 2 * SWEEP_MS + 62_000,
  ]);
  expect(statuses.at(-1)?.nextSweepAt).toBe(new Date(epoch + 2 * SWEEP_MS + 62_000).toISOString());
  await first.stop();
  expect(statuses.at(-1)).toEqual({ nextSweepAt: null, forceCooldownUntil: null });
});

it("rearms a deadline a sweep ran past, so no outcome promises an expired next sweep", async () => {
  let fail = false;
  const { deadlines, timers } = scheduled();
  const statuses: SweepSchedulerStatus[] = [];
  const first = service([], {
    timers,
    ttlMs: 10 * SWEEP_MS,
    onError: vi.fn(),
    onStatus: (status) => statuses.push(status),
    createSweeper: (options) =>
      new Sweeper({
        ...options,
        areas: [],
        cacheSchema,
        emptyCache,
        afterAreas: async () => {
          vi.setSystemTime(Date.now() + SWEEP_MS + 1000);
          if (fail) throw new ForgeError("gh failed", 503, "gateway");
        },
      }),
  });
  const finished = () => {
    const status = statuses.at(-1);
    expect(status?.lastSweep).toBeDefined();
    expect(status?.nextSweepAt).not.toBeNull();
    expect(Date.parse(status?.nextSweepAt ?? "")).toBeGreaterThan(
      Date.parse(status?.lastSweep?.endedAt ?? ""),
    );
    return status;
  };

  await first.start();
  expect(finished()).toMatchObject({
    nextSweepAt: new Date(epoch + 2 * SWEEP_MS + 1000).toISOString(),
    lastSweep: { outcome: "committed", endedAt: new Date(epoch + SWEEP_MS + 1000).toISOString() },
  });

  fail = true;
  await expect(first.sweep(false, true)).rejects.toThrow("gh failed");
  expect(finished()).toMatchObject({ lastSweep: { outcome: "failed" } });
  expect(first.progress?.nextAttemptAt).toBe(statuses.at(-1)?.nextSweepAt);
  expect(deadlines).toEqual([
    epoch + SWEEP_MS,
    epoch + 2 * SWEEP_MS + 1000,
    epoch + 3 * SWEEP_MS + 2000,
  ]);
});

it("reports the last sweep committed, failed and cancelled, and whether it was requested", async () => {
  let fail = false;
  let block = false;
  const { gate, read } = gated();
  const statuses: SweepSchedulerStatus[] = [];
  const first = service([], {
    onError: vi.fn(),
    onStatus: (status) => statuses.push(status),
    createSweeper: (options) =>
      new Sweeper({
        ...options,
        areas: [],
        cacheSchema,
        emptyCache,
        afterAreas: async () => {
          if (block) await read();
          vi.advanceTimersByTime(1500);
          if (fail) throw new ForgeError("gh failed", 503, "gateway");
        },
      }),
  });
  const last = () => statuses.filter((status) => status.lastSweep).at(-1)?.lastSweep;

  await first.start();
  expect(last()).toEqual({
    sweep: first.progress?.sweep,
    startedAt: new Date(epoch).toISOString(),
    endedAt: new Date(epoch + 1500).toISOString(),
    outcome: "committed",
    requested: false,
  });

  fail = true;
  await expect(first.sweep(false, true)).rejects.toThrow("gh failed");
  expect(last()).toEqual({
    sweep: first.progress?.sweep,
    startedAt: new Date(epoch + 1500).toISOString(),
    endedAt: new Date(epoch + 3000).toISOString(),
    outcome: "failed",
    code: "unavailable",
    requested: true,
  });

  fail = false;
  block = true;
  const running = first.sweep();
  const joined = first.sweep(false, true);
  expect(joined).toBe(running);
  await gate.open();
  await running;
  expect(last()).toMatchObject({ outcome: "committed", requested: true });

  const stopped = first.sweep();
  const rejected = expect(stopped).rejects.toThrow("Sweep service stopped");
  await vi.advanceTimersByTimeAsync(0);
  const stopping = first.stop();
  await gate.open();
  await stopping;
  await rejected;
  expect(statuses.at(-1)).toEqual({
    nextSweepAt: null,
    forceCooldownUntil: null,
    lastSweep: {
      sweep: first.progress?.sweep,
      startedAt: new Date(epoch + 4500).toISOString(),
      endedAt: new Date(epoch + 6000).toISOString(),
      outcome: "cancelled",
      requested: false,
    },
  });
});

type SourceEvent = Parameters<NonNullable<SweepServiceOptions["progress"]>>[0];

/** A real collector over one fork whose GitLab, Security and Releases reads are fresh. */
function fresh(remaining: number) {
  const at = new Date(epoch).toISOString();
  const stored = {
    facts: {
      ...emptyFacts(),
      upstream: { at, data: { partition: { service: "partition", commits: [] } } },
      radar: { at, data: { services: {}, filters: {} } },
      security: { at, data: {} },
    },
    cache: { ...emptyCache(), releases: { ...emptyCache().releases, at } },
    reads: {},
  };
  // GitLab API reads only; glab auth status runs on every sweep.
  const glab: string[] = [];
  // GitHub REST reads; GraphQL carries the budget itself.
  const gh: string[] = [];
  const outcomes = new Map<string, string>();
  const instance = service([], {
    ctx: createContext({
      fleet: fleetOf([
        { id: "partition", repo: "o/partition", upstream: "osdu/partition", seeded: "2026-01-01" },
      ]),
      clock: { now: () => new Date(Date.now()) },
    }),
    onError: vi.fn(),
    progress: (event: SourceEvent) => {
      if (event.kind !== "source" || event.state === "reading") return;
      outcomes.set(event.source, `${event.state}${"code" in event ? `:${event.code}` : ""}`);
    },
    createSweeper: (options) =>
      createSweeper({ ...options, persist: { ...options.persist, load: async () => stored } }),
    exec: {
      runJSON: async (cmd, args) => {
        if (cmd === "glab" && args[0] === "api") glab.push(args.join(" "));
        if (cmd === "gh" && args[0] === "api") gh.push(args.join(" "));
        return { ok: false, code: 1, error: "offline fixture" };
      },
      runText: async (cmd, args) => {
        if (cmd === "glab" && args[0] === "api") glab.push(args.join(" "));
        if (cmd === "gh" && args[0] === "api" && args[1] !== "graphql") gh.push(args.join(" "));
        if (cmd !== "gh" || args[1] !== "graphql") {
          return { ok: false, code: 1, error: "offline fixture" };
        }
        const resetAt = new Date(epoch + 3600_000).toISOString();
        return {
          ok: true,
          exitCode: 0,
          data: JSON.stringify({ data: { spicodeBudget: { cost: 1, remaining, resetAt } } }),
        };
      },
    },
  });
  const read = (sources: readonly string[]) => {
    const seen = Object.fromEntries(sources.map((source) => [source, outcomes.get(source)]));
    outcomes.clear();
    return seen;
  };
  return { instance, glab, gh, read };
}

const slow = ["upstream", "radar", "security", "releases"] as const;

it("Sweep now reads GitLab, Security and Releases sources that are not due; Try again skips them", async () => {
  const { instance, glab, read } = fresh(4000);
  await instance.start();
  read(slow);
  vi.setSystemTime(epoch + 1000);
  await instance.sweep(false, true);
  expect(read(slow)).toEqual({
    upstream: "skipped:cadence",
    radar: "skipped:cadence",
    security: "skipped:cadence",
    releases: "skipped:cadence",
  });
  expect(glab).toEqual([]);
  vi.setSystemTime(epoch + 2000);
  await instance.sweep(true, true);
  const forced = read(slow);
  for (const source of slow) expect(forced[source]).not.toMatch(/^skipped/);
  expect(glab.length).toBeGreaterThan(0);
});

it("Sweep now still defers a source the budget floor holds back", async () => {
  const { instance, read } = fresh(50);
  await instance.start();
  vi.setSystemTime(epoch + 1000);
  await instance.sweep(true, true);
  expect(read(slow)).toMatchObject({ security: "deferred:budget", releases: "deferred:budget" });
});

it("below the budget floor the first sweep shows core GitHub sources waiting, and later sweeps make no GitHub REST calls", async () => {
  const { instance, gh, read } = fresh(50);
  const core = ["github", "runs", "approvals", "lifecycle", "template"];
  const resumeAt = new Date(epoch + 3600_000).toISOString();
  await instance.start();
  const first = SweepProgressSchema.parse(instance.progress);
  expect(first).toMatchObject({ first: true, outcome: "committed" });
  for (const source of core) {
    expect(first.sources.find((entry) => entry.source === source)).toMatchObject({
      state: "deferred",
      code: "budget",
      resumeAt,
    });
  }
  expect(first.sources.find((entry) => entry.source === "auth")?.state).not.toBe("deferred");
  read(["auth"]);
  for (const [at, force] of [
    [1000, false],
    [2000, true],
  ] as const) {
    gh.length = 0;
    vi.setSystemTime(epoch + at);
    await instance.sweep(force, true);
    expect(gh).toEqual([]);
    expect(read(["auth", "fleet", ...core])).toEqual({
      auth: expect.not.stringMatching(/^deferred/),
      ...Object.fromEntries(["fleet", ...core].map((source) => [source, "deferred:budget"])),
    });
  }
});

it("drops force within the cooldown after a forced sweep ends, and when joining a running sweep", async () => {
  const { gate, read } = gated();
  const forces: boolean[] = [];
  const statuses: SweepSchedulerStatus[] = [];
  const first = service(
    [
      {
        name: "auth",
        read: async (input) => {
          forces.push(input.force);
          await vi.advanceTimersByTimeAsync(1000);
          return read();
        },
      },
    ],
    { ttlMs: 10 * SWEEP_MS, onStatus: (status) => statuses.push(status) },
  );
  const started = first.start();
  const joinedStartup = first.sweep(true, true);
  expect(joinedStartup).toBe(started);
  await gate.open();
  await started;
  expect(statuses.at(-1)?.forceCooldownUntil).toBeNull();
  const forced = first.sweep(true, true);
  await gate.open();
  await forced;
  const endedAt = Date.now();
  const cooldownUntil = endedAt + FORCE_COOLDOWN_MS;
  expect(statuses.at(-1)?.forceCooldownUntil).toBe(cooldownUntil);
  await vi.advanceTimersByTimeAsync(10_000);
  const again = first.sweep(true, true);
  await gate.open();
  await again;
  expect(statuses.at(-1)).toMatchObject({
    forceCooldownUntil: cooldownUntil,
    lastSweep: { outcome: "committed", requested: true },
  });
  const unforced = first.sweep();
  await gate.open();
  await unforced;
  expect(statuses.at(-1)).toMatchObject({
    forceCooldownUntil: cooldownUntil,
    lastSweep: { outcome: "committed", requested: false },
  });
  await vi.advanceTimersByTimeAsync(cooldownUntil - Date.now() - 1);
  expect(statuses.at(-1)?.forceCooldownUntil).toBe(cooldownUntil);
  const previous = statuses.length;
  await vi.advanceTimersByTimeAsync(1);
  expect(statuses).toHaveLength(previous + 1);
  expect(statuses.at(-1)?.forceCooldownUntil).toBeNull();
  const later = first.sweep(true, true);
  await gate.open();
  await later;
  expect(statuses.at(-1)?.forceCooldownUntil).toBe(Date.now() + FORCE_COOLDOWN_MS);
  vi.setSystemTime(Date.now() + FORCE_COOLDOWN_MS);
  const plain = first.sweep();
  const joined = first.sweep(true, true);
  expect(joined).toBe(plain);
  await gate.open();
  await plain;
  expect(statuses.at(-1)).toMatchObject({
    forceCooldownUntil: null,
    lastSweep: { requested: true },
  });
  expect(forces).toEqual([false, true, false, false, true, false]);
});

it.each(["failed", "cancelled"] as const)(
  "starts the force cooldown when a forced sweep is %s",
  async (outcome) => {
    let fail = false;
    const { gate, read } = gated();
    const statuses: SweepSchedulerStatus[] = [];
    const first = service([], {
      onStatus: (status) => statuses.push(status),
      createSweeper: (options) =>
        new Sweeper({
          ...options,
          areas: [],
          cacheSchema,
          emptyCache,
          afterAreas: async () => {
            if (!fail) return;
            await read();
            if (outcome === "failed") throw new ForgeError("gh failed", 503, "gateway");
          },
        }),
    });
    await first.start();
    fail = true;
    const running = first.sweep(true, true);
    const rejected = expect(running).rejects.toThrow(
      outcome === "failed" ? "gh failed" : "Sweep service stopped",
    );
    await vi.advanceTimersByTimeAsync(1500);
    const stopping = outcome === "cancelled" ? first.stop() : undefined;
    await gate.open();
    await stopping;
    await rejected;
    expect(statuses.at(-1)).toMatchObject({
      forceCooldownUntil: Date.now() + FORCE_COOLDOWN_MS,
      lastSweep: { outcome, requested: true, endedAt: new Date(Date.now()).toISOString() },
    });
    if (outcome === "failed") {
      await vi.advanceTimersByTimeAsync(FORCE_COOLDOWN_MS);
      expect(statuses.at(-1)?.forceCooldownUntil).toBeNull();
    }
    await first.stop();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("never promises an expired deadline when the cooldown timer follows a wall-clock jump", async () => {
  const statuses: SweepSchedulerStatus[] = [];
  const first = service([], {
    ttlMs: 10 * SWEEP_MS,
    onStatus: (status) => statuses.push(status),
  });
  await first.start();
  await first.sweep(true, true);
  vi.setSystemTime(epoch + SWEEP_MS);
  await vi.advanceTimersByTimeAsync(FORCE_COOLDOWN_MS);
  expect(statuses.at(-1)).toEqual({ nextSweepAt: null, forceCooldownUntil: null });
});

it("expires cooldown during a requested sweep without moving its timer from the sweep's end", async () => {
  const { gate, read } = gated();
  const statuses: SweepSchedulerStatus[] = [];
  const first = service([{ name: "auth", read }], {
    onStatus: (status) => statuses.push(status),
  });
  const started = first.start();
  await gate.open();
  await started;
  const forced = first.sweep(true, true);
  await gate.open();
  await forced;
  await vi.advanceTimersByTimeAsync(FORCE_COOLDOWN_MS - 1);
  const requested = first.sweep(true, true);
  await vi.advanceTimersByTimeAsync(1);
  expect(statuses.at(-1)).toEqual({ nextSweepAt: null, forceCooldownUntil: null });
  await vi.advanceTimersByTimeAsync(2000);
  await gate.open();
  await requested;
  expect(statuses.at(-1)).toMatchObject({
    forceCooldownUntil: null,
    nextSweepAt: new Date(Date.now() + SWEEP_MS).toISOString(),
    lastSweep: { outcome: "committed", requested: true },
  });
});

it("restarts the timer from the end of a requested sweep and never reports an expired next sweep", async () => {
  const { deadlines, timers } = scheduled();
  const reads: number[] = [];
  const statuses: SweepSchedulerStatus[] = [];
  const first = service(
    [
      {
        name: "auth",
        read: async () => {
          reads.push(Date.now());
          await vi.advanceTimersByTimeAsync(3000);
          return { data: auth, reads: [] };
        },
      },
    ],
    { timers, ttlMs: 10 * SWEEP_MS, onStatus: (status) => statuses.push(status) },
  );
  await first.start();
  await vi.advanceTimersByTimeAsync(100_000);
  await first.sweep(true, true);
  const end = epoch + 106_000;
  expect(deadlines).toEqual([epoch + SWEEP_MS, end + SWEEP_MS]);
  const last = statuses.at(-1);
  expect(last).toMatchObject({
    nextSweepAt: new Date(end + SWEEP_MS).toISOString(),
    lastSweep: { requested: true, endedAt: new Date(end).toISOString() },
  });
  await vi.advanceTimersByTimeAsync(epoch + SWEEP_MS - Date.now() + 1000);
  expect(reads).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(end + SWEEP_MS - Date.now());
  expect(reads).toEqual([epoch, epoch + 103_000, end + SWEEP_MS]);
  for (const status of statuses) {
    if (status.nextSweepAt === null || !status.lastSweep) continue;
    expect(Date.parse(status.nextSweepAt)).toBeGreaterThan(Date.parse(status.lastSweep.endedAt));
  }
});
