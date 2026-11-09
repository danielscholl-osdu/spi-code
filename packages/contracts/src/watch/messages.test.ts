// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMessage } from "../index.js";
import { BriefingSchema } from "./briefing.js";
import { AREAS, EnvelopeSchema, type ReadRecord, ReadRecordSchema } from "./evidence.js";
import { InspectResultSchema, ItemClassSchema } from "./inspect.js";
import {
  PROTOCOL_VERSION,
  SWEEP_REASON_MAX_LENGTH,
  type SweepProgress,
  type WatchMessage,
  WatchMessageSchema,
} from "./messages.js";
import { ReleasesPaneSchema, type ViewSnapshot } from "./snapshot.js";
import { ServiceStationsSchema, StationIdSchema } from "./stations.js";
import { TreeStatusSchema } from "./tree.js";

const at = "2026-11-05T06:00:00Z";
const record = {
  source: "github",
  object: "osdu-spi",
  observedAt: at,
  completeness: { kind: "cut", reason: "page limit", read: 10, total: 20 },
  failure: "read failed",
  retainedFrom: "2026-11-04T06:00:00Z",
  inferred: true,
} satisfies ReadRecord;
const inspect = {
  id: "main:osdu-spi",
  class: "BUILD",
  cause: "main is red",
  effect: "sync is blocked",
  next: "Fix the build.",
  why: "The latest build failed.",
  evidence: [record],
  related: [
    {
      text: "another fork",
      state: "blocked",
      inspect: "main:fork",
      url: "https://github.com/org/fork",
    },
  ],
  approval: { id: "approval-1", state: "pending", reason: "external author" },
  actions: [
    {
      id: "rerun",
      label: "Re-run when deployable",
      disabledReason: "writes arrive at M4",
      eligibilityReason: "environment is not deployable",
    },
  ],
} as const;
const envelope = { version: PROTOCOL_VERSION, id: "watch-1" } as const;
function oracle(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../fixtures/rib-59d6895/oracle/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}
const briefing = BriefingSchema.parse(oracle("briefing"));
const snapshot = {
  cursor: 1,
  sweptAt: at,
  briefing: {
    ...briefing,
    focus: briefing.focus.map((item) => ({ ...item, attention: "ambient", owned: false })),
    rest: briefing.rest.map((item) => ({ ...item, attention: "ambient", owned: false })),
  },
  campaigns: [],
  readings: [],
  seen: { cursor: null, since: [] },
  releases: ReleasesPaneSchema.parse(oracle("releases")),
  stations: [
    {
      service: "legal",
      stations: [
        { id: "upstream", state: "moving", substate: "in-progress", text: "4 commits held" },
        { id: "sync", state: "stopped", substate: "stopped", text: "Java Build failed" },
        { id: "cascade", state: "idle", substate: "ready", text: "" },
        { id: "main", state: "unknown", substate: "ready", text: "" },
        { id: "release", state: "waiting", substate: "waiting-on-person", text: "Needs review" },
        { id: "lane", state: "stopped", substate: "stopped", text: "Environment held" },
      ],
    },
  ],
  tree: [{ id: "today", status: "failed" }],
  reads: [record],
  areas: AREAS.map((area) => ({ area, envelope: { source: area, state: "unread" as const } })),
  provenance: [{ path: "/stations/0/stations/4", areas: ["github"] }],
  selection: "today",
} satisfies ViewSnapshot;
const progress = {
  sweep: "sweep-1",
  startedAt: at,
  first: true,
  usualMs: null,
  outcome: "running",
  nextAttemptAt: null,
  sources: [
    {
      source: "github",
      state: "cut",
      startedAt: at,
      endedAt: "2026-11-05T06:00:52Z",
      code: "limit",
      reason: "page limit",
      incomplete: { count: 6, total: 13 },
    },
    { source: "gitlab", state: "read", startedAt: at, endedAt: "2026-11-05T06:00:31Z" },
    {
      source: "workflows",
      state: "deferred",
      code: "budget",
      reason: "waits for GitHub budget",
      resumeAt: "2026-11-05T07:10:00Z",
    },
    {
      source: "pulls",
      state: "throttled",
      startedAt: at,
      code: "throttled",
      reason: "GitHub asked SPI Code to slow down.",
      resumeAt: "2026-11-05T06:04:00Z",
    },
    { source: "security", state: "skipped", code: "cadence", reason: "not due" },
    {
      source: "issues",
      state: "failed",
      startedAt: at,
      endedAt: at,
      code: "signin",
      reason: "glab is not signed in.",
    },
    { source: "stack", state: "reading", startedAt: at },
    { source: "releases", state: "waiting" },
  ],
} satisfies SweepProgress;
const messages = [
  { ...envelope, kind: "request", type: "inspect.request", payload: { id: "main:osdu-spi" } },
  {
    ...envelope,
    kind: "response",
    type: "inspect.result",
    payload: {
      ...inspect,
      evidence: [record],
      related: [...inspect.related],
      actions: [...inspect.actions],
    },
  },
  {
    ...envelope,
    kind: "event",
    type: "sweep.status",
    payload: {
      remaining: 100,
      resetAt: at,
      deferredAreas: [{ area: "security", reason: "budget floor" }],
      nextSweepAt: "2026-11-05T06:05:00Z",
      schedule: {
        sweepMs: 300_000,
        gitlabMs: 1_800_000,
        securityMs: 1_800_000,
        releasesMs: 3_600_000,
      },
      lastSweep: {
        sweep: "sweep-1",
        startedAt: at,
        endedAt: "2026-11-05T06:01:12Z",
        outcome: "failed",
        code: "signin",
        requested: true,
      },
    },
  },
  {
    ...envelope,
    kind: "event",
    type: "setup.state",
    payload: {
      watchReady: false,
      disabledReason: "Sign in to gh",
      tools: [
        {
          tool: "gh",
          state: "scope-missing",
          action: "signin",
          scopes: ["repo"],
          missingScopes: ["workflow"],
          reason: "workflow scope missing",
        },
      ],
    },
  },
  { ...envelope, kind: "request", type: "setup.install", payload: { tool: "git" } },
  { ...envelope, kind: "request", type: "setup.signin", payload: { tool: "gh" } },
  {
    ...envelope,
    kind: "event",
    type: "setup.signin.progress",
    payload: {
      requestId: "signin-1",
      tool: "gh",
      state: "device-code",
      deviceCode: "ABCD-1234",
      url: "https://github.com/login/device",
    },
  },
  { ...envelope, kind: "request", type: "view.subscribe", payload: { fromCursor: 0 } },
  { ...envelope, kind: "event", type: "view.snapshot", payload: snapshot },
  { ...envelope, kind: "request", type: "view.acknowledge", payload: { cursor: 1 } },
  { ...envelope, kind: "request", type: "setup.check", payload: {} },
  {
    ...envelope,
    kind: "request",
    type: "setup.signin.cancel",
    payload: { requestId: "signin-1" },
  },
  { ...envelope, kind: "event", type: "sweep.progress", payload: progress },
  { ...envelope, kind: "request", type: "sweep.request", payload: {} },
] satisfies [
  WatchMessage,
  WatchMessage,
  WatchMessage,
  WatchMessage,
  WatchMessage,
  WatchMessage,
  WatchMessage,
  WatchMessage,
  WatchMessage,
  WatchMessage,
  WatchMessage,
  WatchMessage,
  WatchMessage,
  WatchMessage,
];

