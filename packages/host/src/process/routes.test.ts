// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  InspectResultSchema,
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
} from "@spi-code/contracts";
import {
  buildModel,
  type CollectorOptions,
  type createSweeper,
  type Exec,
  emptyCache,
  type InspectOptions,
  type ItemClass,
  type QueueItem,
} from "@spi-code/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLeaseStore } from "../store/leases.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { openRunStore } from "../store/store.js";
import { projectWatch } from "../watch/project.js";
import { fixtureInput, oracle } from "../watch/snapshot-fixture.js";
import { attachHostPort, type HostPort } from "./port.js";
import { inspectResult, WatchRoutes, watchFleet } from "./routes.js";

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

function writeSnapshot(remaining = 4321.5): number {
  fence ??= createLeaseStore(db).acquire(fleet, "sweeper", 60_000, now);
  if (fence === undefined) throw new Error("lease not acquired");
  const { cursor: _, ...view } = projectWatch(input);
  return createSnapshotStore(db).writeSnapshot(
    { fleet, owner: "sweeper", fence },
    {
      facts: input.facts,
      cache: {
        ...emptyCache(),
        budget: {
          cost: 1,
          remaining,
          resetAt,
          calls: 3,
          deferred: [{ area: "security", reason: "budget" }],
        },
      },
      reads: {},
    },
    view,
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
    exec: failing,
    onError: (error) => {
      throw error;
    },
  });
}

describe("view.subscribe", () => {
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
      const result = await inspectResult(model, item, ctx.clock.now(), ctx, failing, opts);
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

  it("records the failed FILTERS read as evidence for a checkable halt", async () => {
    const item = { ...base, ...classes.HALT.item } as QueueItem;
    const result = await inspectResult(model, item, ctx.clock.now(), ctx, failing);
    expect(calls).toBeGreaterThan(0);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.every((record) => record.failure !== undefined)).toBe(true);
  });

  it("answers each queued item over the port and an unknown id with not_found", async () => {
    writeSnapshot();
    const port = host(routes());
    const ids = model.queue.items.map((item) => item.id);
    for (const id of ids) port.request("inspect.request", { id }, `inspect-${id}`);
    port.request("inspect.request", { id: "missing" }, "inspect-missing");
    await settle();
    const replies = port.sent.slice(1);
    for (const id of ids) {
      expect(replies.find((m) => m.id === `inspect-${id}`)).toMatchObject({
        kind: "response",
        type: "inspect.result",
        payload: { id },
      });
    }
    const actions = replies.flatMap((m) => (m.type === "inspect.result" ? m.payload.actions : []));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.disabledReason === "writes arrive at M4")).toBe(true);
    expect(replies.find((m) => m.id === "inspect-missing")).toMatchObject({
      type: "error",
      payload: { code: "not_found" },
    });
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
