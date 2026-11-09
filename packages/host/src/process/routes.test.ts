// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AREAS,
  type InspectResult,
  InspectResultSchema,
  type LastSweep,
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  SweepProgressSchema,
  SweepStatusSchema,
  type ViewSnapshot,
  type WatchBriefing,
  type WatchItem,
} from "@spi-code/contracts";
import {
  BudgetPacer,
  buildModel,
  type CollectorOptions,
  cacheSchema,
  type createSweeper,
  type Exec,
  emptyCache,
  type Facts,
  type InspectOptions,
  type ItemClass,
  inspectRepo,
  inspectStep,
  inspectUpstreamFork,
  inspectUpstreamPlan,
  interruptCount,
  type QueueItem,
  REPO_PREFIX,
  STEP_PREFIX,
  Sweeper,
  UPSTREAM_PREFIX,
} from "@spi-code/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mrBoard } from "../../../core/src/inspect/mr.js";
import { createLeaseStore } from "../store/leases.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { openRunStore } from "../store/store.js";
import { SweepService } from "../sweep/service.js";
import { emptySweepStatus, SWEEP_SCHEDULE } from "../sweep/status.js";
import { projectReleases, projectWatch } from "../watch/project.js";
import { fixtureInput, oracle } from "../watch/snapshot-fixture.js";
import { attachHostPort, type HostPort } from "./port.js";
import {
  inspectResult,
  upstreamForkResult,
  upstreamPlanResult,
  WatchRoutes,
  watchFleet,
} from "./routes.js";

const input = fixtureInput();
const ctx = input.context;
const fleet = watchFleet(ctx);
const now = ctx.clock.now().getTime();
const resetAt = "2026-01-01T01:00:00.000Z";

let directory: string;
let path: string;
let db: DatabaseSync;
let calls: number;
const failing: Exec = {
  runJSON: async () => {
    calls += 1;
    return { ok: false, error: "offline", code: 1 };
  },
  runText: async () => {
    calls += 1;
    return { ok: false, error: "offline", code: 1 };
  },
};