describe("sweep progress", () => {
  const event = messages[12];
  const parse = (payload: unknown) => parseMessage({ ...event, payload });
  const withSource = (source: unknown) => parse({ ...progress, sources: [source] });
  const failed = {
    ...progress,
    outcome: "failed",
    code: "unavailable",
    failure: "GitHub answered with a server error.",
    source: "stack",
    nextAttemptAt: "2026-11-05T06:07:00Z",
  } as const;
  it.each([
    ["running", progress],
    ["committed", { ...progress, outcome: "committed", usualMs: 120_000, first: false }],
    ["cancelled", { ...progress, outcome: "cancelled", sources: [] }],
    ["failed while reading", failed],
    [
      "failed while saving with no retry",
      { ...failed, code: "save", source: undefined, nextAttemptAt: null },
    ],
  ])("round-trips a %s state", (_, payload) => {
    const message = { ...event, payload: JSON.parse(JSON.stringify(payload)) };
    expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
  });
  it("rejects a failed outcome without its failure, and failure or retry on other outcomes", () => {
    const { failure, ...withoutFailure } = failed;
    expect(parse(withoutFailure).ok).toBe(false);
    const { code, ...withoutCode } = failed;
    expect(parse(withoutCode).ok).toBe(false);
    const { nextAttemptAt, ...withoutRetry } = failed;
    expect(parse(withoutRetry).ok).toBe(false);
    for (const outcome of ["running", "committed", "cancelled"]) {
      expect(parse({ ...progress, outcome }).ok).toBe(true);
      expect(parse({ ...progress, outcome, failure, code }).ok).toBe(false);
      expect(parse({ ...progress, outcome, nextAttemptAt }).ok).toBe(false);
      expect(parse({ ...progress, outcome, source: "stack" }).ok).toBe(false);
    }
    expect(parse({ ...failed, source: "packages" }).ok).toBe(false);
  });
  it("names no source for a failure while saving", () => {
    expect(parse({ ...failed, code: "save", source: undefined }).ok).toBe(true);
    expect(parse({ ...failed, code: "save" }).ok).toBe(false);
  });
  it("rejects unknown outcomes, source states and reason codes", () => {
    for (const outcome of ["done", "skipped", "", null]) {
      expect(parse({ ...progress, outcome }).ok).toBe(false);
    }
    for (const state of ["queued", "complete", "paused", ""]) {
      expect(withSource({ source: "github", state }).ok).toBe(false);
    }
    for (const code of ["auth", "502", "", null]) {
      expect(parse({ ...failed, code }).ok).toBe(false);
      expect(withSource({ source: "github", state: "failed", code, reason: "failed" }).ok).toBe(
        false,
      );
    }
  });
  it("tells a throttled pause from a budget deferral", () => {
    const pause = { source: "pulls", code: "throttled", reason: "slow down" } as const;
    const throttled = { ...pause, state: "throttled", resumeAt: at } as const;
    const deferred = { ...pause, state: "deferred", code: "budget" } as const;
    expect(withSource(throttled).ok).toBe(true);
    expect(withSource(deferred).ok).toBe(true);
    expect(withSource({ ...deferred, resumeAt: at }).ok).toBe(true);
    expect(withSource({ ...throttled, resumeAt: undefined }).ok).toBe(false);
    expect(withSource({ ...throttled, endedAt: "2026-11-05T06:01:00Z" }).ok).toBe(false);
  });
  it.each([
    ["incomplete on read", { source: "a", state: "read", incomplete: { count: 1, total: 2 } }],
    ["cut without incomplete", { source: "a", state: "cut" }],
    [
      "incomplete on failed",
      {
        source: "a",
        state: "failed",
        code: "other",
        reason: "x",
        incomplete: { count: 1, total: 2 },
      },
    ],
    ["resumeAt on read", { source: "a", state: "read", resumeAt: at }],
    [
      "resumeAt on failed",
      { source: "a", state: "failed", code: "other", reason: "x", resumeAt: at },
    ],
    ["resumeAt on reading", { source: "a", state: "reading", startedAt: at, resumeAt: at }],
    ["endedAt on reading", { source: "a", state: "reading", startedAt: at, endedAt: at }],
    ["endedAt on waiting", { source: "a", state: "waiting", endedAt: at }],
    ["startedAt on waiting", { source: "a", state: "waiting", startedAt: at }],
    ["reading without startedAt", { source: "a", state: "reading" }],
    [
      "endedAt before startedAt",
      { source: "a", state: "read", startedAt: at, endedAt: "2026-11-05T05:59:59Z" },
    ],
    ["reason on waiting", { source: "a", state: "waiting", code: "other", reason: "x" }],
    ["reason on read", { source: "a", state: "read", code: "other", reason: "x" }],
    ["failed without reason", { source: "a", state: "failed", code: "other" }],
    ["failed without code", { source: "a", state: "failed", reason: "x" }],
    ["deferred without reason", { source: "a", state: "deferred" }],
    ["throttled without code", { source: "a", state: "throttled", reason: "x", resumeAt: at }],
    ["skipped reason without code", { source: "a", state: "skipped", reason: "not due" }],
    [
      "cut code without reason",
      { source: "a", state: "cut", code: "limit", incomplete: { count: 1, total: 2 } },
    ],
  ])("rejects %s", (_, source) => {
    expect(withSource(source).ok).toBe(false);
  });
  it("rejects extra keys at every level", () => {
    const [source] = progress.sources;
    expect(withSource({ ...source, completeness: { kind: "complete" } }).ok).toBe(false);
    expect(withSource({ ...source, incomplete: { count: 6, total: 13, read: 7 } }).ok).toBe(false);
    expect(parse({ ...failed, output: "gh: HTTP 502" }).ok).toBe(false);
    expect(parseMessage({ ...messages[13], payload: { force: true } }).ok).toBe(false);
  });
  it("carries a cut kind without changing older cut messages", () => {
    const source = { source: "lifecycle", state: "cut", incomplete: { count: 1, total: 69 } };
    expect(withSource(source).ok).toBe(true);
    for (const cutKind of ["job-log", "diff", "run-list", "read"]) {
      expect(withSource({ ...source, cutKind }).ok).toBe(true);
    }
    expect(withSource({ ...source, cutKind: "stderr" }).ok).toBe(false);
    expect(withSource({ source: "lifecycle", state: "read", cutKind: "job-log" }).ok).toBe(false);
  });
  it("carries failed reads on a cut source without changing older cut messages", () => {
    const failure = "Reads failed for 3 services: unit, crs-catalog, crs-conversion.";
    const partial = {
      source: "radar",
      state: "cut",
      incomplete: { count: 0, total: 361, failed: 3 },
    };
    expect(withSource(partial).ok).toBe(true);
    expect(withSource({ ...partial, failure }).ok).toBe(true);
    expect(
      withSource({
        ...partial,
        incomplete: { count: 14, total: 361, failed: 3 },
        cutKind: "diff",
        code: "limit",
        reason: "Oversized or collapsed diffs",
        failure,
      }).ok,
    ).toBe(true);
    for (const invalid of [
      { ...partial, incomplete: { count: 0, total: 361, failed: 0 } },
      { ...partial, incomplete: { count: 359, total: 361, failed: 3 } },
      { ...partial, cutKind: "diff" },
      { ...partial, code: "limit", reason: "Oversized or collapsed diffs" },
      { source: "radar", state: "cut", incomplete: { count: 1, total: 2 }, failure },
      { source: "radar", state: "failed", code: "other", reason: "x", failure },
      { ...partial, failure: "" },
    ]) {
      expect(withSource(invalid).ok).toBe(false);
    }
  });
  it("bounds every reason", () => {
    const source = progress.sources[5];
    const bounded = "x".repeat(SWEEP_REASON_MAX_LENGTH);
    const over = `${bounded}x`;
    expect(parse({ ...failed, failure: bounded }).ok).toBe(true);
    expect(withSource({ ...source, reason: bounded }).ok).toBe(true);
    expect(parse({ ...failed, failure: over }).ok).toBe(false);
    expect(parse({ ...failed, failure: "" }).ok).toBe(false);
    expect(withSource({ ...source, reason: over }).ok).toBe(false);
    expect(withSource({ ...source, reason: "" }).ok).toBe(false);
  });
  it("rejects bad times, counts and repeated sources", () => {
    const [source] = progress.sources;
    for (const incomplete of [
      { count: 14, total: 13 },
      { count: 0, total: 13 },
      { count: 0, total: 0 },
      { count: 1.5, total: 13 },
    ]) {
      expect(withSource({ ...source, incomplete }).ok).toBe(false);
    }
    expect(withSource({ ...progress.sources[2], resumeAt: "08:04" }).ok).toBe(false);
    expect(parse({ ...progress, usualMs: 0 }).ok).toBe(false);
    expect(parse({ ...failed, nextAttemptAt: "soon" }).ok).toBe(false);
    expect(parse({ ...progress, sources: [source, source] }).ok).toBe(false);
  });
  it("round-trips sweep.request with an empty payload or now: true only", () => {
    const message = messages[13];
    expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
    const now = { ...message, payload: { now: true } };
    expect(parseMessage(JSON.parse(JSON.stringify(now)))).toEqual({ ok: true, message: now });
    for (const payload of [
      null,
      undefined,
      [],
      { area: "github" },
      { now: false },
      { now: "yes" },
      { now: 1 },
      { now: true, area: "github" },
    ]) {
      expect(parseMessage({ ...message, payload }).ok).toBe(false);
    }
    expect(parseMessage({ ...message, kind: "event" }).ok).toBe(false);
  });
});

