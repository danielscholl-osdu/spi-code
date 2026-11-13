// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { watchFixtures } from "../../../../scripts/watch-generated.mjs";
import { LifecycleLaneSchema } from "./briefing.js";
import { InspectResultSchema } from "./inspect.js";
import { ViewSnapshotSchema } from "./snapshot.js";

const dir = new URL("../../../../fixtures/watch/", import.meta.url);
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
const base = ViewSnapshotSchema.parse(read("snapshot-1106.json"));
const at = "2026-11-10T08:15:00Z";
const pr = { number: 58, url: "https://github.com/org/indexer/pull/58", inspect: "gate1:indexer" };
const slot = (service: string, state: string, text: string) => ({ service, state, text });

const briefing = {
  verdict: { text: "Storage's upstream sync needs you.", mark: "stopped" },
  since: {
    basis: "fallback",
    from: "2026-11-09T08:15:00Z",
    rows: [
      {
        workflow: "sync-upstream",
        label: "Sync Upstream",
        countText: "12/13 ran ok",
        slots: [
          slot("storage", "broken", "Sync Upstream failed on storage"),
          slot("indexer", "occupied", "Sync Upstream brought commits into #58"),
          slot("legal", "unknown", "Sync Upstream ran, effect unknown"),
        ],
      },
      {
        workflow: "sync-template",
        label: "Sync Template",
        countText: "7/13 merged",
        slots: [slot("file", "done", "file merged d3ddff5"), slot("unit", "empty", "Nothing")],
      },
    ],
  },
  places: [
    {
      place: "line",
      mark: "stopped",
      tone: "bad",
      figure: "2 of 13 stopped",
      line: "Stopped: storage (sync, main), indexer-queue (main).",
      reason: "lanes: storage, indexer",
      areas: ["github", "runs"],
      itemIds: ["gate1:storage", "stack:lanes"],
      unread: { areas: ["github"], lastGood: "2026-11-10T07:52:00Z" },
      fresh: { itemIds: ["gate1:storage"] },
      visual: {
        kind: "pips",
        slots: [
          { ...slot("legal", "waiting", "legal waits on a halt"), origin: "upstream" },
          slot("storage", "broken", "storage sync stopped"),
        ],
        stopped: ["storage", "indexer-queue"],
        horizon: { count: 6, text: "6 on the horizon" },
      },
    },
    {
      place: "environment",
      mark: "in-progress",
      tone: "ok",
      figure: "v0.35.5 deployable",
      line: "Deployable again after a fork lane failed.",
      caveat: "Diffs cut on 8 services: a toolchain move could be missing.",
      areas: ["lifecycle"],
      itemIds: [],
      fresh: { itemIds: [] },
      visual: {
        kind: "lifecycle",
        lanes: [
          { lane: "refresh", green: 14, total: 16, text: "refresh 14 of 16 green" },
          { lane: "sweeper", green: 21, total: 21, text: "sweeper 21 of 21 green" },
        ],
        greenSince: "2026-11-09T22:27:00Z",
      },
    },
    {
      place: "engineering",
      mark: "in-progress",
      tone: "neutral",
      figure: "7 of 13 on d3ddff5",
      line: "Rollout in progress; verification is still pending.",
      areas: ["template"],
      itemIds: ["rollout:search", "rollout:unit"],
      fresh: { itemIds: [] },
      visual: {
        kind: "rollout",
        target: "d3ddff5",
        slots: [slot("file", "done", "file merged d3ddff5")],
      },
    },
    {
      place: "security",
      mark: "nothing-due",
      tone: "warn",
      figure: "28 high or critical",
      line: "In SPI-owned shipped code, none blocking today.",
      areas: ["security"],
      itemIds: ["security:storage"],
      fresh: { itemIds: [] },
      visual: {
        kind: "forkColumns",
        columns: [
          { service: "storage", count: 3, rules: ["CSRF"], text: "storage: 3 · CSRF" },
          { service: "unit", count: null, rules: [], text: "unit: not read" },
        ],
        program: { count: 3, rules: ["CSRF"], text: "program: 3 high or critical · CSRF" },
        largest: { label: "CSRF", forks: 12, text: "CSRF · 12 forks" },
      },
    },
  ],
  horizon: {
    headline: base.briefing.horizon.headline,
    stages: {
      upstream: { count: 71, text: "71 commits behind upstream" },
      nextSync: { at, count: 4, services: ["partition"], text: "4 at the 18:00 sync" },
      held: {
        count: 67,
        prs: [{ service: "indexer", pr }],
        services: ["indexer"],
        text: "67 in 4 open sync PRs",
      },
      forks: { services: ["file", "entitlements"], text: "current" },
      wontLand: [
        { service: "storage", reason: "stopped", count: 5, text: "won't land: sync stopped" },
      ],
    },
    cards: [
      {
        id: "toolchain:os-core-common-8.5.0",
        kind: "toolchain",
        token: "os-core-common 8.5.0",
        services: [
          { service: "indexer", stage: "held", pr },
          { service: "partition", stage: "queued", at },
        ],
        needsYou: true,
        mark: "needs-person",
        verb: "Absorb",
        itemIds: ["radar:indexer"],
        text: "Sync PRs carry os-core-common 8.5.0. Absorb it before merging.",
      },
    ],
    counts: { needYouCards: 1, toWatchCards: 0, surfaceItems: 3, text: "1 needs you" },
    owed: {
      count: 23,
      services: [
        { service: "storage", count: 20 },
        { service: "file", count: 3 },
      ],
      text: "23 upstream changes not ported · 2 forks",
    },
  },
  decisions: {
    items: 2,
    text: "2 in 1 theme",
    groups: [
      {
        id: "rollout:d3ddff5",
        theme: "rollout",
        kind: "rollout",
        token: "d3ddff5",
        scope: [{ service: "search", pr: { number: 76 } }, { service: "unit" }],
        itemIds: ["rollout:search", "rollout:unit"],
        verb: "Merge",
        text: "Template PRs wait for review.",
      },
    ],
  },
  ambient: {
    failing: {
      items: 2,
      text: "2 in 1",
      lines: [
        {
          id: "gate2:indexer-queue",
          itemIds: ["stack:lanes", "gate2:indexer-queue"],
          count: 2,
          service: "indexer-queue",
          station: "cascade",
          pr: { number: 67 },
          state: { text: "Verify", tone: "bad" },
          followUp: "after drain",
          age: "3 d",
          origin: "system",
          text: "indexer-queue release/upstream PR #67: Verify failed 3 d ago.",
        },
      ],
    },
    inProgress: {
      items: 1,
      text: "1 in 1",
      lines: [
        {
          id: "rollout:d3ddff5",
          itemIds: ["rollout:d3ddff5"],
          count: 1,
          next: ["indexer", "crs-catalog"],
          origin: "system",
          text: "Template rollout: merge indexer and crs-catalog next",
        },
      ],
    },
  },
  canWait: {
    chips: [
      { text: "232 upstream-owned", count: 232 },
      { text: "file", service: "file" },
    ],
    items: [
      {
        id: "security:upstream",
        itemIds: ["security:upstream"],
        text: "232 upstream-owned security findings",
        why: "Upstream owns the fix.",
      },
      {
        id: "service:file",
        itemIds: [],
        service: "file",
        text: "file",
        why: "No sync, gate or release waiting.",
      },
    ],
  },
};
const releases = {
  today: {
    versions: [
      {
        service: "storage",
        state: "released",
        released: "1.4.1",
        proposed: "1.4.2",
        pr: { number: 75 },
        coreLibAzure: "5.0.0",
        text: "released 1.4.1, proposed 1.4.2",
      },
      {
        service: "legal",
        state: "released",
        released: "1.2.2",
        coreLibAzure: "2.5.10",
        text: "released 1.2.2",
      },
    ],
    platform: {
      stack: "v0.35.5",
      template: { released: "v1.4.0", proposed: "1.5.0", pr: { number: 263 } },
      coreLibAzure: [
        { version: "5.0.0", count: 1 },
        { version: "2.5.10", count: 1 },
      ],
      text: "core-lib-azure 2.5.10 to 5.0.0 (5.0.0 on 1 of 2)",
    },
    readyLine: "2 release PRs wait for review, none failing",
    unread: { areas: ["releases"], lastGood: "2026-11-10T07:52:00Z" },
  },
  forming: {
    state: "partial",
    prs: [
      {
        kind: "service",
        service: "storage",
        pr: { number: 75 },
        state: "read",
        entries: [
          { kind: "breaking", title: "Drop the v1 API" },
          { kind: "other", title: "Tidy logs" },
        ],
      },
      { kind: "template", pr: { number: 263 }, state: "read", entries: [] },
      { kind: "service", service: "search", pr: { number: 76 }, state: "not-read", entries: [] },
    ],
    kinds: { breaking: 1, new: 0, improved: 0, fixed: 0, security: 0, other: 1 },
    notable: [
      {
        title: "Drop the v1 API",
        kind: "breaking",
        services: ["storage"],
        pr: { number: 75 },
        text: "Drop the v1 API on storage",
      },
    ],
    text: "Unreleased, in 3 open release PRs: 1 breaking · 1 other",
  },
};
if (!base.services?.[0]?.runs[0]) throw new Error("snapshot-1106 must carry service runs");
const [first] = base.briefing.focus;
if (!first) throw new Error("snapshot-1106 must carry a focus item");
const background = (id: string) => ({
  ...first,
  id,
  ids: [],
  attention: "background",
  owned: false,
  origin: "system",
});
const full = {
  ...base,
  briefing: {
    ...base.briefing,
    ...briefing,
    focus: base.briefing.focus.map((item) => ({ ...item, origin: "system" })),
    rest: [
      ...base.briefing.rest.map((item) => ({ ...item, origin: "upstream" })),
      background("security:storage"),
      background("security:upstream"),
    ],
  },
  releases: { ...base.releases, ...releases },
  provenance: base.provenance.filter(({ path }) => !path.startsWith("/releases/today/")),
  services: base.services.map((service) => ({
    ...service,
    runs: service.runs.map((run) => ({ ...run, completedAt: at })),
    history: [{ workflow: "sync-upstream", reach: "2026-11-09T02:10:00Z", cut: true }],
  })),
};