beforeEach(() => {
  calls = 0;
  fence = undefined;
  directory = mkdtempSync(join(tmpdir(), "spi-routes-"));
  path = join(directory, "store.sqlite");
  openRunStore(path).close();
  db = new DatabaseSync(path);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

let fence: number | undefined;

type StoredView = Omit<ViewSnapshot, "cursor">;

function writeSnapshot(
  remaining = 4321.5,
  floor?: number,
  areas = projectWatch(input).areas,
  edit: (view: StoredView) => StoredView = (view) => view,
): number {
  fence ??= createLeaseStore(db).acquire(fleet, "sweeper", 60_000, now);
  if (fence === undefined) throw new Error("lease not acquired");
  const { cursor: _, ...projected } = projectWatch(input);
  const view = edit(projected);
  return createSnapshotStore(db).writeSnapshot(
    { fleet, owner: "sweeper", fence },
    {
      facts: input.facts,
      cache: {
        ...emptyCache(),
        releases: { ...input.releases, records: input.releaseRecords },
        budget: {
          cost: 1,
          remaining,
          ...(floor === undefined ? {} : { floor }),
          resetAt,
          calls: 3,
          deferred: [{ area: "security", reason: "budget" }],
        },
      },
      reads: {},
    },
    { ...view, areas },
    now,
  );
}

function host(watch: WatchRoutes, reject: (message: Message) => boolean = () => false) {
  const sent: Message[] = [];
  let receive: (event: { data: unknown }) => void = () => {
    throw new Error("Port not attached");
  };
  const port: HostPort = {
    on(_event, listener) {
      receive = listener;
    },
    postMessage(message) {
      const parsed = parseMessage(message);
      if (!parsed.ok) throw new Error("host posted an invalid message");
      if (reject(parsed.message)) throw new Error("port closed");
      sent.push(parsed.message);
    },
    start() {},
  };
  attachHostPort(port, 1, undefined, undefined, watch.routes);
  return {
    sent,
    request(type: string, payload: unknown, id = "req") {
      receive({ data: { version: PROTOCOL_VERSION, id, kind: "request", type, payload } });
    },
  };
}

async function settle() {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function routes(database: () => DatabaseSync = () => db) {
  return new WatchRoutes({
    db: database,
    fleet,
    ctx,
    appData: input.appData,
    exec: failing,
    onError: (error) => {
      throw error;
    },
  });
}

describe("view.subscribe", () => {
  it("ignores stale service progress and gives every update and replay a distinct event id", async () => {
    const watch = routes();
    const port = host(watch);
    port.request("view.subscribe", { fromCursor: 0 });
    await settle();
    const old = {
      sweep: "old-service",
      startedAt: new Date(now).toISOString(),
      first: true,
      usualMs: null,
      sources: [],
      outcome: "running" as const,
      nextAttemptAt: null,
    };
    const current = { ...old, sweep: "new-service", startedAt: new Date(now + 1000).toISOString() };
    watch.publishProgress(old);
    watch.publishProgress(current);
    watch.publishProgress({ ...old, outcome: "cancelled" });
    const late = host(watch);
    late.request("view.subscribe", { fromCursor: 0 });
    await settle();
    expect(late.sent.find(({ type }) => type === "sweep.progress")?.payload).toEqual(current);
    watch.publishProgress({ ...current, outcome: "committed" });
    const events = [...port.sent, ...late.sent].filter(({ type }) => type === "sweep.progress");
    expect(events.map(({ payload }) => SweepProgressSchema.parse(payload).outcome)).toEqual([
      "running",
      "running",
      "running",
      "committed",
    ]);
    expect(new Set(events.map(({ id }) => id)).size).toBe(events.length);
  });

  it("replays the latest unsent progress immediately, coalesces Try again and keeps snapshot delivery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finish = () => {};
    const read = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        data: { gh: { ok: true, detail: "ready" }, glab: { ok: true, detail: "ready" } },
        reads: [],
      };
    });
    const forces: boolean[] = [];
    const watch = new WatchRoutes({
      db: () => db,
      fleet,
      ctx,
      appData: directory,
      exec: failing,
      onError: vi.fn(),
      requestSweep: () => sweep.sweep(),
      sweepProgress: () => sweep.progress,
    });
    const sweep = new SweepService({
      db,
      fleet,
      ctx,
      exec: failing,
      appData: directory,
      factsSchema: z.custom<Facts>(),
      doctor: () => input.doctor,
      onError: vi.fn(),
      onProgress: (progress) => watch.publishProgress(progress),
      createSweeper: watch.sweeper(
        (options) =>
          new Sweeper({
            ...options,
            cacheSchema,
            emptyCache,
            areas: [
              {
                name: "auth",
                read: async (input) => {
                  forces.push(input.force);
                  return read();
                },
              },
            ],
          }),
      ),
    });
    try {
      const first = host(watch);
      first.request("view.subscribe", { fromCursor: 0 });
      await settle();
      const running = sweep.start();
      await settle();
      expect(first.sent.filter(({ type }) => type === "sweep.progress")).toMatchObject([
        { payload: { sources: expect.arrayContaining([{ source: "auth", state: "waiting" }]) } },
      ]);
      const late = host(watch);
      late.request("view.subscribe", { fromCursor: 0 });
      late.request("sweep.request", {}, "try-one");
      late.request("sweep.request", {}, "try-two");
      await settle();
      const replay = late.sent.find(({ type }) => type === "sweep.progress");
      expect(SweepProgressSchema.parse(replay?.payload)).toEqual(sweep.progress);
      expect(replay).toMatchObject({
        payload: {
          sources: expect.arrayContaining([
            { source: "auth", state: "reading", startedAt: ctx.clock.now().toISOString() },
          ]),
        },
      });
      expect(read).toHaveBeenCalledOnce();
      expect(forces).toEqual([false]);
      finish();
      await running;
      await settle();
      expect(late.sent.filter(({ type }) => type === "view.snapshot")).toHaveLength(1);
      expect(late.sent.filter(({ type }) => type === "sweep.status")).toMatchObject([
        { id: expect.stringMatching(/^sweep-status-replay-/), payload: { remaining: null } },
        { id: expect.stringMatching(/^sweep-status-\d+$/) },
      ]);
      expect(late.sent.filter(({ type }) => type === "error")).toEqual([]);
      expect(read).toHaveBeenCalledOnce();
      const current = host(watch);
      current.request("view.subscribe", { fromCursor: sweep.latest()?.cursor });
      await settle();
      expect(current.sent.find(({ type }) => type === "sweep.progress")).toMatchObject({
        payload: { outcome: "committed" },
      });
      expect(current.sent.filter(({ type }) => type === "view.snapshot")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      finish();
      await sweep.stop();
      vi.useRealTimers();
    }
  });

  it("exposes the latest persisted budget floor and deferrals before a window subscribes", () => {
    const watch = routes();
    expect(watch.status).toEqual(emptySweepStatus());
    writeSnapshot(4321, 75);
    expect(watch.status).toEqual({
      ...emptySweepStatus(),
      remaining: 4321,
      resetAt,
      floor: 75,
      deferredAreas: [{ area: "security", reason: "budget" }],
    });
    writeSnapshot(1234, 125);
    expect(watch.status).toEqual({
      ...emptySweepStatus(),
      remaining: 1234,
      resetAt,
      floor: 125,
      deferredAreas: [{ area: "security", reason: "budget" }],
    });
    expect(calls).toBe(0);
  });
  it.each([1234, 0, undefined])(
    "publishes the configured pacer floor %s on every sweep status, including replay",
    async (floor) => {
      const watch = routes();
      const port = host(watch);
      port.request("view.subscribe", { fromCursor: 0 });
      await settle();
      const budgetResetAt = new Date(now + 3600_000).toISOString();
      const service = new SweepService({
        db,
        fleet,
        ctx,
        exec: {
          ...failing,
          runText: async (cmd, args, options) =>
            args[1] === "graphql"
              ? {
                  ok: true,
                  data: JSON.stringify({
                    data: {
                      spicodeBudget: { cost: 1, remaining: 1000, resetAt: budgetResetAt },
                    },
                  }),
                }
              : failing.runText(cmd, args, options),
        },
        appData: directory,
        factsSchema: z.custom<Facts>(),
        ...(floor === undefined ? {} : { pacer: new BudgetPacer({ floor, resetBudget: 5000 }) }),
        doctor: () => input.doctor,
        onError: (error) => {
          throw error;
        },
        createSweeper: watch.sweeper(),
      });
      const plan = vi.spyOn(service.pacer, "plan");
      try {
        await service.start();
        await service.sweep(true);
        expect(plan).toHaveBeenCalled();
      } finally {
        await service.stop();
        plan.mockRestore();
      }
      const replay = host(routes());
      replay.request("view.subscribe", { fromCursor: 0 });
      await settle();
      const [initial, ...statuses] = [...port.sent, ...replay.sent].filter(
        (message) => message.type === "sweep.status",
      );
      expect(initial?.payload).toEqual(emptySweepStatus());
      expect(statuses).toHaveLength(3);
      for (const status of statuses) {
        expect(SweepStatusSchema.parse(status.payload)).toMatchObject({
          floor: floor ?? service.pacer.floor,
          resetAt: budgetResetAt,
        });
      }
    },
  );

  it.each([100.5, -1])(
    "omits invalid stored floor %s without losing budget or inspectable facts",
    async (floor) => {
      writeSnapshot(4321.5, floor);
      const item = buildModel(input.facts, ctx.clock.now(), {}, ctx).queue.items[0];
      if (!item) throw new Error("Fixture must have an inspectable queue item");
      const port = host(routes());
      port.request("view.subscribe", { fromCursor: 0 });
      port.request("inspect.request", { id: item.id }, "inspect-floor");
      await settle();
      const status = port.sent.find((message) => message.type === "sweep.status");
      expect(status).toMatchObject({
        payload: {
          remaining: 4321,
          resetAt,
          deferredAreas: [{ area: "security", reason: "budget" }],
        },
      });
      expect(status?.payload).not.toHaveProperty("floor");
      expect(port.sent.find((message) => message.id === "inspect-floor")).toMatchObject({
        type: "inspect.result",
        payload: { id: item.id },
      });
    },
  );

  it("serves a fresh host the last persisted snapshot and cursor without reading the network", async () => {
    const cursor = writeSnapshot();
    db.close();
    db = new DatabaseSync(path);
    const port = host(routes());
    port.request("view.subscribe", { fromCursor: 0 });
    await settle();
    const { cursor: _, ...stored } = projectWatch(input);
    expect(port.sent.map((m) => m.type)).toEqual(["host.hello", "view.snapshot", "sweep.status"]);
    expect(port.sent[1]).toMatchObject({
      kind: "event",
      payload: { ...stored, cursor, seen: { cursor, since: [] } },
    });
    expect(port.sent[2]).toMatchObject({
      payload: {
        remaining: 4321,
        resetAt,
        deferredAreas: [{ area: "security", reason: "budget" }],
      },
    });
    expect(calls).toBe(0);
  });

  describe("additive Watch inspect targets", () => {
    it("resolves every projected station, service run and repository-line id after reopening", async () => {
      writeSnapshot();
      db.close();
      db = new DatabaseSync(path);
      const snapshot = projectWatch(input);
      const targets = [
        ...snapshot.stations.flatMap((service) => [
          ...service.stations.map((station) => ({
            id: station.inspect,
            title: undefined,
            text: undefined,
          })),
        ]),
        ...(snapshot.services ?? []).flatMap((service) =>
          service.runs.map((run) => ({
            id: run.id,
            title: undefined,
            text: undefined,
          })),
        ),
        ...snapshot.briefing.repositories.rows.flatMap((repo) =>
          repo.sections.flatMap((section) =>
            section.lines.map((line) => ({
              id: line.id,
              title: line.text,
              text: line.sub,
            })),
          ),
        ),
      ];
      const port = host(routes());
      for (const [i, target] of targets.entries()) {
        expect(target.id).toBeTruthy();
        port.request("inspect.request", { id: target.id }, `added-${i}`);
      }
      await settle();
      for (const [i, target] of targets.entries()) {
        const response = port.sent.find((message) => message.id === `added-${i}`);
        expect(response).toMatchObject({ type: "inspect.result", payload: { id: target.id } });
        const result = InspectResultSchema.parse(response?.payload);
        expect(result.title).toBeTruthy();
        expect(result.areas).toEqual(snapshot.areas);
        if (target.title) {
          expect(result.title).toBe(target.title);
          expect(result.effect).toBe(target.text);
          expect(result.related.some((row) => row.url)).toBe(true);
        }
      }
      expect(calls).toBe(0);
    });

    async function inspectStations(ids: string[]): Promise<Map<string, InspectResult>> {
      writeSnapshot();
      const port = host(routes());
      for (const id of ids) port.request("inspect.request", { id }, id);
      await settle();
      return new Map(
        ids.map((id) => [
          id,
          InspectResultSchema.parse(port.sent.find((message) => message.id === id)?.payload),
        ]),
      );
    }

    it("gives each line station its own reading, its own facts and the fork's upstream", async () => {
      const results = await inspectStations([
        "station:legal:upstream",
        "station:legal:sync",
        "station:legal:cascade",
        "station:legal:main",
        "station:entitlements:sync",
      ]);
      expect(results.get("station:legal:upstream")).toMatchObject({
        title: "legal · Upstream",
        cause: "4 behind · in the sync PR · Java 25 queued",
        effect: "waiting",
      });
      const sync = results.get("station:legal:sync");
      expect(sync).toMatchObject({
        title: "legal · Sync PR",
        cause: "PR #31 red",
        effect: "stopped",
      });
      expect(sync?.related).toContainEqual(
        expect.objectContaining({ state: "Sync PR", text: expect.stringMatching(/^#31 /) }),
      );
      expect(results.get("station:legal:cascade")).toMatchObject({
        title: "legal · Cascade",
        cause: "idle",
        effect: "idle",
        class: "READY",
      });
      expect(results.get("station:legal:main")).toMatchObject({
        title: "legal · Main",
        cause: "idle",
        effect: "idle",
      });
      expect(results.get("station:entitlements:sync")).toMatchObject({
        cause: "halted: UNKNOWN_TOP_LEVEL",
        class: "HALT",
      });
      expect(results.get("station:entitlements:sync")?.related).toContainEqual(
        expect.objectContaining({ state: "Sync PR", inspect: "halt:entitlements" }),
      );
      for (const result of results.values()) {
        expect(result.related).toContainEqual(
          expect.objectContaining({
            state: "Upstream",
            inspect: `upstream:${result.id.split(":")[1]}`,
          }),
        );
      }
      expect(calls).toBe(0);
    });

    it("projects the recorded legal station readings the window's Detail tests replay", async () => {
      const ids = ["upstream", "sync", "cascade", "main"].map((id) => `station:legal:${id}`);
      const recorded = readFileSync(
        new URL("../../../../fixtures/watch/inspect-stations-legal-59d6895.json", import.meta.url),
        "utf8",
      );
      expect([...(await inspectStations(ids)).values()]).toEqual(JSON.parse(recorded));
    });

    it("never shows the cascade's cause on a clean Sync PR station", async () => {
      const repo = input.facts.github.data?.repos["Azure/osdu-spi-partition"];
      if (!repo) throw new Error("fixture lost partition");
      const conflict = {
        repo: repo.repo,
        number: 77,
        title: "Cascade conflict in pom.xml",
        url: "https://github.com/Azure/osdu-spi-partition/issues/77",
        createdAt: "2026-10-12T00:00:00Z",
        updatedAt: "2026-10-12T00:00:00Z",
        labels: ["conflict"],
        comments: 0,
      };
      repo.issues.push(conflict);
      try {
        const results = await inspectStations([
          "station:partition:sync",
          "station:partition:cascade",
        ]);
        const sync = results.get("station:partition:sync");
        expect(sync).toMatchObject({ cause: "clean", effect: "idle", class: "READY", why: "" });
        expect(JSON.stringify(sync)).not.toContain(conflict.title);
        const cascade = results.get("station:partition:cascade");
        expect(cascade).toMatchObject({ cause: "conflict", effect: "stopped", class: "CONFLICT" });
        expect(cascade?.why).toContain(conflict.title);
        expect(cascade?.related).toContainEqual(
          expect.objectContaining({ state: "Conflict issue", url: conflict.url }),
        );
      } finally {
        repo.issues.pop();
      }
    });

    it.each([
      "station:legal:lead",
      "station:legal:release:extra",
      "station:missing:lane",
      "station:Legal:lane",
      "pr:missing:1",
      "issue:missing:1",
      "alert:missing:1",
    ])("rejects unknown or noncanonical target %s", async (id) => {
      writeSnapshot();
      const port = host(routes());
      port.request("inspect.request", { id });
      await settle();
      expect(port.sent[1]).toMatchObject({ type: "error", payload: { code: "not_found" } });
      expect(calls).toBe(0);
    });
  });

  it("sends an old cursor the latest snapshot and the current cursor nothing until the next sweep", async () => {
    writeSnapshot();
    const latest = writeSnapshot(100);
    const watch = routes();
    const old = host(watch);
    old.request("view.subscribe", { fromCursor: latest - 1 });
    await settle();
    expect(old.sent.filter((m) => m.type === "view.snapshot")).toMatchObject([
      { payload: { cursor: latest } },
    ]);

    const current = host(watch);
    current.request("view.subscribe", { fromCursor: latest });
    await settle();
    expect(current.sent.map((m) => m.type)).toEqual(["host.hello", "sweep.status"]);
    expect(current.sent[1]?.payload).toEqual({ ...watch.status, remaining: 100 });
    watch.publish();
    expect(current.sent.map((m) => m.type)).toEqual(["host.hello", "sweep.status"]);

    let sweep: CollectorOptions | undefined;
    const create = watch.sweeper((options) => {
      sweep = options;
      return {} as ReturnType<typeof createSweeper>;
    });
    create({ persist: { load: () => undefined, save: async () => {} } } as never);
    const next = writeSnapshot(50);
    await sweep?.persist.save({} as never);
    expect(current.sent.slice(2)).toMatchObject([
      { type: "view.snapshot", payload: { cursor: next } },
      { type: "sweep.status", payload: { remaining: 50 } },
    ]);
    expect(old.sent.filter((m) => m.type === "view.snapshot")).toHaveLength(1);
  });

  it("keeps the cursor when the sweep status send fails, so the next publish resends", async () => {
    const cursor = writeSnapshot();
    const watch = routes();
    let closed = true;
    const port = host(watch, (m) => closed && m.type === "sweep.status");
    port.request("view.subscribe", { fromCursor: 0 });
    await settle();
    expect(port.sent.map((m) => m.type)).toEqual(["host.hello", "view.snapshot", "error"]);
    closed = false;
    watch.publish();
    expect(port.sent.slice(3)).toMatchObject([
      { type: "view.snapshot", payload: { cursor } },
      { type: "sweep.status" },
    ]);
  });

  it("does not open the store until a request needs it", async () => {
    let opened = 0;
    const port = host(
      routes(() => {
        opened += 1;
        return db;
      }),
    );
    expect(opened).toBe(0);
    port.request("view.subscribe", { fromCursor: 0 });
    await settle();
    expect(opened).toBe(1);
    expect(port.sent.map((m) => m.type)).toEqual(["host.hello", "sweep.status"]);
  });

  it("replays the schedule and last sweep to a current subscriber and sends every transition", async () => {
    const latest = writeSnapshot(100);
    const watch = routes();
    const failed: LastSweep = {
      sweep: "sweep-2",
      startedAt: "2026-11-08T15:05:00.000Z",
      endedAt: "2026-11-08T15:05:03.000Z",
      outcome: "failed",
      code: "signin",
      requested: true,
    };
    watch.publishStatus({ nextSweepAt: "2026-11-08T15:10:00.000Z", lastSweep: failed });
    watch.publishStatus({
      nextSweepAt: "2026-11-08T15:10:00.000Z",
      lastSweep: { ...failed, sweep: "sweep-1", startedAt: "2026-11-08T15:00:00.000Z" },
    });
    const port = host(watch);
    port.request("view.subscribe", { fromCursor: latest });
    await settle();
    const live = {
      remaining: 100,
      nextSweepAt: "2026-11-08T15:10:00.000Z",
      schedule: SWEEP_SCHEDULE,
      lastSweep: failed,
    };
    expect(port.sent.slice(1)).toMatchObject([{ type: "sweep.status", payload: live }]);
    expect(SweepStatusSchema.parse(port.sent[1]?.payload)).toEqual(port.sent[1]?.payload);

    watch.publishStatus({ nextSweepAt: null });
    expect(port.sent.slice(2)).toMatchObject([
      { type: "sweep.status", payload: { ...live, nextSweepAt: null } },
    ]);
    const next = writeSnapshot(50);
    watch.publish();
    expect(port.sent.slice(3)).toMatchObject([
      { type: "view.snapshot", payload: { cursor: next } },
      { type: "sweep.status", payload: { ...live, remaining: 50, nextSweepAt: null } },
    ]);
    expect(watch.status).toMatchObject({ remaining: 50, nextSweepAt: null, lastSweep: failed });
  });

  it("replays a snapshot, then progress, then the status it settles, as they went live", async () => {
    const watch = routes();
    const replay = async (fromCursor = 0) => {
      const port = host(watch);
      port.request("view.subscribe", { fromCursor });
      await settle();
      return port.sent;
    };
    const running = {
      sweep: "sweep-1",
      startedAt: new Date(now).toISOString(),
      first: true,
      usualMs: null,
      sources: [],
      outcome: "running" as const,
      nextAttemptAt: null,
    };
    watch.publishProgress(running);
    watch.publishStatus({ nextSweepAt: null });
    const midSweep = await replay();
    expect(midSweep.map(({ type }) => type)).toEqual([
      "host.hello",
      "sweep.progress",
      "sweep.status",
    ]);
    expect(midSweep.slice(1)).toMatchObject([
      { payload: { outcome: "running" } },
      { payload: { nextSweepAt: null, lastSweep: null } },
    ]);

    const nextSweepAt = new Date(now + 300_000).toISOString();
    const lastSweep: LastSweep = {
      sweep: "sweep-1",
      startedAt: running.startedAt,
      endedAt: new Date(now + 3000).toISOString(),
      outcome: "failed",
      code: "signin",
      requested: false,
    };
    watch.publishProgress({
      ...running,
      outcome: "failed",
      code: "signin",
      failure: "GitHub is not signed in",
      nextAttemptAt: nextSweepAt,
    });
    watch.publishStatus({ nextSweepAt, lastSweep });
    const failed = await replay();
    expect(failed.map(({ type }) => type)).toEqual([
      "host.hello",
      "sweep.progress",
      "sweep.status",
    ]);
    expect(failed.slice(1)).toMatchObject([
      { payload: { outcome: "failed" } },
      { payload: { nextSweepAt, lastSweep } },
    ]);

    const cursor = writeSnapshot();
    expect((await replay()).map(({ type }) => type)).toEqual([
      "host.hello",
      "view.snapshot",
      "sweep.progress",
      "sweep.status",
    ]);
    expect((await replay(cursor)).map(({ type }) => type)).toEqual([
      "host.hello",
      "sweep.progress",
      "sweep.status",
    ]);
  });
});

describe("view.acknowledge", () => {
  const items = (briefing: WatchBriefing) => [...briefing.focus, ...briefing.rest];
  const withBriefing =
    (added: WatchItem[], edit: (item: WatchItem) => WatchItem = (item) => item) =>
    (view: StoredView): StoredView => ({
      ...view,
      briefing: {
        ...view.briefing,
        focus: [...view.briefing.focus.map(edit), ...added.map(edit)],
        rest: view.briefing.rest.map(edit),
      },
    });
  const p0 = (view: ViewSnapshot) => {
    const item = items(view.briefing).find((i) => i.attention === "interrupt");
    if (!item) throw new Error("fixture must have an Interrupt item");
    return item;
  };
  const write = (edit: (view: StoredView) => StoredView) =>
    writeSnapshot(undefined, undefined, undefined, edit);

  async function subscribe(watch = routes()) {
    const port = host(watch);
    port.request("view.subscribe", { fromCursor: 0 });
    await settle();
    const last = port.sent.filter((m) => m.type === "view.snapshot").at(-1);
    if (last?.type !== "view.snapshot") throw new Error("no snapshot pushed");
    return {
      port,
      view: last.payload,
      acknowledge: async (cursor: number) => {
        port.request("view.acknowledge", { cursor }, `ack-${cursor}`);
        await settle();
      },
    };
  }

  it("is quiet on first sight and keeps the baseline across a restart", async () => {
    const first = writeSnapshot();
    const sight = await subscribe();
    expect(sight.view.seen).toEqual({ cursor: first, since: [], at: new Date(now).toISOString() });
    const arrived = { ...p0(sight.view), id: "halt:legal", ids: ["halt:legal"] };
    const second = write(withBriefing([arrived]));
    const before = await subscribe();
    expect(before.view.seen).toMatchObject({ cursor: first, since: ["halt:legal"] });
    const sent = before.port.sent.length;
    await before.acknowledge(second);
    expect(before.port.sent).toHaveLength(sent);

    db.close();
    db = new DatabaseSync(path);
    const third = write(withBriefing([arrived]));
    const after = await subscribe();
    expect(after.view.cursor).toBe(third);
    expect(after.view.seen).toEqual({
      cursor: second,
      since: [],
      at: new Date(now).toISOString(),
    });
  });

  it("reports a new Interrupt, a P1 turned P0 and a P0 that spread as arrived", async () => {
    const watch = routes();
    const first = writeSnapshot();
    const start = await subscribe(watch);
    await start.acknowledge(first);
    const fresh = p0(start.view);
    const arrived = { ...fresh, id: "halt:legal", ids: ["halt:legal"], title: "Legal halted" };
    const second = write(withBriefing([arrived]));
    const added = await subscribe(watch);
    expect(added.view.seen).toMatchObject({ cursor: first, since: ["halt:legal"] });

    await added.acknowledge(second);
    const surface = items(added.view.briefing).find((i) => i.rung === 1);
    if (!surface) throw new Error("fixture must have a P1 item");
    write(
      withBriefing([arrived], (item) =>
        item.id === fresh.id
          ? { ...item, ids: [...item.ids, "halt:partition"] }
          : item.id === surface.id
            ? { ...item, rung: 0, attention: "interrupt" }
            : item,
      ),
    );
    expect((await subscribe(watch)).view.seen).toMatchObject({
      cursor: second,
      since: [fresh.id, surface.id],
    });
  });

  it("ignores an older or unknown cursor, so the baseline never moves back", async () => {
    const watch = routes();
    const first = writeSnapshot();
    const fresh = p0((await subscribe(watch)).view);
    const second = write(withBriefing([{ ...fresh, id: "halt:legal" }]));
    const current = await subscribe(watch);
    await current.acknowledge(second);
    await current.acknowledge(first);
    await current.acknowledge(second + 100);
    const after = await subscribe(watch);
    expect(after.view.seen).toMatchObject({ cursor: second, since: [] });
    expect(current.port.sent.filter((m) => m.type === "error")).toEqual([]);
  });

  it("never clears a stopped station or lowers the Interrupt count", async () => {
    const watch = routes();
    const first = writeSnapshot();
    const fresh = p0((await subscribe(watch)).view);
    const second = write(withBriefing([{ ...fresh, id: "halt:legal", ids: ["halt:legal"] }]));
    const before = await subscribe(watch);
    expect(before.view.seen).toMatchObject({ cursor: first, since: ["halt:legal"] });
    const stopped = before.view.stations.flatMap((s) =>
      s.stations.filter((station) => station.substate === "stopped"),
    );
    expect(stopped.length).toBeGreaterThan(0);
    const count = interruptCount(items(before.view.briefing));
    expect(count).toBeGreaterThan(0);
    await before.acknowledge(second);
    const after = await subscribe(routes());
    expect(after.view.cursor).toBe(second);
    expect(after.view.seen).toMatchObject({ cursor: second, since: [] });
    expect(after.view.stations).toEqual(before.view.stations);
    expect(after.view.briefing).toEqual(before.view.briefing);
    expect(interruptCount(items(after.view.briefing))).toBe(count);
  });
});

describe("inspect.request", () => {
  const model = buildModel(input.facts, ctx.clock.now(), {}, ctx);
  const areas = projectWatch(input).areas;
  const steps = model.template.steps.map((step) => `${STEP_PREFIX}${step.marker}`);
  const documents = projectReleases(input.releases, input.appData, ctx.clock.now(), ctx).documents;

  it("inspects every non-queue MR id from the persisted fixture sweep", async () => {
    const ids = Object.entries(model.radar.services).flatMap(([fork, service]) =>
      [...new Set(service.possible.flatMap((v) => (v.mr ? [v.mr.iid] : [])))].map(
        (iid) => `mr:${fork}:${iid}`,
      ),
    );
    expect(ids.length).toBeGreaterThan(0);
    const storedAreas = areas.map(({ area }) => ({
      area,
      envelope: { source: area, state: "unread" as const },
    }));
    writeSnapshot(undefined, undefined, storedAreas);
    db.close();
    db = new DatabaseSync(path);
    const port = host(routes());
    for (const id of ids) {
      expect(model.queue.items.some((item) => item.id === id)).toBe(false);
      port.request("inspect.request", { id }, id);
    }
    await settle();
    for (const id of ids) {
      const response = port.sent.find((message) => message.id === id);
      expect(response, id).toMatchObject({ type: "inspect.result", payload: { id } });
      const result = InspectResultSchema.parse(response?.payload);
      expect(result.areas).toEqual(storedAreas);
      expect(result.provenance).toEqual([]);
      expect(result.approval).toBeNull();
      expect(result.actions).toEqual([]);
      const board = mrBoard(model, id, ctx.clock.now(), ctx);
      expect(result).toMatchObject({
        class: board.header.status.label === "NO BREAK" ? "READY" : board.header.status.label,
        cause: board.sections[0]?.items[0]?.text,
        effect: board.header.chip,
        next: "",
        why: board.header.status.label,
        evidence: [],
        related: board.sections.flatMap((section) =>
          section.items.map((row) => ({
            text: [row.text, row.detail].filter(Boolean).join(": "),
            state: [section.title, row.trailing].filter(Boolean).join(" · "),
            ...(row.href ? { url: row.href } : {}),
          })),
        ),
      });
    }
    expect(calls).toBe(0);
  });

  it.each([
    "mr:",
    "mr:legal",
    "mr:legal:1",
    "mr:unknown:756",
    "mr:legal:756:extra",
    "mr:legal:756\n",
    "mr:legal%3A756",
    "mr%3Alegal%3A756",
    "mr:legal:%37%35%36",
    "MR:legal:756",
    "mr:Legal:756",
    "mr:__proto__:756",
    "mr:constructor:756",
    "mr:toString:756",
    "mr:legal:0",
    "mr:legal:0756",
    "mr:legal:-756",
    "mr:legal:7.56",
    "mr:legal:7e2",
    "mr:legal:9007199254740992",
  ])("returns not_found for malformed or unknown MR id %s", async (id) => {
    writeSnapshot();
    const port = host(routes());
    port.request("inspect.request", { id });
    await settle();
    expect(port.sent[1]).toMatchObject({
      type: "error",
      payload: { code: "not_found" },
    });
    expect(calls).toBe(0);
  });

  it("projects an action-less upstream cards section", () => {
    const board = inspectUpstreamPlan(model, ctx.clock.now());
    board.sections = [
      {
        kind: "cards",
        title: "What failed",
        items: [
          {
            title: "file",
            edge: "error",
            fields: [{ label: "First error", value: "Build failed" }],
          },
        ],
      },
    ];
    const result = upstreamPlanResult(board, areas);
    expect(result.related).toContainEqual({ text: "Build failed", state: "What failed" });
    expect(result.actions).toEqual([]);
  });

  it("keeps the untitled lead section that fed Effect out of Related", () => {
    const boards = [
      { board: inspectUpstreamPlan(model, ctx.clock.now()), fork: false },
      ...model.upstream.forks.flatMap((f) => {
        const board = inspectUpstreamFork(model, f.service, ctx.clock.now());
        return board ? [{ board, fork: true }] : [];
      }),
    ];
    let checked = 0;
    for (const { board, fork } of boards) {
      const lead = board.sections[0];
      if (lead?.kind !== "rows" || lead.title !== undefined) continue;
      const result = fork
        ? upstreamForkResult("upstream:x", board, areas)
        : upstreamPlanResult(board, areas);
      const leadText = lead.items[0]?.text;
      expect(leadText).toBeTruthy();
      expect(result.effect).toBe(leadText);
      for (const item of lead.items) {
        expect(result.related.map(({ text }) => text)).not.toContain(item.text);
      }
      expect(result.related.length).toBeGreaterThan(0);
      checked += 1;
    }
    expect(boards.some(({ fork }) => !fork)).toBe(true);
    expect(checked).toBeGreaterThan(1);
  });

  it("inspects the upstream plan from a reopened snapshot without running commands", async () => {
    const storedAreas = areas.map(({ area }) => ({
      area,
      envelope: { source: area, state: "unread" as const },
    }));
    writeSnapshot(undefined, undefined, storedAreas);
    db.close();
    db = new DatabaseSync(path);
    const port = host(routes());
    port.request("inspect.request", { id: "upstream" });
    await settle();
    expect(port.sent[1]).toMatchObject({
      type: "inspect.result",
      payload: { id: "upstream" },
    });
    const result = InspectResultSchema.parse(port.sent[1]?.payload);
    const board = inspectUpstreamPlan(model, ctx.clock.now());
    const summary = board.sections[0];
    expect(result.cause).toBe(summary?.kind === "rows" ? summary.items[1]?.text : undefined);
    expect(result.effect).toBe(summary?.kind === "rows" ? summary.items[0]?.text : undefined);
    expect(result.why).toBe(board.header.status.label);
    expect(result.actions.map((action) => action.label)).toEqual(
      board.sections.flatMap((section) =>
        section.kind === "cards"
          ? section.items.flatMap((card) => (card.actions ?? []).map((a) => a.label))
          : [],
      ),
    );
    expect(result.areas).toEqual(storedAreas);
    expect(result.provenance).toEqual([]);
    expect(result.approval).toBeNull();
    expect(result.actions.length).toBeGreaterThan(0);
    expect(result.actions.every((action) => action.disabledReason === "writes arrive at M4")).toBe(
      true,
    );
    expect(result.related.some((row) => row.state.startsWith("Forks"))).toBe(true);
    expect(result.related.some((row) => row.state === "Lanes")).toBe(true);
    expect(calls).toBe(0);
  });

  it("inspects every upstream fork from a reopened snapshot without running commands", async () => {
    const forks = model.upstream.forks;
    expect(new Set(forks.map((f) => f.phase)).size).toBeGreaterThan(1);
    const storedAreas = areas.map(({ area }) => ({
      area,
      envelope: { source: area, state: "unread" as const },
    }));
    writeSnapshot(undefined, undefined, storedAreas);
    db.close();
    db = new DatabaseSync(path);
    const port = host(routes());
    for (const f of forks) {
      port.request("inspect.request", { id: `${UPSTREAM_PREFIX}${f.service}` }, f.service);
    }
    await settle();
    for (const f of forks) {
      const id = `${UPSTREAM_PREFIX}${f.service}`;
      const response = port.sent.find((message) => message.id === f.service);
      expect(response).toMatchObject({ type: "inspect.result", payload: { id } });
      const result = InspectResultSchema.parse(response?.payload);
      const board = inspectUpstreamFork(model, f.service, ctx.clock.now());
      if (!board) throw new Error(`Missing fork ${f.service}`);
      expect(result.cause).toBe(board.title);
      expect(result.why).toBe(board.header.status.label);
      expect(result.class).toBe(
        ({ halted: "HALT", unread: "UNREAD", stopped: "TOOLCHAIN", current: "READY" } as const)[
          f.phase as string
        ] ?? "ROLLOUT",
      );
      expect(result.areas).toEqual(storedAreas);
      expect(result.provenance).toEqual([]);
      expect(result.approval).toBeNull();
      expect(result.actions.length).toBeGreaterThan(0);
      expect(result.actions.every((a) => a.disabledReason === "writes arrive at M4")).toBe(true);
      expect(result.related).toContainEqual({
        text: "Back to the upstream plan",
        state: "",
        inspect: "upstream",
      });
      expect(result.related.some((row) => row.state.endsWith(" line"))).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it.each(["step", "release"] as const)(
    "inspects non-queue %s ids from the persisted fixture sweep",
    async (kind) => {
      const ids = kind === "step" ? steps : documents.map((document) => document.id);
      expect(ids.length).toBeGreaterThan(0);
      const storedAreas = areas.map(({ area }) => ({
        area,
        envelope: { source: area, state: "unread" as const },
      }));
      writeSnapshot(undefined, undefined, storedAreas);
      db.close();
      db = new DatabaseSync(path);
      const port = host(routes());
      for (const id of ids) {
        expect(model.queue.items.some((item) => item.id === id)).toBe(false);
        port.request("inspect.request", { id }, `inspect-${id}`);
      }
      await settle();
      for (const id of ids) {
        const response = port.sent.find((message) => message.id === `inspect-${id}`);
        expect(response).toMatchObject({
          kind: "response",
          type: "inspect.result",
          payload: { id },
        });
        const result = InspectResultSchema.parse(response?.payload);
        expect(result.areas).toEqual(storedAreas);
        expect(result.provenance).toEqual([]);
        expect(result.approval).toBeNull();
        expect(result.actions).toEqual([]);
        if (kind === "step") {
          const step = inspectStep(model, id, ctx);
          expect(result).toMatchObject({
            class: "ROLLOUT",
            cause: step.summary,
            effect: step.chip ?? "",
          });
          for (const change of step.changes) {
            expect(result.related).toContainEqual({
              text: change.text,
              state: change.trailing,
              url: change.href,
            });
          }
          for (const fork of step.forks) {
            expect(result.related).toContainEqual({ text: fork.text, state: fork.trailing });
          }
        } else {
          const document = documents.find((document) => document.id === id);
          if (!document) throw new Error(`Fixture document ${id} missing`);
          expect(result).toMatchObject({
            class: document.unread.length > 0 ? "UNREAD" : "READY",
            cause: document.headline,
            effect: document.stateText,
          });
          for (const action of document.required) expect(result.next).toContain(action.title);
          for (const row of document.rows) {
            expect(result.related).toContainEqual({
              text: `${row.id}: ${row.version}`,
              state: row.state,
              ...(row.url ? { url: row.url } : {}),
            });
          }
        }
      }
      expect(calls).toBe(0);
    },
  );

  it.each([
    "step:",
    "step:not-a-marker",
    "step:00000000",
    "release:2026-13",
    "release:1900-01",
    "upstream:",
    "UPSTREAM",
    "upstream/x",
    " upstream",
    "upstream ",
    "upstream%3A",
    "upstream%2Fx",
    "upstream:nope",
    "upstream:Partition",
    "UPSTREAM:partition",
    "Upstream:partition",
    "upstream: partition",
    "upstream:partition ",
    "upstream:partition\n",
    "upstream:partition:x",
    "upstream:partition/x",
    "upstream%3Apartition",
    "upstream:partition%2Fx",
    "upstream:%70artition",
    "upstream::partition",
    "upstream:__proto__",
    "upstream:constructor",
    "upstream:toString",
  ])("answers not_found for malformed or unknown id %s", async (id) => {
    writeSnapshot();
    const port = host(routes());
    port.request("inspect.request", { id });
    await settle();
    expect(port.sent[1]).toMatchObject({
      id: "req",
      type: "error",
      payload: { code: "not_found" },
    });
    expect(calls).toBe(0);
  });

  it("inspects every watched repository from the persisted fixture sweep", async () => {
    const ids = model.repositories.rows.map((row) => `${REPO_PREFIX}${row.name}`);
    expect(ids.length).toBeGreaterThan(0);
    const storedAreas = areas.map(({ area }) => ({
      area,
      envelope: { source: area, state: "unread" as const },
    }));
    writeSnapshot(undefined, undefined, storedAreas);
    const port = host(routes());
    for (const id of ids) port.request("inspect.request", { id }, `inspect-${id}`);
    await settle();
    for (const id of ids) {
      expect(model.queue.items.some((item) => item.id === id)).toBe(false);
      const repo = inspectRepo(model, id, ctx.clock.now());
      if (!repo) throw new Error(`Fixture repository ${id} missing`);
      const response = port.sent.find((message) => message.id === `inspect-${id}`);
      expect(response).toMatchObject({ kind: "response", type: "inspect.result" });
      const result = InspectResultSchema.parse(response?.payload);
      expect(result).toMatchObject({
        id,
        class: "SECURITY",
        cause: repo.title,
        effect: repo.chip,
        next: "",
        why: `${repo.status.label}; ${repo.summary}`,
        evidence: [],
        approval: null,
        actions: [],
        areas: storedAreas,
        provenance: [],
      });
      const items = repo.tabs.flatMap((tab) =>
        tab.sections.flatMap((section) => section.items.map((item) => ({ tab, section, item }))),
      );
      expect(result.related).toHaveLength(items.length + repo.links.length);
      for (const { tab, section, item } of items) {
        expect(result.related).toContainEqual({
          text: item.detail ? `${item.text} · ${item.detail}` : item.text,
          state: [tab.label, section.title, item.chip?.label, item.trailing]
            .filter(Boolean)
            .join(" · "),
          ...(item.href ? { url: item.href } : {}),
        });
      }
      for (const link of repo.links) {
        expect(result.related).toContainEqual({
          text: link.text,
          state: "On GitHub",
          url: link.href,
        });
      }
    }
    expect(calls).toBe(0);
  });

  it.each([
    "repo:",
    "repo:not-watched",
    "repo:partition:extra",
    "repo:partition/x",
    "repo%3Apartition",
    "repo:part%69tion",
    "REPO:partition",
    "repo:Partition",
    " repo:partition",
    "repo:partition ",
    "repo:__proto__",
    "repo:toString",
    "repo:constructor",
  ])("answers not_found for malformed or unknown repository id %j", async (id) => {
    writeSnapshot();
    const port = host(routes());
    port.request("inspect.request", { id });
    await settle();
    expect(port.sent[1]).toMatchObject({
      id: "req",
      type: "error",
      payload: { code: "not_found" },
    });
    expect(calls).toBe(0);
  });

  const base: QueueItem = {
    id: "x",
    kind: "gate1",
    rung: 1,
    scope: "svc",
    text: "",
    effects: [],
    cause: [],
    incident: true,
    blocks: 1,
  };
  const oracleCases = (
    oracle("inspect-actions") as {
      cases: { name: string; item: QueueItem; opts: InspectOptions }[];
    }
  ).cases;
  const real = (name: string) => {
    const found = oracleCases.find((c) => c.name === name);
    if (!found) throw new Error(`oracle case ${name} missing`);
    return found;
  };
  const approve = ["Approve #343 · 2 runs", "Approve #344 · 2 runs", "Approve #345 · 2 runs"];
  interface Case {
    item: Partial<QueueItem>;
    opts?: InspectOptions;
    labels: string[];
    approval?: string;
  }
  const classes: Record<ItemClass, Case> = {
    ENV: { ...real("wait for deployable"), labels: ["Re-run when deployable"] },
    ACCESS: {
      item: {
        kind: "access",
        cls: "ACCESS",
        cause: [
          { label: "reason", value: 'denied: "ghcr.io/azure/osdu-spi-legal:pr-9" requires auth' },
        ],
      },
      labels: [],
    },
    TEST: { item: { kind: "template-red", cls: "TEST" }, labels: [] },
    HALT: {
      item: {
        kind: "halt",
        rung: 0,
        cls: "HALT",
        halt: { fork: "entitlements", code: "UNKNOWN_TOP_LEVEL", entries: ["schemathesis-tests"] },
      },
      labels: [],
    },
    TOOLCHAIN: { item: { cls: "TOOLCHAIN" }, labels: [] },
    CONFLICT: { item: { kind: "conflict", rung: 0, cls: "CONFLICT" }, labels: [] },
    POLICY: { item: { cls: "POLICY" }, labels: [] },
    INFRA: {
      item: { ...real("busy lifecycle").item, cls: "INFRA" },
      opts: real("busy lifecycle").opts,
      labels: ["Re-dispatch env-upgrade", "Re-dispatch env-refresh"],
    },
    BUILD: { item: { kind: "release-red", cls: "BUILD" }, labels: [] },
    UNREAD: { item: { cls: "UNREAD" }, labels: [] },
    PORT: { item: { kind: "port", cls: "PORT", scope: "entitlements" }, labels: [] },
    SECURITY: { item: { kind: "security", cls: "SECURITY" }, labels: [] },
    ROLLOUT: {
      item: { ...real("template actions").item, cls: "ROLLOUT" },
      opts: real("template actions").opts,
      labels: ["Sync all forks · 0", "Roll out · 0 ready"],
    },
    INCIDENT: { ...real("approval waiting"), labels: approve, approval: "Outside PRs · 3" },
    GATE: {
      item: { ...real("approval waiting").item, incident: false },
      opts: real("approval waiting").opts,
      labels: approve,
      approval: "Outside PRs · 3",
    },
    READY: { item: { incident: false, rung: 2, kind: "releases" }, labels: [] },
  };

  it.each(Object.entries(classes))(
    "%s maps to a schema-valid result with every write disabled",
    async (cls, { item: override, opts, labels, approval }) => {
      const item = { ...base, ...override } as QueueItem;
      const result = await inspectResult(model, item, ctx.clock.now(), ctx, failing, areas, opts);
      expect(InspectResultSchema.safeParse(result).success).toBe(true);
      expect(result.class).toBe(cls);
      expect(result.actions.map((action) => action.label)).toEqual(labels);
      expect(result.actions.length).toBe(labels.length);
      for (const action of result.actions) {
        expect(action.disabledReason).toBe("writes arrive at M4");
      }
      expect(result.approval).toEqual(
        approval ? { id: item.id, state: "pending", reason: approval } : null,
      );
    },
  );

  it.each(Object.entries(classes))(
    "%s carries the stored area envelopes and binds no value to a source",
    async (_, { item: override, opts }) => {
      const item = { ...base, ...override } as QueueItem;
      const result = await inspectResult(model, item, ctx.clock.now(), ctx, failing, areas, opts);
      expect(InspectResultSchema.safeParse(result).success).toBe(true);
      expect(result.areas).toEqual(areas);
      expect(result.areas?.map(({ area }) => area)).toEqual([...AREAS]);
      // Nothing is inferred until core records which reads produced each value.
      expect(result.provenance).toEqual([]);
    },
  );

  it("records the failed FILTERS read as evidence for a checkable halt", async () => {
    const item = { ...base, ...classes.HALT.item } as QueueItem;
    const result = await inspectResult(model, item, ctx.clock.now(), ctx, failing, areas);
    expect(calls).toBeGreaterThan(0);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.every((record) => record.failure !== undefined)).toBe(true);
    expect(result.related.length).toBeGreaterThan(0);
    expect(result.provenance).toEqual([]);
  });

  it("answers each queued item over the port and an unknown id with not_found", async () => {
    writeSnapshot();
    const port = host(routes());
    const ids = model.queue.items.map((item) => item.id);
    for (const id of ids) port.request("inspect.request", { id }, `inspect-${id}`);
    port.request("inspect.request", { id: "missing" }, "inspect-missing");
    await settle();
    const replies = port.sent.slice(1);
    for (const item of model.queue.items) {
      expect(replies.find((m) => m.id === `inspect-${item.id}`)).toEqual({
        version: PROTOCOL_VERSION,
        id: `inspect-${item.id}`,
        kind: "response",
        type: "inspect.result",
        payload: await inspectResult(model, item, ctx.clock.now(), ctx, failing, areas),
      });
    }
    const results = replies.flatMap((m) => (m.type === "inspect.result" ? [m.payload] : []));
    const stored = projectWatch(input).areas;
    for (const result of results) {
      expect(result.areas).toEqual(stored);
      expect(result.provenance).toEqual([]);
    }
    const actions = results.flatMap((result) => result.actions);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.disabledReason === "writes arrive at M4")).toBe(true);
    expect(replies.find((m) => m.id === "inspect-missing")).toMatchObject({
      type: "error",
      payload: { code: "not_found" },
    });
  });

  it("resolves every selection Repositories, Environment, Flow, Horizon and the tree hand over", async () => {
    writeSnapshot();
    const { briefing, tree } = projectWatch(input);
    const selections: [string, string][] = [
      ...briefing.repositories.rows.map((row): [string, string] => ["repositories", row.id]),
      ...briefing.environment.lanes.flatMap((lane) =>
        lane.events.map((e): [string, string] => [
          `environment ${lane.id}`,
          e.inspect ?? (lane.id === "holds" ? `hold:${e.id}` : `run:${e.id}`),
        ]),
      ),
      ["flow plan", briefing.flow.inspect],
      ...briefing.flow.rows.map((row): [string, string] => ["flow row", row.inspect]),
      ...briefing.flow.also.flatMap((also): [string, string][] =>
        also.inspect ? [["flow also", also.inspect]] : [],
      ),
      ...briefing.themes.flatMap((theme): [string, string][] => [
        ["horizon theme", theme.inspect ?? `theme:${theme.id}`],
        ...[...theme.certain, ...theme.possible].flatMap((fork): [string, string][] =>
          fork.inspect ? [["horizon fork", fork.inspect]] : [],
        ),
      ]),
      ...tree
        .filter((node) => node.id.startsWith("service:") || node.id.startsWith("run:"))
        .map((node): [string, string] => ["tree", node.id]),
    ];
    const where = new Set(selections.map(([view]) => view.split(" ")[0]));
    expect([...where].sort()).toEqual(["environment", "flow", "horizon", "repositories", "tree"]);
    expect(selections.some(([, id]) => id.startsWith("run:"))).toBe(true);
    expect(selections.some(([, id]) => id.startsWith("service:"))).toBe(true);
    expect(selections.some(([, id]) => id.startsWith("theme:"))).toBe(true);
    const port = host(routes());
    for (const [, id] of selections) port.request("inspect.request", { id }, `select-${id}`);
    await settle();
    const unresolved = selections.filter(([, id]) => {
      const reply = port.sent.find((m) => m.id === `select-${id}`);
      return reply?.type !== "inspect.result" || InspectResultSchema.parse(reply.payload).id !== id;
    });
    expect(unresolved).toEqual([]);
  });

  it("resolves a fork run and a lifecycle run from the persisted facts", async () => {
    writeSnapshot();
    const fork = Object.entries(input.facts.runs.data ?? {}).flatMap(([repo, w]) =>
      w.sync.map((run) => ({ repo, run })),
    )[0];
    const life = Object.values(input.facts.lifecycle.data ?? {}).flat()[0];
    if (!fork || !life) throw new Error("Fixture runs missing");
    const port = host(routes());
    for (const run of [fork.run, life]) {
      port.request("inspect.request", { id: `run:${run.id}` }, `run-${run.id}`);
    }
    await settle();
    for (const run of [fork.run, life]) {
      const reply = port.sent.find((m) => m.id === `run-${run.id}`);
      expect(reply).toMatchObject({ type: "inspect.result" });
      const result = InspectResultSchema.parse(reply?.payload);
      expect(result.id).toBe(`run:${run.id}`);
      expect(result.related).toContainEqual(expect.objectContaining({ url: run.url }));
    }
  });

  it("answers not_found for loose spellings of run, hold, theme and service ids", async () => {
    writeSnapshot();
    const { briefing, tree } = projectWatch(input);
    const run = Object.values(input.facts.runs.data ?? {}).flatMap((w) => w.sync)[0]?.id;
    const hold = briefing.environment.lanes.find((lane) => lane.id === "holds")?.events[0]?.id;
    const theme = briefing.themes[0]?.id;
    const service = tree.find((node) => node.id.startsWith("service:"))?.id.slice(8);
    if (run === undefined || !hold || !theme || !service) throw new Error("Fixture ids missing");
    const loose = (raw: string) => [
      `${raw}e0`,
      `${raw}.0`,
      `0${raw}`,
      ` ${raw}`,
      `${raw} `,
      `+${raw}`,
      `-${raw}`,
      "",
    ];
    const ids = [
      `run:0x${run.toString(16)}`,
      `run:${run.toExponential()}`,
      ...loose(String(run)).map((raw) => `run:${raw}`),
      `hold:0x${Number(hold).toString(16)}`,
      ...loose(hold).map((raw) => `hold:${raw}`),
      ...loose(theme).map((raw) => `theme:${raw}`),
      ...loose(service).map((raw) => `service:${raw}`),
      `service:${service.toUpperCase()}`,
    ];
    const port = host(routes());
    for (const id of ids) port.request("inspect.request", { id }, `loose-${id}`);
    port.request("inspect.request", { id: `run:${run}` }, "exact");
    await settle();
    expect(port.sent.find((m) => m.id === "exact")).toMatchObject({ type: "inspect.result" });
    const resolved = ids.filter(
      (id) => port.sent.find((m) => m.id === `loose-${id}`)?.type !== "error",
    );
    expect(resolved).toEqual([]);
    for (const id of ids) {
      expect(port.sent.find((m) => m.id === `loose-${id}`)).toMatchObject({
        type: "error",
        payload: { code: "not_found" },
      });
    }
  });

  it("answers not_found before any sweep has been persisted", async () => {
    const port = host(routes());
    port.request("inspect.request", { id: "halt:entitlements" });
    await settle();
    expect(port.sent[1]).toMatchObject({
      id: "req",
      type: "error",
      payload: { code: "not_found" },
    });
  });
});

it("still rejects malformed and unrouted requests", async () => {
  const port = host(routes());
  port.request("view.subscribe", { fromCursor: -1 });
  port.request("inspect.request", {});
  port.request("models.list", {}, "models");
  await settle();
  expect(port.sent.slice(1)).toMatchObject([
    { id: "invalid", type: "error", payload: { code: "invalid_message" } },
    { id: "invalid", type: "error", payload: { code: "invalid_message" } },
    { id: "models", type: "error", payload: { code: "unsupported_message" } },
  ]);
});
