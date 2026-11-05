// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  cacheSchema,
  createContext,
  createSweeper,
  type Exec,
  emptyCache,
  type Facts,
  fleetOf,
  INFLIGHT_POLL_MS,
  SWEEP_MS,
  type SweepArea,
  Sweeper,
  type SweepInput,
} from "@spi-code/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLeaseStore } from "../store/leases.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { openRunStore } from "../store/store.js";
import { DAY_MS, SweepService, type SweepServiceOptions } from "./service.js";

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

it("renews at ttl/3, excludes a second service and schedules full sweeps at SWEEP_MS", async () => {
  const read = vi.fn(async () => ({ data: auth, reads: [] }));
  const after = vi.fn((ms: number, callback: () => void) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  });
  const first = service([{ name: "auth", read }], { timers: { after } });
  const second = service([{ name: "auth", read }]);
  expect(await first.start()).toBe(true);
  expect(await second.start()).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(after).toHaveBeenCalledWith(1000, expect.any(Function));
  expect(db.prepare("SELECT expires_at FROM leases").get()?.expires_at).toBe(epoch + 4000);
  await vi.advanceTimersByTimeAsync(SWEEP_MS - 1000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(first.latest()?.cursor).toBe(2);
  expect(budgets()).toHaveLength(2);
  await first.stop();
  expect(await second.sweep()).toBe(true);
  expect(second.latest()?.cursor).toBe(3);
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

it("prunes daily on the injected clock, retaining seven days and each fleet's latest snapshot", async () => {
  const leases = createLeaseStore(db);
  const snapshots = createSnapshotStore(db);
  const old = epoch - 8 * DAY_MS;
  leases.acquire("old", "writer", 100, old);
  const lease = { fleet: "old", owner: "writer", fence: 1 };
  snapshots.writeSnapshot(lease, {}, {}, old);
  snapshots.writeSnapshot(lease, {}, {}, old + 1);
  const first = service([], { intervalMs: 2 * DAY_MS, ttlMs: 3 * DAY_MS });
  await first.start();
  await vi.advanceTimersByTimeAsync(DAY_MS - 1);
  expect(snapshots.snapshotsSince(0)).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(snapshots.snapshotsSince(0).map((row) => row.cursor)).toEqual([2, 3]);
  await first.stop();
  await vi.advanceTimersByTimeAsync(DAY_MS);
  expect(vi.getTimerCount()).toBe(0);
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
