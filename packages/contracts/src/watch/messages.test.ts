// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { parseMessage } from "../index.js";
import { EnvelopeSchema, type ReadRecord, ReadRecordSchema } from "./evidence.js";
import { ItemClassSchema } from "./inspect.js";
import { PROTOCOL_VERSION, type WatchMessage, WatchMessageSchema } from "./messages.js";
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
      tool: "gh",
      state: "device-code",
      deviceCode: "ABCD-1234",
      url: "https://github.com/login/device",
    },
  },
  { ...envelope, kind: "request", type: "view.subscribe", payload: { fromCursor: 0 } },
] satisfies [
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
  it.each(messages)("round-trips $type through the shared parser", (message) => {
    expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
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
    { ...messages[6], payload: { tool: "gh", state: "device-code", url: "https://github.com" } },
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
          tool: "glab",
          state,
          ...(state === "failed" ? { reason: "Sign-in failed" } : {}),
        },
      };
      expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
    },
  );
});

it("round-trips strict read records, area envelopes, tree status and six stations", () => {
  const schemasAndValues = [
    [ReadRecordSchema, record],
    [ReadRecordSchema, { ...record, completeness: "complete" }],
    [EnvelopeSchema, { source: "github", state: "unread" }],
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
          text: "Needs review",
        })),
      },
    ],
  ] as const;
  for (const [schema, value] of schemasAndValues) {
    expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  }
  const stations = StationIdSchema.options.map((id) => ({ id, state: "waiting", text: "" }));
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
        completeness: "complete",
      }).success,
    ).toBe(true);
  }
});
