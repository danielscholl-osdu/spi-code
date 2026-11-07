// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type InspectResult,
  InspectResultSchema,
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  type ViewSnapshot,
} from "@spi-code/contracts";
import { type Exec, emptyCache } from "@spi-code/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachHostPort, type HostPort } from "../process/port.js";
import { WatchRoutes, watchFleet } from "../process/routes.js";
import { createLeaseStore } from "../store/leases.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { openRunStore } from "../store/store.js";
import { projectWatch } from "./project.js";
import { recordedInput, recordedSnapshotPath } from "./snapshot-fixture.js";

const detailFeedPath = fileURLToPath(
  new URL("../../../../fixtures/watch/inspect-1106.json", import.meta.url),
);

process.env.TZ = "UTC";

/**
 * The window's Detail draws what inspect.request answers. These checks hold that answer to the
 * recorded snapshot: a briefing value the window sends to Detail must come back unchanged after the
 * sweep is persisted and served by the router. The window's reachability suite draws Detail from
 * fixtures/watch/inspect-1106.json, which must equal the router's answers field for field. Projection, the store's replay and the oracle
 * comparisons live in project.test.ts, snapshot-1106.test.ts and process/routes.test.ts.
 */
const snapshot: ViewSnapshot = JSON.parse(readFileSync(recordedSnapshotPath, "utf8"));
const { briefing } = snapshot;
const queue = [...briefing.focus, ...briefing.rest];

/** Named gaps: each pointer names its bead, and the test fails once the gap closes. */
const GAPS: Readonly<Record<string, string>> = {
  "port-group": "spicode-t1k.216: a grouped port item's Detail shows its first fork",
  "theme-inspect": "spicode-t1k.217: a theme with an inspect id opens the queue item's Detail",
};

const holds = briefing.environment.lanes
  .filter((lane) => lane.id === "holds")
  .flatMap((lane) => lane.events)
  .map((event) => ({ event, id: event.inspect ?? `hold:${event.id}` }));

const groupedPort = (item: (typeof queue)[number]) => item.cls === "PORT" && item.ids.length > 1;

const failing: Exec = {
  runJSON: async () => ({ ok: false, error: "offline", code: 1 }),
  runText: async () => ({ ok: false, error: "offline", code: 1 }),
};

let directory: string;
let db: DatabaseSync;
const results = new Map<string, InspectResult>();

beforeAll(async () => {
  const input = recordedInput();
  const ctx = input.context;
  const fleet = watchFleet(ctx);
  const now = ctx.clock.now().getTime();
  directory = mkdtempSync(join(tmpdir(), "spi-parity-"));
  const path = join(directory, "store.sqlite");
  openRunStore(path).close();
  db = new DatabaseSync(path);
  const fence = createLeaseStore(db).acquire(fleet, "sweeper", 60_000, now);
  if (fence === undefined) throw new Error("lease not acquired");
  const { cursor: _, ...projected } = projectWatch(input);
  createSnapshotStore(db).writeSnapshot(
    { fleet, owner: "sweeper", fence },
    {
      facts: input.facts,
      cache: { ...emptyCache(), releases: { ...input.releases, records: input.releaseRecords } },
      reads: {},
    },
    projected,
    now,
  );
  db.close();
  db = new DatabaseSync(path);

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
      sent.push(parsed.message);
    },
    start() {},
  };
  const routes = new WatchRoutes({
    db: () => db,
    fleet,
    ctx,
    appData: input.appData,
    exec: failing,
    onError: (error) => {
      throw error;
    },
  });
  attachHostPort(port, 1, undefined, undefined, routes.routes);
  const ids = [
    ...queue.map(({ id }) => id),
    ...briefing.themes.map((theme) => theme.inspect ?? `theme:${theme.id}`),
    ...holds.map(({ id }) => id),
  ];
  for (const id of new Set(ids))
    receive({
      data: {
        version: PROTOCOL_VERSION,
        id,
        kind: "request",
        type: "inspect.request",
        payload: { id },
      },
    });
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
  for (const message of sent)
    if (message.type === "inspect.result")
      results.set(message.id, InspectResultSchema.parse(message.payload));
});

