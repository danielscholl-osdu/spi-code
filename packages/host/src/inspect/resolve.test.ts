// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Message, PROTOCOL_VERSION, type ViewSnapshot } from "@spi-code/contracts";
import {
  checkable,
  type Exec,
  emptyCache,
  inspectUpstreamFork,
  mrTitle,
  STEP_PREFIX,
} from "@spi-code/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WatchRoutes, watchFleet } from "../process/routes.js";
import { createLeaseStore } from "../store/leases.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { openRunStore } from "../store/store.js";
import { projectWatch } from "../watch/project.js";
import { fixtureInput } from "../watch/snapshot-fixture.js";
import { inspectResult } from "./item.js";
import {
  INSPECT_TABLE,
  type InspectRow,
  type InspectScope,
  type InspectSnapshot,
  inspectScope,
  resolveIn,
  resolveInspect,
} from "./resolve.js";
import { upstreamForkResult } from "./upstream.js";

const input = fixtureInput();
const ctx = input.context;
const view = projectWatch(input);
const releases = { ...input.releases, records: input.releaseRecords };
const snapshot: InspectSnapshot = { view, facts: input.facts, releases };
const failing: Exec = {
  runJSON: async () => {
    return { ok: false, error: "offline", code: 1 };
  },
  runText: async () => {
    return { ok: false, error: "offline", code: 1 };
  },
};
const deps = { ctx, exec: failing, appData: input.appData };
const scope = inspectScope(snapshot, deps);
const claimedBy = (id: string, at: InspectScope = scope) =>
  INSPECT_TABLE.find((row) => row.claims(id, at))?.kind;

const step = scope.model.template.steps[0]?.marker;
const fork = scope.model.upstream.forks[0]?.service;
const mr = Object.entries(scope.model.radar.services)
  .flatMap(([name, service]) => service.possible.map((v) => `mr:${name}:${v.mr?.iid}`))
  .find((id) => mrTitle(scope.model, id));
const item = scope.model.queue.items.find((entry) => !checkable(entry.halt));
if (!step || !fork || !mr || !item) throw new Error("Fixture ids missing");

describe("the inspect table", () => {
  it("keeps the chain's order, so a queue item's own id wins over a prefix that also claims it", async () => {
    expect(INSPECT_TABLE.map((row) => row.kind)).toEqual([
      "queue item",
      "step",
      "MR",
      "upstream plan",
      "upstream fork",
      "release",
      "repository",
      "service",
      "run",
      "hold",
      "theme",
      "station",
      "repository line",
    ]);
    const id = `upstream:${fork}`;
    const board = inspectUpstreamFork(scope.model, fork, scope.now);
    if (!board) throw new Error("Fixture fork missing");
    const forkResult = upstreamForkResult(id, board, view.areas);
    expect(await resolveIn(scope, id)).toEqual(forkResult);
    const queued = { ...item, id };
    const colliding: InspectScope = {
      ...scope,
      model: { ...scope.model, queue: { ...scope.model.queue, items: [queued] } },
    };
    expect(claimedBy(id, colliding)).toBe("queue item");
    const result = await resolveIn(colliding, id);
    expect(result).toEqual(
      await inspectResult(colliding.model, queued, scope.now, ctx, failing, view.areas),
    );
    expect(result).not.toEqual(forkResult);
  });

  it.each([
    ["queue item", item.id],
    ["step", `${STEP_PREFIX}${step}`],
    ["MR", mr],
    ["upstream plan", "upstream"],
    ["upstream fork", "upstream:x"],
    ["release", "release:x"],
    ["repository", "repo:x"],
    ["service", "service:x"],
    ["run", "run:x"],
    ["hold", "hold:x"],
    ["theme", "theme:x"],
    ["station", "station:x"],
    ["repository line", "pr:x"],
    ["repository line", "issue:x"],
    ["repository line", "alert:x"],
  ])("has a row for the chain's %s branch (%s)", (kind, id) => {
    expect(claimedBy(id)).toBe(kind);
  });
});

