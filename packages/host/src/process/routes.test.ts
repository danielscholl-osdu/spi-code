// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AREAS,
  InspectResultSchema,
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  SweepStatusSchema,
} from "@spi-code/contracts";
import {
  BudgetPacer,
  buildModel,
  type CollectorOptions,
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
  type QueueItem,
  REPO_PREFIX,
  STEP_PREFIX,
  UPSTREAM_PREFIX,
} from "@spi-code/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mrBoard } from "../../../core/src/inspect/mr.js";
import { createLeaseStore } from "../store/leases.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { openRunStore } from "../store/store.js";
import { SweepService } from "../sweep/service.js";
import { projectReleases, projectWatch } from "../watch/project.js";
import { fixtureInput, oracle } from "../watch/snapshot-fixture.js";
import { attachHostPort, type HostPort } from "./port.js";
import { inspectResult, upstreamPlanResult, WatchRoutes, watchFleet } from "./routes.js";

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

function writeSnapshot(
  remaining = 4321.5,
  floor?: number,
  areas = projectWatch(input).areas,
): number {
  fence ??= createLeaseStore(db).acquire(fleet, "sweeper", 60_000, now);
  if (fence === undefined) throw new Error("lease not acquired");
  const { cursor: _, ...view } = projectWatch(input);
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
      const statuses = [...port.sent, ...replay.sent].filter(
        (message) => message.type === "sweep.status",
      );
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
    expect(port.sent[1]).toMatchObject({ kind: "event", payload: { ...stored, cursor } });
    expect(port.sent[2]).toMatchObject({
      payload: {
        remaining: 4321,
        resetAt,
        deferredAreas: [{ area: "security", reason: "budget" }],
      },
    });
    expect(calls).toBe(0);
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
    expect(current.sent.map((m) => m.type)).toEqual(["host.hello"]);
    watch.publish();
    expect(current.sent.map((m) => m.type)).toEqual(["host.hello"]);

    let sweep: CollectorOptions | undefined;
    const create = watch.sweeper((options) => {
      sweep = options;
      return {} as ReturnType<typeof createSweeper>;
    });
    create({ persist: { load: () => undefined, save: async () => {} } } as never);
    const next = writeSnapshot(50);
    await sweep?.persist.save({} as never);
    expect(current.sent.slice(1)).toMatchObject([
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
    expect(port.sent.map((m) => m.type)).toEqual(["host.hello"]);
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