describe("Watch protocol", () => {
  it("round-trips a check-all request and rejects tool, credential and envelope additions", () => {
    const message = messages[10];
    expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
    for (const payload of [{ tool: "gh" }, { token: "opaque.credential" }, null]) {
      expect(parseMessage({ ...message, payload }).ok).toBe(false);
    }
    expect(parseMessage({ ...message, kind: "event" }).ok).toBe(false);
  });
  it("round-trips a sign-in cancellation naming the original request", () => {
    const message = messages[11];
    expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
    for (const payload of [
      {},
      { requestId: "" },
      { requestId: null },
      { requestId: 1 },
      { requestId: "signin-1", tool: "gh" },
      { requestId: "signin-1", token: "opaque.credential" },
    ]) {
      expect(parseMessage({ ...message, payload }).ok).toBe(false);
    }
    expect(parseMessage({ ...message, kind: "event" }).ok).toBe(false);
  });
  it("round-trips a completed setup check time, retaining support for older state fixtures", () => {
    const message = {
      ...messages[3],
      payload: { ...messages[3].payload, checkedAt: at },
    };
    expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
    expect(parseMessage(messages[3]).ok).toBe(true);
    for (const checkedAt of ["yesterday", "", null, 42, "2026-11-05T06:00:00"]) {
      expect(parseMessage({ ...message, payload: { ...message.payload, checkedAt } }).ok).toBe(
        false,
      );
    }
  });
  it("round-trips an acknowledgement and rejects missing, invalid or extra fields", () => {
    const message = messages[9];
    expect(WatchMessageSchema.parse(message)).toEqual(message);
    for (const payload of [
      {},
      { cursor: -1 },
      { cursor: 1.5 },
      { cursor: "1" },
      { cursor: 1, pins: [] },
    ]) {
      expect(WatchMessageSchema.safeParse({ ...message, payload }).success).toBe(false);
    }
  });
  it("accepts legacy payloads and optional service, line and inspect additions", () => {
    expect(WatchMessageSchema.parse(messages[8])).toEqual(messages[8]);
    expect(InspectResultSchema.parse(inspect)).toEqual(inspect);
    const service = snapshot.stations[0];
    if (!service) throw new Error("Fixture must have service stations");
    const additions = {
      service: service.service,
      runs: [
        {
          id: "run:42",
          workflow: "Sync Upstream",
          result: "success",
          time: at,
          url: "https://github.com/org/legal/actions/runs/42",
        },
      ],
      releases: [
        {
          id: "legal",
          group: "Services",
          month: "2026-11",
          version: "v1",
          releases: 1,
          state: "released",
          gate: { state: "waiting", text: "gate 3" },
          releasePr: {
            number: 7,
            title: "chore: release",
            url: "https://github.com/org/legal/pull/7",
          },
        },
      ],
    };
    const payload = {
      ...snapshot,
      stations: snapshot.stations.map((service) => ({
        ...service,
        stations: service.stations.map((station) => ({
          ...station,
          inspect: `station:legal:${station.id}`,
        })),
      })),
      services: [additions],
    };
    const message = { ...messages[8], payload };
    expect(WatchMessageSchema.parse(message)).toEqual(message);
    expect(InspectResultSchema.parse({ ...inspect, title: "Build" })).toEqual({
      ...inspect,
      title: "Build",
    });
    for (const runs of [
      [{ ...additions.runs[0], time: "yesterday" }],
      [{ ...additions.runs[0], url: "javascript:alert(1)" }],
      [{ ...additions.runs[0], extra: true }],
    ]) {
      expect(
        WatchMessageSchema.safeParse({
          ...message,
          payload: { ...payload, services: [{ ...additions, runs }] },
        }).success,
      ).toBe(false);
    }
    expect(
      WatchMessageSchema.safeParse({
        ...message,
        payload: {
          ...payload,
          services: [
            {
              ...additions,
              releases: [{ ...additions.releases[0], month: "2026-13" }],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it.each([undefined, 0, 100])("round-trips an optional budget floor of %s", (floor) => {
    const message = {
      ...messages[2],
      payload: { ...messages[2].payload, ...(floor === undefined ? {} : { floor }) },
    };
    expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
  });
  it.each([-1, 1.5, null, "100"])("rejects an invalid budget floor of %s", (floor) => {
    expect(
      parseMessage({
        ...messages[2],
        payload: { ...messages[2].payload, floor },
      }).ok,
    ).toBe(false);
  });
  describe("sweep status schedule", () => {
    const status = messages[2];
    const parse = (payload: unknown) => parseMessage({ ...status, payload });
    const last = status.payload.lastSweep;
    it("round-trips the next sweep, the schedule and the last sweep", () => {
      expect(parseMessage(JSON.parse(JSON.stringify(status)))).toEqual({
        ok: true,
        message: status,
      });
    });
    it("accepts null for the next sweep and the last sweep", () => {
      expect(parse({ ...status.payload, nextSweepAt: null, lastSweep: null }).ok).toBe(true);
    });
    it.each(["nextSweepAt", "schedule", "lastSweep"])("requires %s", (field) => {
      const payload = { ...status.payload };
      Reflect.deleteProperty(payload, field);
      expect(parse(payload).ok).toBe(false);
    });
    it.each([
      ["status", { ...status.payload, next: null }],
      ["schedule", { ...status.payload, schedule: { ...status.payload.schedule, radarMs: 1 } }],
      ["last sweep", { ...status.payload, lastSweep: { ...last, cursor: 4 } }],
    ])("rejects an unknown %s field", (_, payload) => {
      expect(parse(payload).ok).toBe(false);
    });
    it.each([
      ["a schedule cadence of zero", { schedule: { ...status.payload.schedule, sweepMs: 0 } }],
      ["a fractional cadence", { schedule: { ...status.payload.schedule, gitlabMs: 1.5 } }],
      ["a missing cadence", { schedule: { sweepMs: 1, gitlabMs: 1, securityMs: 1 } }],
      ["a next sweep without a zone", { nextSweepAt: "2026-11-05T06:05:00" }],
      ["a running last sweep", { lastSweep: { ...last, outcome: "running" } }],
      ["a failed last sweep without its code", { lastSweep: { ...last, code: undefined } }],
      ["a committed last sweep with a code", { lastSweep: { ...last, outcome: "committed" } }],
      ["a last sweep with an unknown code", { lastSweep: { ...last, code: "network" } }],
      ["a last sweep without requested", { lastSweep: { ...last, requested: undefined } }],
      ["a last sweep that ends first", { lastSweep: { ...last, endedAt: "2026-11-05T05:59:00Z" } }],
    ])("rejects %s", (_, fields) => {
      expect(parse(JSON.parse(JSON.stringify({ ...status.payload, ...fields }))).ok).toBe(false);
    });
    it.each(["committed", "cancelled"] as const)("accepts a %s last sweep", (outcome) => {
      const { code: _code, ...rest } = last;
      expect(
        parse({ ...status.payload, lastSweep: { ...rest, outcome, requested: false } }).ok,
      ).toBe(true);
    });
    it("rejects the status under the previous protocol version", () => {
      expect(parseMessage({ ...status, version: 2 }).ok).toBe(false);
    });
  });
  it("round-trips a full snapshot fixture through the Watch schema and shared parser", () => {
    const message = messages[8];
    const wire: unknown = JSON.parse(JSON.stringify(message));
    expect(WatchMessageSchema.parse(wire)).toEqual(message);
    expect(parseMessage(wire)).toEqual({ ok: true, message });
    expect(parseMessage({ ...message, payload: { ...snapshot, selection: null } }).ok).toBe(true);
  });
  it.each([
    { ...snapshot, extra: true },
    { ...snapshot, cursor: -1 },
    { ...snapshot, cursor: 0.5 },
    { ...snapshot, sweptAt: "yesterday" },
    { ...snapshot, selection: "" },
    { ...snapshot, reads: [{ ...record, observedAt: "yesterday" }] },
    { ...snapshot, tree: [{ id: "today", status: "unknown" }] },
    { ...snapshot, stations: [{ service: "legal", stations: [] }] },
    { ...snapshot, releases: { ...snapshot.releases, extra: true } },
    {
      ...snapshot,
      releases: { ...snapshot.releases, lines: [{ ...snapshot.releases.lines[0], notes: "bad" }] },
    },
    {
      ...snapshot,
      briefing: {
        ...snapshot.briefing,
        focus: [{ ...snapshot.briefing.focus[0], rung: 3 }],
      },
    },
  ])("rejects invalid nested snapshot fields", (payload) => {
    expect(parseMessage({ ...messages[8], payload }).ok).toBe(false);
  });
  it.each(messages)("round-trips $type through the shared parser", (message) => {
    expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
  });
  it.each([{ tool: "glab" }, { tool: "glab", token: "opaque.credential" }])(
    "round-trips the transient glab sign-in input",
    (payload) => {
      const message = { ...messages[5], payload };
      expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
    },
  );
  it.each([
    { tool: "gh", token: "opaque.credential" },
    { tool: "copilot", token: "opaque.credential" },
    { tool: "glab", token: "" },
    { tool: "glab", token: "x".repeat(7) },
    { tool: "glab", token: "x".repeat(4097) },
    ...[
      " leading",
      "trailing ",
      "trailing\n",
      "trailing\r",
      "embedded space",
      "line\nbreak",
      "tab\tbreak",
    ].map((token) => ({
      tool: "glab",
      token,
    })),
  ])("rejects disallowed credentials", (payload) => {
    expect(parseMessage({ ...messages[5], payload }).ok).toBe(false);
  });
  it("accepts the credential length boundary and keeps the sign-in object strict", () => {
    expect(
      parseMessage({ ...messages[5], payload: { tool: "glab", token: "x".repeat(8) } }).ok,
    ).toBe(true);
    expect(
      parseMessage({ ...messages[5], payload: { tool: "glab", token: "x".repeat(4096) } }).ok,
    ).toBe(true);
    expect(
      parseMessage({ ...messages[5], payload: { tool: "glab", token: "x".repeat(8), extra: true } })
        .ok,
    ).toBe(false);
  });
  it("rejects credential fields in every progress and status shape", () => {
    const token = "opaque.credential";
    for (const state of ["starting", "waiting", "completed", "failed", "device-code"]) {
      const payload = {
        ...messages[6].payload,
        tool: "glab",
        state,
        ...(state === "failed" ? { reason: "failed" } : {}),
      };
      const { deviceCode, url, ...withoutCode } = payload;
      const progress = state === "device-code" ? payload : withoutCode;
      expect(parseMessage({ ...messages[6], payload: progress }).ok).toBe(true);
      expect(parseMessage({ ...messages[6], payload: { ...progress, token } }).ok).toBe(false);
    }
    for (const index of [2, 3] as const) {
      expect(
        parseMessage({ ...messages[index], payload: { ...messages[index].payload, token } }).ok,
      ).toBe(false);
    }
    expect(
      parseMessage({
        ...messages[3],
        payload: {
          ...messages[3].payload,
          tools: [{ tool: "glab", state: "ready", action: null, token }],
        },
      }).ok,
    ).toBe(false);
  });
  it("covers every Watch kind", () => {
    expect(messages.map(({ type }) => type).sort()).toEqual(
      WatchMessageSchema.options.map((schema) => schema.shape.type.value).sort(),
    );
  });
  it.each(messages)("rejects envelope and payload extras in $type", (message) => {
    expect(parseMessage({ ...message, extra: true }).ok).toBe(false);
    expect(parseMessage({ ...message, payload: { ...message.payload, extra: true } }).ok).toBe(
      false,
    );
  });
  it("rejects version 1 with a structured error", () => {
    const result = parseMessage({ ...messages[0], version: 1 });
    expect(result).toMatchObject({
      ok: false,
      rejection: {
        reason: "invalid_message",
        issues: [{ path: ["version"], code: "invalid_value", message: expect.any(String) }],
      },
    });
  });
  it.each(ItemClassSchema.options)("accepts inspector class %s", (cls) => {
    expect(parseMessage({ ...messages[1], payload: { ...inspect, class: cls } }).ok).toBe(true);
  });
  it("rejects an inspector class outside core's ItemClass", () => {
    expect(parseMessage({ ...messages[1], payload: { ...inspect, class: "OTHER" } }).ok).toBe(
      false,
    );
  });
  it.each([
    { ...inspect, actions: [{ id: "rerun", label: "Re-run" }] },
    { ...inspect, actions: [{ ...inspect.actions[0], disabledReason: "" }] },
    { ...inspect, actions: [{ ...inspect.actions[0], confirm: true }] },
    { ...inspect, evidence: [{ ...record, observedAt: "yesterday" }] },
    { ...inspect, evidence: [{ ...record, retainedFrom: "yesterday" }] },
    {
      ...inspect,
      evidence: [{ ...record, completeness: { ...record.completeness, extra: true } }],
    },
    { ...inspect, related: [{ ...inspect.related[0], extra: true }] },
    { ...inspect, approval: { ...inspect.approval, extra: true } },
  ])("rejects planted nested-invalid inspector fields", (payload) => {
    expect(parseMessage({ ...messages[1], payload }).ok).toBe(false);
  });
  describe("inspector provenance", () => {
    const areas = AREAS.map((area) => ({
      area,
      envelope: { source: area, state: "unread" as const },
    }));
    const provenance = [
      { path: "/cause", areas: ["github"] },
      { path: "/actions/0/eligibilityReason", areas: ["lifecycle"] },
    ];
    const issues = (payload: unknown) =>
      InspectResultSchema.safeParse(payload).error?.issues.map((issue) => issue.message) ?? [];
    it("accepts a result that predates per-value provenance", () => {
      expect(parseMessage(messages[1]).ok).toBe(true);
      expect(issues(inspect)).toEqual([]);
    });
    it("accepts area envelopes with value bindings", () => {
      expect(parseMessage({ ...messages[1], payload: { ...inspect, areas, provenance } }).ok).toBe(
        true,
      );
    });
    it.each([
      [{ ...inspect, areas }, "Areas and provenance must be present together"],
      [{ ...inspect, provenance }, "Areas and provenance must be present together"],
      [{ ...inspect, areas: areas.slice(1), provenance }, "Area fleet has no envelope"],
      [{ ...inspect, areas: [...areas, areas[0]], provenance }, "Area fleet repeats"],
      [
        {
          ...inspect,
          areas: areas.map((a) =>
            a.area === "runs" ? { ...a, envelope: { ...a.envelope, source: "github" } } : a,
          ),
          provenance,
        },
        "Envelope source github is not area runs",
      ],
      [
        { ...inspect, areas, provenance: [...provenance, provenance[0]] },
        "Provenance repeats /cause",
      ],
      [
        { ...inspect, areas, provenance: [{ path: "/actions/1/label", areas: ["github"] }] },
        "Provenance path /actions/1/label does not resolve",
      ],
    ])("rejects inconsistent inspector provenance", (payload, message) => {
      expect(issues(payload)).toContain(message);
    });
  });
  it.each([
    { ...messages[2], payload: { ...messages[2].payload, remaining: -1 } },
    { ...messages[2], payload: { ...messages[2].payload, resetAt: "tomorrow" } },
    {
      ...messages[2],
      payload: { ...messages[2].payload, deferredAreas: [{ area: "security", reason: "" }] },
    },
    { ...messages[3], payload: { ...messages[3].payload, watchReady: true } },
    {
      ...messages[3],
      payload: { ...messages[3].payload, tools: [{ tool: "gh", state: "unknown", action: null }] },
    },
    {
      ...messages[3],
      payload: {
        ...messages[3].payload,
        tools: [{ tool: "gh", state: "ready", action: null, token: "secret" }],
      },
    },
    {
      ...messages[3],
      payload: {
        ...messages[3].payload,
        tools: [...messages[3].payload.tools, ...messages[3].payload.tools],
      },
    },
    {
      ...messages[6],
      payload: {
        requestId: "signin-1",
        tool: "gh",
        state: "device-code",
        url: "https://github.com",
      },
    },
    { ...messages[6], payload: { ...messages[6].payload, url: "javascript:alert(1)" } },
    { ...messages[7], payload: { fromCursor: -1 } },
    { ...messages[7], payload: { fromCursor: 1.5 } },
  ])("rejects invalid budget, setup and cursor fields", (message) => {
    expect(parseMessage(message).ok).toBe(false);
  });
  it.each(["starting", "waiting", "completed", "failed"] as const)(
    "round-trips sign-in progress %s",
    (state) => {
      const message = {
        ...messages[6],
        payload: {
          requestId: "signin-1",
          tool: "glab",
          state,
          ...(state === "failed" ? { reason: "Sign-in failed" } : {}),
        },
      };
      expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
    },
  );
  it.each(["starting", "waiting", "completed", "failed", "device-code"] as const)(
    "rejects sign-in progress %s without the id of the request that started it",
    (state) => {
      const { requestId, ...payload } = {
        ...messages[6].payload,
        state,
        ...(state === "failed" ? { reason: "Sign-in failed" } : {}),
      };
      const shaped =
        state === "device-code"
          ? payload
          : (({ deviceCode, url, ...rest }) => rest)(payload as (typeof messages)[6]["payload"]);
      expect(parseMessage({ ...messages[6], payload: { ...shaped, requestId } }).ok).toBe(true);
      expect(parseMessage({ ...messages[6], payload: shaped }).ok).toBe(false);
      expect(parseMessage({ ...messages[6], payload: { ...shaped, requestId: "" } }).ok).toBe(
        false,
      );
    },
  );
});

it("round-trips strict read records, area envelopes, tree status and six stations", () => {
  const schemasAndValues = [
    [ReadRecordSchema, record],
    [ReadRecordSchema, { ...record, completeness: { kind: "complete" } }],
    [EnvelopeSchema, { source: "github", state: "unread" }],
    [
      EnvelopeSchema,
      { source: "github", state: "unread", completeness: { kind: "complete" }, inferred: false },
    ],
    [
      EnvelopeSchema,
      { source: "github", state: "incomplete", observedAt: at, completeness: record.completeness },
    ],
    [
      TreeStatusSchema,
      [
        { id: "today", status: "failed" },
        { id: "service:storage", status: "fresh" },
      ],
    ],
    [
      ServiceStationsSchema,
      {
        service: "storage",
        stations: StationIdSchema.options.map((id) => ({
          id,
          state: "waiting",
          substate: "waiting-on-person",
          text: "Needs review",
        })),
      },
    ],
  ] as const;
  for (const [schema, value] of schemasAndValues) {
    expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  }
  const stations = StationIdSchema.options.map((id) => ({
    id,
    state: "waiting",
    substate: "waiting-on-person",
    text: "",
  }));
  expect(
    ServiceStationsSchema.safeParse({
      service: "storage",
      stations: [{ ...stations[0], state: "bad" }, ...stations.slice(1)],
    }).success,
  ).toBe(false);
  expect(
    ServiceStationsSchema.safeParse({ service: "storage", stations: stations.slice(1) }).success,
  ).toBe(false);
  expect(
    ServiceStationsSchema.safeParse({
      service: "storage",
      stations: [{ ...stations[0], extra: true }, ...stations.slice(1)],
    }).success,
  ).toBe(false);
  expect(TreeStatusSchema.safeParse([{ id: "today", status: "fresh", extra: true }]).success).toBe(
    false,
  );
  expect(
    ReadRecordSchema.safeParse({
      ...record,
      completeness: { kind: "cut", reason: "limit", read: 21, total: 20 },
    }).success,
  ).toBe(false);
  expect(
    EnvelopeSchema.safeParse({
      source: "github",
      state: "failed",
      completeness: { kind: "complete" },
      inferred: false,
    }).success,
  ).toBe(true);
  const timeless = EnvelopeSchema.safeParse({
    source: "github",
    state: "fresh",
    completeness: { kind: "complete" },
  });
  expect(timeless.error?.issues[0]?.path).toEqual(["observedAt"]);
  expect(
    EnvelopeSchema.safeParse({
      source: "github",
      state: "unread",
      completeness: record.completeness,
    }).success,
  ).toBe(false);
  for (const state of ["fresh", "stale"]) {
    const cut = EnvelopeSchema.safeParse({
      source: "github",
      state,
      observedAt: at,
      completeness: record.completeness,
    });
    expect(cut.success).toBe(false);
    expect(cut.error?.issues[0]?.path).toEqual(["state"]);
    expect(
      EnvelopeSchema.safeParse({
        source: "github",
        state,
        observedAt: at,
        completeness: { kind: "complete" },
      }).success,
    ).toBe(true);
  }
});