afterAll(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function answer(id: string): InspectResult {
  const result = results.get(id);
  if (!result) throw new Error(`No inspect.result for ${id}`);
  return result;
}

/** What the window's Detail draws from an answer: the inspector and its Related rows. */
function drawn({ actions: _a, areas: _r, provenance: _p, ...shown }: InspectResult) {
  return shown;
}

const overlaps = (hold: (typeof holds)[number]["event"], e: typeof hold) => {
  const end = (x: typeof hold) =>
    x.end === undefined ? Number.POSITIVE_INFINITY : Date.parse(x.end);
  return Date.parse(e.start) <= end(hold) && end(e) >= Date.parse(hold.start);
};

describe("Detail answers on the recorded 6 Nov sweep equal its briefing", () => {
  it.each(queue.map((item) => [item.id, item] as const))(
    "answers queue item %s with the briefing's class, cause, effect and next",
    (id, item) => {
      const result = answer(id);
      expect(result.id).toBe(id);
      expect(result.class).toBe(item.cls);
      expect(result.next).toBe(item.next);
      if (groupedPort(item)) {
        expect(GAPS["port-group"]).toBeDefined();
        expect([result.cause, result.effect]).not.toEqual([item.cause, item.effect]);
      } else {
        expect(result.cause).toBe(item.cause);
        expect(result.effect).toBe(item.effect);
      }
    },
  );

  it.each(briefing.themes.map((theme) => [theme.id, theme] as const))(
    "answers Horizon theme %s with its next step and every fork state, or names the gap",
    (_id, theme) => {
      const result = answer(theme.inspect ?? `theme:${theme.id}`);
      const related = result.related.map(({ state, text }) => `${state} | ${text}`);
      const forks = [
        ...theme.certain.map(({ fork, state }) => `certain · ${state} | ${fork}`),
        ...theme.possible.map(({ fork, state }) => `possible · ${state} | ${fork}`),
        ...theme.exposed.map((fork) => `exposed | ${fork}`),
      ];
      if (theme.inspect) {
        expect(GAPS["theme-inspect"]).toBeDefined();
        expect(result.next).not.toBe(theme.next);
        expect(forks.filter((fork) => related.includes(fork))).toEqual([]);
        return;
      }
      expect(result).toMatchObject({ cause: theme.title, effect: theme.sub, next: theme.next });
      expect(result.why).toBe(theme.when ?? "");
      expect(related).toEqual(forks);
    },
  );

  it.each(holds.map(({ id, event }) => [id, event] as const))(
    "answers hold %s with every field its Detail draws, Related runs in lane order",
    (id, event) => {
      const runs = briefing.environment.lanes
        .filter((lane) => lane.id !== "holds")
        .flatMap((lane) =>
          lane.events
            .filter((e) => overlaps(event, e))
            .map((e) => ({
              text: `${lane.label} ${e.label}`,
              state: e.detail,
              inspect: e.inspect ?? `run:${e.id}`,
            })),
        );
      expect(runs.length).toBeGreaterThan(0);
      expect(drawn(answer(id))).toEqual({
        id,
        title: `Held ${event.label}`,
        class: event.end === undefined ? "GATE" : "READY",
        cause: `Held ${event.label}`,
        effect: event.detail,
        next: "",
        why: `${event.start} to ${event.end ?? "now"}`,
        evidence: [],
        related: runs,
        approval: null,
      });
    },
  );

  it("serves the Detail feed the window's reachability suite draws, field for field", () => {
    const ids = [
      ...queue.map(({ id }) => id),
      ...briefing.themes.filter((theme) => !theme.inspect).map((theme) => `theme:${theme.id}`),
      ...holds.map(({ id }) => id),
    ];
    expect(ids.map(answer)).toEqual(JSON.parse(readFileSync(detailFeedPath, "utf8")));
  });
});
