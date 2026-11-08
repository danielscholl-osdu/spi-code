// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMessage } from "../index.js";
import { BriefingSchema } from "./briefing.js";
import { AREAS, EnvelopeSchema, type ReadRecord, ReadRecordSchema } from "./evidence.js";
import { InspectResultSchema, ItemClassSchema } from "./inspect.js";
import { PROTOCOL_VERSION, type WatchMessage, WatchMessageSchema } from "./messages.js";
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
];

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
    { ...messages[2], payload: { remaining: -1, resetAt: at, deferredAreas: [] } },
    { ...messages[2], payload: { remaining: 10, resetAt: "tomorrow", deferredAreas: [] } },
    {
      ...messages[2],
      payload: { remaining: 10, resetAt: at, deferredAreas: [{ area: "security", reason: "" }] },
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
