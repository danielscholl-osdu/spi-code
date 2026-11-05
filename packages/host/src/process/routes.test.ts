// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AREAS,
  type AreaEnvelope,
  type InspectResult,
  InspectResultSchema,
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  resolvePointer,
  SweepStatusSchema,
  type ValueSource,
} from "@spi-code/contracts";
import {
  BudgetPacer,
  buildModel,
  type CollectorOptions,
  type createSweeper,
  type Exec,
  emptyCache,
  emptyFacts,
  type Facts,
  type InspectOptions,
  type ItemClass,
  type QueueItem,
} from "@spi-code/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLeaseStore } from "../store/leases.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { openRunStore } from "../store/store.js";
import { SweepService } from "../sweep/service.js";
import { projectWatch } from "../watch/project.js";
import { fixtureInput, mixedFixtureInput, oracle } from "../watch/snapshot-fixture.js";
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

function writeSnapshot(remaining = 4321.5, floor?: number): number {
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
          ...(floor === undefined ? {} : { floor }),
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
  const bindings = (result: InspectResult) =>
    new Map((result.provenance ?? []).map((source) => [source.path, source]));
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
      const result = await inspectResult(
        model,
        item,
        ctx.clock.now(),
        ctx,
        failing,
        { areas },
        opts,
      );
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
    "%s leaves model values unbound when the sweep's facts do not rebuild its item",
    async (_, { item: override, opts }) => {
      const item = { ...base, ...override } as QueueItem;
      const result = await inspectResult(
        model,
        item,
        ctx.clock.now(),
        ctx,
        failing,
        { areas, facts: input.facts },
        opts,
      );
      expect(InspectResultSchema.safeParse(result).success).toBe(true);
      expect(result.areas).toEqual(areas);
      expect(result.areas?.map(({ area }) => area)).toEqual([...AREAS]);
      // Only the FILTERS read this request made can stand behind a value of an item core never queued.
      for (const source of result.provenance ?? []) expect(source.areas).toEqual(["fleet"]);
    },
  );

  const mixed = mixedFixtureInput();
  const mixedCtx = mixed.context;
  const mixedModel = buildModel(mixed.facts, ctx.clock.now(), {}, mixedCtx);
  const mixedAreas = projectWatch(mixed).areas;
  const inspectMixed = (facts: Facts, pick: (item: QueueItem) => boolean, exec = failing) => {
    const built = buildModel(facts, ctx.clock.now(), {}, mixedCtx);
    const item = built.queue.items.find(pick);
    if (!item) throw new Error("fixture must queue the item");
    return inspectResult(built, item, ctx.clock.now(), mixedCtx, exec, {
      areas: mixedAreas,
      facts,
    });
  };
  const windowInferred = async () => {
    const evidence = new URL("../../../../apps/window/src/store/evidence.ts", import.meta.url);
    const { isInferred } = (await import(/* @vite-ignore */ evidence.href)) as {
      isInferred: (
        snapshot: { areas: readonly AreaEnvelope[]; provenance: ValueSource[] },
        p: string,
      ) => boolean;
    };
    return (result: InspectResult, p: string, envelopes = result.areas ?? []) =>
      isInferred({ areas: envelopes, provenance: result.provenance ?? [] }, p);
  };

  it("binds each queued value to the areas whose facts change it", async () => {
    const expected: Record<string, Record<string, string[]>> = {
      "stack:38181620856": {
        "/class": ["lifecycle"],
        "/cause": ["lifecycle"],
        "/why": ["github", "lifecycle"],
        "/actions/0/label": ["lifecycle"],
        "/actions/0/eligibilityReason": ["lifecycle"],
      },
      "gate1:legal": {
        "/cause": ["github", "details"],
        "/effect": ["github", "upstream"],
        "/related/0": ["github", "details", "radar"],
      },
      "port:legal": { "/class": ["radar"], "/cause": ["radar"], "/related/0": ["radar"] },
      "approvals:Azure/osdu-spi-stack": { "/cause": ["approvals"], "/why": ["approvals"] },
      releases: { "/cause": ["github"], "/next": ["github"] },
    };
    for (const item of mixedModel.queue.items) {
      const result = await inspectMixed(mixed.facts, (entry) => entry.id === item.id);
      const sources = bindings(result);
      for (const path of ["/class", "/cause", "/effect", "/next"]) {
        expect(sources.get(path)?.areas.length, `${item.id} ${path}`).toBeGreaterThan(0);
      }
      for (const [path, named] of Object.entries(expected[item.id] ?? {})) {
        expect(sources.get(path)?.areas, `${item.id} ${path}`).toEqual(named);
      }
    }
  });

  it("binds no area whose facts its value did not read, and every area that it did", async () => {
    const empty = emptyFacts();
    const scalars = ["/class", "/cause", "/effect", "/next", "/why", "/approval/reason"];
    for (const item of mixedModel.queue.items) {
      const result = await inspectMixed(mixed.facts, (entry) => entry.id === item.id);
      const sources = bindings(result);
      for (const area of AREAS) {
        const ablated = buildModel(
          { ...mixed.facts, [area]: empty[area] },
          ctx.clock.now(),
          {},
          mixedCtx,
        );
        const counterpart = ablated.queue.items.find((entry) => entry.id === item.id);
        const other =
          counterpart &&
          (await inspectResult(ablated, counterpart, ctx.clock.now(), mixedCtx, failing, {
            areas: mixedAreas,
          }));
        const rows = new Set(other?.related.map((row) => JSON.stringify(row)));
        const changed = (path: string): boolean => {
          if (other === undefined) return true;
          const [, field, index, key] = path.split("/");
          if (field === "related") {
            return !rows.has(JSON.stringify(result.related[Number(index)]));
          }
          if (field === "actions") {
            const action = result.actions[Number(index)];
            const twin = other.actions.find((candidate) => candidate.id === action?.id);
            const name = key as "label" | "eligibilityReason";
            return twin?.[name] !== action?.[name];
          }
          return resolvePointer(other, path).value !== resolvePointer(result, path).value;
        };
        for (const source of result.provenance ?? []) {
          if (area === "fleet" && source.envelope) continue;
          if (source.areas.includes(area)) {
            expect(changed(source.path), `${item.id} ${source.path} binds ${area}`).toBe(true);
          }
        }
        for (const path of scalars) {
          const value = resolvePointer(result, path);
          if (!value.found || !value.value) continue;
          expect(
            sources.get(path)?.areas.includes(area) ?? false,
            `${item.id} ${path} and ${area}`,
          ).toBe(changed(path));
        }
      }
    }
  });

  it("binds a stack cause to the lifecycle reads alone, whatever GitHub or details say", async () => {
    const isInferred = await windowInferred();
    const inspectStack = async (facts: Facts) => {
      const result = await inspectMixed(facts, (item) => item.kind === "stack");
      return {
        cause: result.cause,
        areas: bindings(result).get("/cause")?.areas,
        inferred: isInferred(result, "/cause"),
      };
    };
    const pinned = await inspectStack(mixed.facts);
    expect(pinned).toMatchObject({ areas: ["lifecycle"], inferred: true });

    const repos = structuredClone(mixed.facts.github.data?.repos ?? {});
    const stackRepo = repos[mixedCtx.stackRepo];
    if (!stackRepo?.declaration) throw new Error("fixture must declare the stack");
    stackRepo.declaration.stackVersion = "v9.9.9";
    const redeclared = await inspectStack({
      ...mixed.facts,
      github: { ...mixed.facts.github, data: { ...mixed.facts.github.data, repos } },
    } as Facts);
    expect(redeclared).toEqual({ ...pinned });

    const undetailed = await inspectStack({ ...mixed.facts, details: emptyFacts().details });
    expect(undetailed).toEqual({ ...pinned });
  });

  it("keeps inferred-only values apart from values that also read observed areas", async () => {
    const isInferred = await windowInferred();
    expect(
      mixedAreas.filter(({ envelope }) => envelope.inferred === true).map(({ area }) => area),
    ).toEqual(["lifecycle"]);
    const stack = await inspectMixed(mixed.facts, (item) => item.kind === "stack");
    expect(isInferred(stack, "/cause")).toBe(true);
    expect(isInferred(stack, "/actions/0/label")).toBe(true);
    expect(isInferred(stack, "/why")).toBe(false);
    const rollout = await inspectMixed(mixed.facts, (item) => item.kind === "rollout");
    expect(bindings(rollout).get("/next")?.areas).toContain("lifecycle");
    expect(isInferred(rollout, "/next")).toBe(false);
  });

  it("judges each same-entry row by its own fork's FILTERS read", async () => {
    const filter = Buffer.from("top_level:\n  schemathesis-tests: strip\n").toString("base64");
    const listed = (request: string) => request.includes("partition") || request.includes("legal");
    const exec: Exec = {
      runJSON: async <T>(cmd: string, args: readonly string[]) => {
        calls += 1;
        const request = `${cmd} ${args.join(" ")}`;
        if (request.includes("osdu-spi-legal/contents")) {
          return { ok: false, error: "legal filter offline", code: 1 };
        }
        if (cmd === "gh") return { ok: true, data: { sha: "abc", content: filter } as T };
        return { ok: true, data: (listed(request) ? [{ name: "schemathesis-tests" }] : []) as T };
      },
      runText: async (_cmd, args) => {
        calls += 1;
        const entries = listed(args.join(" ")) ? [{ name: "schemathesis-tests" }] : [];
        return { ok: true, data: JSON.stringify(entries) };
      },
    };
    const result = await inspectMixed(mixed.facts, (item) => item.kind === "halt", exec);
    expect(calls).toBeGreaterThan(0);
    const row = (match: (entry: InspectResult["related"][number]) => boolean) => {
      const i = result.related.findIndex(match);
      expect(i, "row must be shown").toBeGreaterThanOrEqual(0);
      return bindings(result).get(`/related/${i}`);
    };
    expect(row(({ text }) => text.startsWith("partition"))).toMatchObject({
      areas: expect.arrayContaining(["fleet"]),
      envelope: { source: "filters", state: "fresh" },
    });
    expect(row(({ text, state }) => text === "legal" && state === "?")?.envelope).toMatchObject({
      state: "failed",
    });
    expect(row(({ text }) => text.includes("no such entry"))?.envelope).toMatchObject({
      state: "fresh",
    });
    expect(bindings(result).get("/next")?.envelope).toMatchObject({ state: "fresh" });
  });

  it("does not bind lifecycle to a template-set cause when there is no ENV failure", async () => {
    const facts = structuredClone(mixed.facts);
    const templateRepo = facts.github.data?.repos["Azure/osdu-spi"];
    if (!templateRepo) throw new Error("fixture must carry the template repo");
    delete templateRepo.head;
    for (const repo of Object.values(facts.github.data?.repos ?? {})) {
      for (const pr of repo.prs) {
        if (pr.head.startsWith("template-sync/") || pr.labels.includes("template-sync")) {
          pr.checks = [];
        }
      }
    }
    const result = await inspectMixed(facts, (item) => item.kind === "template-set");
    expect(result.cause).toContain("mergeable together");
    expect(bindings(result).get("/cause")?.areas).not.toContain("lifecycle");
  });

  it("does not bind unrelated queue sources to a HALT radar effect", async () => {
    const facts = structuredClone(mixed.facts);
    for (const repo of Object.values(facts.github.data?.repos ?? {})) {
      repo.issues = repo.issues.filter((issue) => !issue.labels.includes("sync-failed"));
      repo.prs = repo.prs.filter((pr) => !pr.head.startsWith("sync/upstream-"));
    }
    const result = await inspectMixed(
      facts,
      (item) => item.kind === "radar" && item.cls === "HALT",
    );
    const effect = bindings(result).get("/effect")?.areas;
    expect(effect?.length).toBeGreaterThan(0);
    for (const area of ["approvals", "security", "lifecycle"] as const) {
      expect(effect).not.toContain(area);
    }
  });

  it("does not bind lifecycle, upstream or radar to the rolling rollout cause", async () => {
    const result = await inspectMixed(mixed.facts, (item) => item.kind === "rollout");
    const cause = bindings(result).get("/cause")?.areas;
    expect(cause?.length).toBeGreaterThan(0);
    for (const area of ["lifecycle", "upstream", "radar"] as const) {
      expect(cause).not.toContain(area);
    }
  });

  it("keeps a green template PR's cause independent of details", async () => {
    const facts = structuredClone(mixed.facts);
    const repo = facts.github.data?.repos["Azure/osdu-spi"];
    const seed = repo?.prs[0];
    if (!repo || !seed) throw new Error("fixture must carry a template PR");
    repo.prs.push({
      ...seed,
      number: 9999,
      head: "feature/review-probe",
      labels: [],
      draft: false,
      title: "feat: review probe",
      checks: [],
    });
    const result = await inspectMixed(facts, (item) => item.kind === "template-pr");
    expect(bindings(result).get("/cause")?.areas).toEqual(["github"]);
  });

  it("keeps a program-repository security cause security-only", async () => {
    const isInferred = await windowInferred();
    const at = ctx.clock.now().toISOString();
    const facts = emptyFacts();
    facts.security = {
      at,
      data: {
        "Azure/osdu-spi": {
          dependabot: [
            {
              number: 1,
              severity: "critical",
              package: "review-package",
              ecosystem: "maven",
              manifest: "pom.xml",
              scope: "runtime",
              fixed: "2.0.0",
              advisory: "review-advisory",
              summary: "Review probe",
              url: "https://github.com/Azure/osdu-spi/security/dependabot/1",
              createdAt: at,
            },
          ],
        },
      },
    };
    const result = await inspectMixed(facts, (item) => item.kind === "security");
    expect(result.cause).toContain("review-package");
    expect(bindings(result).get("/cause")?.areas).toEqual(["security"]);
    const securityOnly = mixedAreas.map(({ area }) => ({
      area,
      envelope: {
        source: area,
        state: "fresh" as const,
        observedAt: at,
        completeness: { kind: "complete" as const },
        inferred: area === "security",
      },
    }));
    expect(isInferred(result, "/cause", securityOnly)).toBe(true);
  });

  it("records the failed FILTERS read as evidence for a checkable halt", async () => {
    const item = { ...base, ...classes.HALT.item } as QueueItem;
    const result = await inspectResult(model, item, ctx.clock.now(), ctx, failing, { areas });
    expect(calls).toBeGreaterThan(0);
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.evidence.every((record) => record.failure !== undefined)).toBe(true);
    expect(result.related.length).toBeGreaterThan(0);
    for (const i of result.related.keys()) {
      expect(bindings(result).get(`/related/${i}`)).toMatchObject({
        areas: ["fleet"],
        envelope: { source: "filters", state: "failed" },
      });
    }
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
    const results = replies.flatMap((m) => (m.type === "inspect.result" ? [m.payload] : []));
    const stored = projectWatch(input).areas;
    for (const result of results) {
      expect(result.areas).toEqual(stored);
      expect(result.provenance?.length).toBeGreaterThan(0);
    }
    const actions = results.flatMap((result) => result.actions);
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
