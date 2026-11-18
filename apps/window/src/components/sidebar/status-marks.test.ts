// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Tone, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { expect, it } from "vitest";
import current from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { dropRunning, setRunning } from "../../test-utils/environment.test-helper.js";
import { type StatusMark, type StatusPin, statusDot, statusRows } from "./status-marks.js";

const NOW = Date.parse("2026-11-06T15:04:00.000Z");
const HOUR = 3_600_000;
function base(): ViewSnapshot {
  const body = ViewSnapshotSchema.parse(JSON.parse(current));
  delete body.briefing.nextSyncAt;
  body.briefing.lines = [];
  return template(body, 0, []);
}

function template(body: ViewSnapshot, count: number, forks: string[], notRead: string[] = []) {
  const door = body.briefing.today?.fleet?.doors.find(({ id }) => id === "template");
  if (!door) throw new Error("Fixture needs a Template door");
  Object.assign(door, { count, forks, notRead });
  return body;
}

function ports(body: ViewSnapshot) {
  const original = ViewSnapshotSchema.parse(JSON.parse(current));
  body.briefing.lines = original.briefing.lines?.filter(({ id }) => id.startsWith("waiting:port:"));
  return body;
}

function environment(body: ViewSnapshot, fact: { tone: Tone; sub: string; figure?: string }) {
  return setRunning(body, fact);
}

function held(body: ViewSnapshot) {
  body.briefing.environment.lanes
    .find(({ id }) => id === "holds")
    ?.events.push({
      id: "hold-open",
      start: "2026-11-04T15:00:00.000Z",
      state: "held",
      label: "2 d",
      detail: "in maintenance for 2 d so far",
    });
  return body;
}

const sync = (ms: number) => (body: ViewSnapshot) => {
  body.briefing.nextSyncAt = new Date(NOW + ms).toISOString();
  return body;
};

const cases: [string, (body: ViewSnapshot) => ViewSnapshot, StatusPin, StatusMark | undefined][] = [
  [
    "template PRs to review",
    (b) => template(b, 2, ["legal", "storage"]),
    "place:engineering-system",
    { kind: "count", tone: "warning", count: 2 },
  ],
  ["no template PRs to review", (b) => b, "place:engineering-system", undefined],
  [
    "unread template PRs",
    (b) => template(b, 0, [], ["file"]),
    "place:engineering-system",
    undefined,
  ],
  [
    "port row before the sync clock",
    (b) => ports(sync(HOUR)(b)),
    "place:upstream",
    { kind: "count", tone: "warning", count: 1 },
  ],
  ["ready environment", (b) => b, "place:environment", { kind: "check", tone: "success" }],
  [
    "environment in maintenance",
    (b) => held(environment(b, { tone: "bad", sub: "held" })),
    "place:environment",
    { kind: "wrench", tone: "warning" },
  ],
  [
    "environment refreshing",
    (b) => held(environment(b, { tone: "warn", sub: "refresh running · at deploy" })),
    "place:environment",
    { kind: "refresh", tone: "work" },
  ],
  [
    "unknown environment figure",
    (b) => environment(b, { tone: "ok", sub: "deployable", figure: "?" }),
    "place:environment",
    undefined,
  ],
  [
    "empty environment figure",
    (b) => environment(b, { tone: "ok", sub: "deployable", figure: "" }),
    "place:environment",
    undefined,
  ],
  [
    "unread deployability",
    (b) => environment(b, { tone: "neutral", sub: "deployability unread" }),
    "place:environment",
    undefined,
  ],
  [
    "ok tone while deployability is unknown",
    (b) => {
      environment(b, { tone: "ok", sub: "" });
      b.briefing.environment.deployable = "unknown";
      return b;
    },
    "place:environment",
    undefined,
  ],
  ["missing environment", (b) => dropRunning(b), "place:environment", undefined],
  ["sync exactly 2 h away", sync(2 * HOUR), "place:upstream", { kind: "clock", tone: "sync" }],
  ["sync inside 2 h", sync(HOUR), "place:upstream", { kind: "clock", tone: "sync" }],
  ["sync just past 2 h", sync(2 * HOUR + 1), "place:upstream", undefined],
  ["sync gone by", sync(-60_000), "place:upstream", undefined],
  ["sync at this instant", sync(0), "place:upstream", undefined],
  ["sync unknown", (b) => b, "place:upstream", undefined],
  [
    "sync unparseable",
    (b) => {
      b.briefing.nextSyncAt = "soon";
      return b;
    },
    "place:upstream",
    undefined,
  ],
];

it.each(cases)("marks %s", (_name, change, pin, mark) => {
  expect(statusRows(change(base()), NOW)[pin].mark).toEqual(mark);
});

it("never checks an Environment it could not read, nor marks any field it could not read", () => {
  const unread = environment(template(base(), 0, [], ["file"]), {
    tone: "ok",
    sub: "deployable",
    figure: "?",
  });
  const rows = statusRows(unread, NOW);
  for (const row of Object.values(rows)) {
    expect(row.mark).toBeUndefined();
    expect(row.classification).toBe("unread");
  }
  for (const row of Object.values(statusRows(undefined, NOW))) expect(row.mark).toBeUndefined();
});

it("names the unread members beside a proven count", () => {
  const row = statusRows(template(base(), 2, ["legal", "storage"], ["file"]), NOW)[
    "place:engineering-system"
  ];
  expect(row.mark).toEqual({ kind: "count", tone: "warning", count: 2 });
  expect(row.sentence).toContain("legal, storage");
  expect(row.sentence).toContain("Not read: file");
});

it("gives a fine Environment its sentence, and an unmarked next sync none", () => {
  const rows = statusRows(base(), NOW);
  expect(rows["place:environment"].sentence).toBe("Environment: Ready. v0.35.3 is ready.");
  expect(rows["place:upstream"].sentence).toBeUndefined();
  expect(statusRows(sync(HOUR)(base()), NOW)["place:upstream"].sentence).toMatch(
    /^Next upstream sync \d\d:\d\d \(in .+\)\.$/,
  );
});

const error: StatusMark = { kind: "count", tone: "error", count: 1 };
const warning: StatusMark = { kind: "wrench", tone: "warning" };
const quiet: StatusMark[] = [
  { kind: "check", tone: "success" },
  { kind: "refresh", tone: "work" },
  { kind: "clock", tone: "sync" },
];

it.each([
  ["an interrupt on Today", 1, quiet, "error"],
  ["an error mark", 0, [warning, error], "error"],
  ["an interrupt beside a warning mark", 2, [warning], "error"],
  ["a warning mark", 0, [...quiet, warning], "warning"],
  ["a warning count", 0, [{ kind: "count", tone: "warning", count: 3 } as StatusMark], "warning"],
  ["only quiet marks", 0, quiet, undefined],
  ["nothing marked", 0, [undefined, undefined], undefined],
] as const)("dots %s", (_name, interrupts, marks, dot) => {
  expect(statusDot(interrupts, marks)).toBe(dot);
});

it("draws no dot when every field is unread", () => {
  const unread = environment(template(base(), 0, [], ["file"]), {
    tone: "neutral",
    sub: "deployability unread",
  });
  const rows = statusRows(unread, NOW);
  expect(
    statusDot(
      0,
      Object.values(rows).map(({ mark }) => mark),
    ),
  ).toBeUndefined();
  expect(
    statusDot(
      0,
      Object.values(statusRows(undefined, NOW)).map(({ mark }) => mark),
    ),
  ).toBeUndefined();
});