type Json = Record<string, unknown> | unknown[];
/** A copy of the full example with the value at an RFC 6901 pointer replaced (undefined deletes). */
function plant(pointer: string, value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(full)) as Json;
  const keys = pointer.slice(1).split("/");
  const last = keys.pop() ?? "";
  let node = copy as Record<string, unknown>;
  for (const key of keys) node = node[key] as Record<string, unknown>;
  if (value === undefined) delete node[last];
  else node[last] = value;
  return copy;
}
const valueAt = (pointer: string) => {
  let node: unknown = full;
  for (const key of pointer.slice(1).split("/")) node = (node as Record<string, unknown>)[key];
  return node as Record<string, unknown>;
};
const extra = (pointer: string) => plant(pointer, { ...valueAt(pointer), extra: true });

describe("Today's contract", () => {
  it("accepts the additive sync card kind and owed item membership", () => {
    const sync = plant("/briefing/horizon/cards/0/kind", "sync");
    expect(ViewSnapshotSchema.safeParse(sync).success).toBe(true);
    const owed = { ...briefing.horizon.owed, itemIds: ["port:storage"] };
    expect(ViewSnapshotSchema.safeParse(plant("/briefing/horizon/owed", owed)).success).toBe(true);
  });

  it("accepts a full example of every new shape and keeps every field", () => {
    expect(ViewSnapshotSchema.safeParse(full).error?.issues).toBeUndefined();
    expect(ViewSnapshotSchema.parse(full)).toEqual(full);
  });

  it.each([
    "/briefing/verdict",
    "/briefing/since",
    "/briefing/since/rows/0",
    "/briefing/since/rows/0/slots/0",
    "/briefing/places/0",
    "/briefing/places/0/unread",
    "/briefing/places/0/fresh",
    "/briefing/places/0/visual",
    "/briefing/places/0/visual/slots/0",
    "/briefing/places/0/visual/horizon",
    "/briefing/places/1/visual",
    "/briefing/places/1/visual/lanes/0",
    "/briefing/places/2/visual",
    "/briefing/places/3/visual",
    "/briefing/places/3/visual/columns/0",
    "/briefing/places/3/visual/largest",
    "/briefing/horizon",
    "/briefing/horizon/stages",
    "/briefing/horizon/stages/upstream",
    "/briefing/horizon/stages/nextSync",
    "/briefing/horizon/stages/held",
    "/briefing/horizon/stages/held/prs/0",
    "/briefing/horizon/stages/held/prs/0/pr",
    "/briefing/horizon/stages/forks",
    "/briefing/horizon/stages/wontLand/0",
    "/briefing/horizon/cards/0",
    "/briefing/horizon/cards/0/services/0",
    "/briefing/horizon/counts",
    "/briefing/horizon/owed",
    "/briefing/horizon/owed/services/0",
    "/briefing/focus/0",
    "/briefing/decisions",
    "/briefing/decisions/groups/0",
    "/briefing/decisions/groups/0/scope/0",
    "/briefing/ambient",
    "/briefing/ambient/failing",
    "/briefing/ambient/failing/lines/0",
    "/briefing/ambient/failing/lines/0/state",
    "/briefing/canWait",
    "/briefing/canWait/chips/0",
    "/briefing/canWait/items/0",
    "/releases/today",
    "/releases/today/versions/0",
    "/releases/today/platform",
    "/releases/today/platform/template",
    "/releases/today/platform/coreLibAzure/0",
    "/releases/today/unread",
    "/releases/forming",
    "/releases/forming/prs/0",
    "/releases/forming/prs/0/entries/0",
    "/releases/forming/kinds",
    "/releases/forming/notable/0",
    "/services/0/runs/0",
    "/services/0/history/0",
  ])("rejects an unknown key at %s", (pointer) => {
    expect(ViewSnapshotSchema.safeParse(extra(pointer)).success).toBe(false);
  });

  it.each([
    ["/briefing/verdict/mark", "!"],
    ["/briefing/since/basis", "yesterday"],
    ["/briefing/since/rows/0/slots/0/state", "failed"],
    ["/briefing/since/rows/0/slots/0/origin", "gitlab"],
    ["/briefing/places/0/place", "upstream"],
    ["/briefing/places/0/mark", "surface"],
    ["/briefing/places/0/tone", "run"],
    ["/briefing/places/0/areas", ["releases"]],
    ["/briefing/places/0/visual/kind", "bars"],
    ["/briefing/places/1/visual/lanes/0/lane", "deploy"],
    ["/briefing/horizon/stages/wontLand/0/reason", "held"],
    ["/briefing/horizon/cards/0/kind", "java"],
    ["/briefing/horizon/cards/0/services/0/stage", "merged"],
    ["/briefing/focus/0/origin", "both"],
    ["/briefing/focus/0/attention", "quiet"],
    ["/briefing/decisions/groups/0/kind", "release"],
    ["/briefing/ambient/failing/lines/0/station", "lane"],
    ["/briefing/ambient/failing/lines/0/origin", "fork"],
    ["/briefing/ambient/failing/lines/0/state/tone", "red"],
    ["/releases/forming/state", "unread"],
    ["/releases/forming/prs/0/kind", "stack"],
    ["/releases/forming/prs/0/state", "partial"],
    ["/releases/forming/prs/0/entries/0/kind", "deps"],
    ["/releases/forming/notable/0/kind", "chore"],
  ])("rejects %s = %j", (pointer, value) => {
    expect(ViewSnapshotSchema.safeParse(plant(pointer, value)).success).toBe(false);
  });

  it.each([
    ["a place out of sidebar order", "/briefing/places", [...briefing.places].reverse()],
    ["a repeated place", "/briefing/places", [briefing.places[0], briefing.places[0]]],
    ["another place's visual", "/briefing/places/1/visual", briefing.places[0]?.visual],
    ["unread with no areas", "/briefing/places/0/unread/areas", []],
    ["repeated unread areas", "/briefing/places/0/unread/areas", ["github", "github"]],
    ["green beyond the total", "/briefing/places/1/visual/lanes/0/green", 17],
    ["fresh as a flag", "/briefing/places/0/fresh", true],
    ["ports owed that do not sum", "/briefing/horizon/owed/count", 24],
    ["decisions that do not hold their items", "/briefing/decisions/items", 3],
    ["a group with no items", "/briefing/decisions/groups/0/itemIds", []],
    ["a line counting other than its items", "/briefing/ambient/failing/lines/0/count", 1],
    ["a run that does not hold its lines' items", "/briefing/ambient/failing/items", 1],
    ["kinds that do not sum to the entries", "/releases/forming/kinds/fixed", 1],
    ["read releases without kinds", "/releases/forming/kinds", undefined],
    [
      "an unread body with entries",
      "/releases/forming/prs/2/entries",
      [{ kind: "new", title: "x" }],
    ],
    ["a repeated history workflow", "/services/0/history/1", full.services[0]?.history[0]],
    ["a completion time without a zone", "/services/0/runs/0/completedAt", "2026-11-10T08:15"],
  ])("rejects %s", (_name, pointer, value) => {
    expect(ViewSnapshotSchema.safeParse(plant(pointer, value)).success).toBe(false);
  });

  it("carries Background items untiered to a place row's count or Can wait", () => {
    const parsed = ViewSnapshotSchema.parse(full).briefing;
    const quiet = parsed.rest.filter(({ attention }) => attention === "background");
    expect(quiet.map(({ id }) => id)).toEqual(["security:storage", "security:upstream"]);
    const counted = new Set(parsed.places?.flatMap(({ itemIds }) => itemIds));
    const waiting = new Set(parsed.canWait?.items.flatMap(({ itemIds }) => itemIds));
    expect(quiet.map(({ id }) => [counted.has(id), waiting.has(id)])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("reads an unread forming release as not read, never as zero kinds", () => {
    const unread = { state: "not-read", prs: [], notable: [], text: "not read this sweep" };
    expect(ViewSnapshotSchema.safeParse(plant("/releases/forming", unread)).success).toBe(true);
    const zeros = { ...unread, kinds: releases.forming.kinds };
    expect(ViewSnapshotSchema.safeParse(plant("/releases/forming", zeros)).success).toBe(false);
  });
});

describe("existing Watch fixtures", () => {
  const fixtures = watchFixtures();
  const names = fixtures.map(({ name }) => name);
  it("include snapshots and inspect feeds", () => {
    expect(names.some((name) => name.startsWith("snapshot-"))).toBe(true);
    expect(names.some((name) => name.startsWith("inspect-"))).toBe(true);
  });
  it.each(names)("still parse: %s", (name) => {
    const schema = name.startsWith("inspect-") ? z.array(InspectResultSchema) : ViewSnapshotSchema;
    const { path } = fixtures.find((fixture) => fixture.name === name) ?? { path: "" };
    expect(schema.safeParse(JSON.parse(readFileSync(path, "utf8"))).error).toBeUndefined();
  });
});

it("carries an explicit unknown lifecycle pass rate without claiming 0 of 0", () => {
  const lane = {
    lane: "refresh",
    green: 0,
    total: 0,
    state: "unknown",
    text: "refresh: 21-day pass rate not read yet",
  };
  expect(LifecycleLaneSchema.parse(lane)).toEqual(lane);
  expect(LifecycleLaneSchema.safeParse({ ...lane, state: "green" }).success).toBe(false);
});