describe("an id the latest sweep cannot answer", () => {
  it.each(["", "nope", "nope:1", "step:", "mr:", "Upstream", "upstream-x", "stack:lanes:x"])(
    "has no row and resolves to undefined (%j)",
    async (id) => {
      expect(claimedBy(id)).toBeUndefined();
      expect(await resolveInspect(snapshot, id, deps)).toBeUndefined();
    },
  );

  it.each([
    ["upstream fork", "upstream:nope"],
    ["release", "release:2026-13"],
    ["release", "release:1999-01"],
    ["repository", "repo:nope"],
    ["service", "service:nope"],
    ["run", "run:0"],
    ["hold", "hold:nope"],
    ["theme", "theme:nope"],
    ["station", `station:${fork}:nope`],
    ["repository line", "pr:nope"],
    ["repository line", "issue:nope"],
    ["repository line", "alert:nope"],
  ])("is claimed by the %s row, finds nothing and resolves to undefined (%s)", async (kind, id) => {
    expect(claimedBy(id)).toBe(kind);
    expect(await resolveInspect(snapshot, id, deps)).toBeUndefined();
  });

  it("answers only from the first row that claims it, never a later one", async () => {
    const answer = await resolveIn(scope, "upstream");
    const table: InspectRow[] = [
      { kind: "empty", claims: (id) => id.startsWith("a:"), resolve: () => undefined },
      { kind: "any", claims: () => true, resolve: () => answer },
    ];
    expect(answer).toBeDefined();
    expect(await resolveIn(scope, "a:1", table)).toBeUndefined();
    expect(await resolveIn(scope, "b:1", table)).toBe(answer);
  });
});

describe("inspect.request", () => {
  let directory: string;
  let db: DatabaseSync;
  let fence: number | undefined;
  const fleet = watchFleet(ctx);
  const now = ctx.clock.now().getTime();

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "spi-inspect-"));
    const path = join(directory, "store.sqlite");
    openRunStore(path).close();
    db = new DatabaseSync(path);
    fence = undefined;
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function write(edit: (stored: Omit<ViewSnapshot, "cursor">) => Omit<ViewSnapshot, "cursor">) {
    fence ??= createLeaseStore(db).acquire(fleet, "sweeper", 60_000, now);
    if (fence === undefined) throw new Error("lease not acquired");
    const { cursor: _, ...stored } = view;
    createSnapshotStore(db).writeSnapshot(
      { fleet, owner: "sweeper", fence },
      { facts: input.facts, cache: { ...emptyCache(), releases }, reads: {} },
      edit(stored),
      now,
    );
  }

  async function request(id: string): Promise<Message | undefined> {
    const watch = new WatchRoutes({
      db: () => db,
      fleet,
      ctx,
      appData: input.appData,
      exec: failing,
      onError: (error) => {
        throw error;
      },
    });
    const sent: Message[] = [];
    await watch.routes["inspect.request"]?.(
      {
        version: PROTOCOL_VERSION,
        id: "req",
        kind: "request",
        type: "inspect.request",
        payload: { id },
      },
      (message) => sent.push(message),
    );
    return sent[0];
  }

  const theme = view.briefing.themes[0]?.id;

  it("says no sweep has been persisted when there is none", async () => {
    expect(await request("upstream")).toMatchObject({
      id: "req",
      type: "error",
      payload: { code: "not_found", message: "No sweep has been persisted for this fleet" },
    });
  });

  it("answers not_found for an id an older snapshot held but the latest does not", async () => {
    if (!theme) throw new Error("Fixture theme missing");
    write((stored) => stored);
    expect(await request(`theme:${theme}`)).toMatchObject({
      type: "inspect.result",
      payload: { id: `theme:${theme}` },
    });
    write((stored) => ({
      ...stored,
      briefing: {
        ...stored.briefing,
        themes: stored.briefing.themes.map((t) => ({ ...t, id: `${t.id}-later` })),
      },
    }));
    for (const id of [`theme:${theme}`, "nope:1"]) {
      expect(await request(id)).toMatchObject({
        id: "req",
        type: "error",
        payload: { code: "not_found", message: "Nothing in the latest sweep has this id" },
      });
    }
  });
});
