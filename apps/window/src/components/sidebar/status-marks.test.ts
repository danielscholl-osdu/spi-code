// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type Station,
  type Tone,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { expect, it } from "vitest";
import current from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { selectStrip } from "../../store/strip.js";
import { type StatusMark, type StatusPin, statusDot, statusRows } from "./status-marks.js";

const NOW = Date.parse("2026-11-06T15:04:00.000Z");
const HOUR = 3_600_000;
type SlotState = "empty" | "occupied" | "done" | "waiting" | "broken" | "unknown";

function base(): ViewSnapshot {
  const body = ViewSnapshotSchema.parse(JSON.parse(current));
  delete body.briefing.nextSyncAt;
  return slots(
    stations(body, () => ({})),
    () => "done",
  );
}

function environment(body: ViewSnapshot, fact: { tone: Tone; sub: string; figure?: string }) {
  body.briefing.facts = body.briefing.facts.map((entry) =>
    entry.label === "Environment" ? { ...entry, ...fact } : entry,
  );
  return body;
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

function slots(body: ViewSnapshot, state: (index: number) => SlotState) {
  for (const place of body.briefing.places ?? [])
    if (place.visual?.kind === "rollout")
      place.visual.slots = place.visual.slots.map((slot, index) => ({
        ...slot,
        state: state(index),
      }));
  return body;
}

function stations(
  body: ViewSnapshot,
  change: (service: string, id: Station["id"]) => Partial<Station>,
) {
  for (const row of body.stations)
    row.stations = row.stations.map((entry) => ({
      ...entry,
      substate: "ready",
      state: "idle",
      ...change(row.service, entry.id),
    })) as typeof row.stations;
  return body;
}

const stopped = { substate: "stopped", state: "stopped" } as const;
const waiting = { substate: "waiting-on-person", state: "waiting" } as const;
const unknown = { state: "unknown" } as const;
const sync = (ms: number) => (body: ViewSnapshot) => {
  body.briefing.nextSyncAt = new Date(NOW + ms).toISOString();
  return body;
};

const cases: [string, (body: ViewSnapshot) => ViewSnapshot, StatusPin, StatusMark | undefined][] = [
  [
    "failed templates",
    (b) => slots(b, (i) => (i < 2 ? "broken" : i < 5 ? "waiting" : "done")),
    "place:engineering-system",
    { kind: "count", tone: "error", count: 2 },
  ],
  [
    "pending templates",
    (b) => slots(b, (i) => (i < 3 ? "occupied" : "done")),
    "place:engineering-system",
    { kind: "count", tone: "warning", count: 3 },
  ],
  ["current templates", (b) => b, "place:engineering-system", undefined],
  [
    "unknown template slots",
    (b) => slots(b, () => "unknown"),
    "place:engineering-system",
    undefined,
  ],
  [
    "missing rollout",
    (b) => {
      b.briefing.places = b.briefing.places?.filter((p) => p.place !== "engineering");
      return b;
    },
    "place:engineering-system",
    undefined,
  ],
  [
    "failed templates beside unknown slots",
    (b) => slots(b, (i) => (i === 0 ? "broken" : i < 3 ? "unknown" : "done")),
    "place:engineering-system",
    { kind: "count", tone: "error", count: 1 },
  ],
  [
    "pending templates beside unknown slots",
    (b) => slots(b, (i) => (i === 0 ? "empty" : i < 3 ? "unknown" : "done")),
    "place:engineering-system",
    { kind: "count", tone: "warning", count: 1 },
  ],
  [
    "stopped forks",
    (b) =>
      stations(b, (s, id) => (id === "main" && ["storage", "search"].includes(s) ? stopped : {})),
    "sheet:line",
    { kind: "count", tone: "error", count: 2 },
  ],
  [
    "waiting forks",
    (b) => stations(b, (s, id) => (id === "sync" && s === "legal" ? waiting : {})),
    "sheet:line",
    { kind: "count", tone: "warning", count: 1 },
  ],
  [
    "stopped forks win over waiting",
    (b) =>
      stations(b, (s, id) =>
        id === "main" && s === "storage"
          ? stopped
          : id === "sync" && ["legal", "schema"].includes(s)
            ? waiting
            : {},
      ),
    "sheet:line",
    { kind: "count", tone: "error", count: 1 },
  ],
  ["flowing forks", (b) => b, "sheet:line", undefined],
  [
    "unread forks",
    (b) => stations(b, (s, id) => (s === "file" && id === "sync" ? unknown : {})),
    "sheet:line",
    undefined,
  ],
  [
    "empty fleet",
    (b) => {
      b.stations = [];
      return b;
    },
    "sheet:line",
    undefined,
  ],
  [
    "stopped forks beside unread ones",
    (b) =>
      stations(b, (s, id) =>
        s === "storage" && id === "main" ? stopped : s === "file" && id === "sync" ? unknown : {},
      ),
    "sheet:line",
    { kind: "count", tone: "error", count: 1 },
  ],
  [
    "waiting forks beside unread ones",
    (b) =>
      stations(b, (s, id) =>
        s === "legal" && id === "sync" ? waiting : s === "file" && id === "sync" ? unknown : {},
      ),
    "sheet:line",
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
    "ok tone without deployable",
    (b) => environment(b, { tone: "ok", sub: "" }),
    "place:environment",
    undefined,
  ],
  [
    "missing environment",
    (b) => {
      b.briefing.facts = b.briefing.facts.filter((f) => f.label !== "Environment");
      return b;
    },
    "place:environment",
    undefined,
  ],
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
  expect(statusRows(selectStrip(change(base())), NOW)[pin].mark).toEqual(mark);
});

it("never checks an Environment it could not read, nor marks any field it could not read", () => {
  const unread = environment(
    slots(
      stations(base(), () => unknown),
      () => "unknown",
    ),
    {
      tone: "ok",
      sub: "deployable",
      figure: "?",
    },
  );
  const rows = statusRows(selectStrip(unread), NOW);
  for (const row of Object.values(rows)) {
    expect(row.mark).toBeUndefined();
    expect(row.classification).toBe("unread");
  }
  for (const row of Object.values(statusRows(undefined, NOW))) expect(row.mark).toBeUndefined();
});

it("names the unread members beside a proven count", () => {
  const forks = statusRows(
    selectStrip(
      cases.find(([name]) => name === "stopped forks beside unread ones")?.[1](base()) ?? base(),
    ),
    NOW,
  )["sheet:line"];
  expect(forks.sentence).toContain("Stopped: storage.");
  expect(forks.sentence).toContain("Not read yet: file.");
  const templates = statusRows(
    selectStrip(
      cases.find(([name]) => name === "failed templates beside unknown slots")?.[1](base()) ??
        base(),
    ),
    NOW,
  )["place:engineering-system"];
  const rollout = base().briefing.places?.find(({ place }) => place === "engineering")?.visual;
  if (rollout?.kind !== "rollout") throw new Error("Recorded rollout required");
  const [failed, ...unread] = rollout.slots.slice(0, 3).map(({ service }) => service);
  expect(templates.sentence).toContain(`failed on ${failed}`);
  expect(templates.sentence).toContain(`Not read yet on ${unread.join(", ")}.`);
});

it("gives a fine Environment its sentence, and an unmarked next sync none", () => {
  const rows = statusRows(selectStrip(base()), NOW);
  expect(rows["place:environment"].sentence).toBe("Environment: Ready. v0.35.3 is ready.");
  expect(rows["place:upstream"].sentence).toBeUndefined();
  expect(statusRows(selectStrip(sync(HOUR)(base())), NOW)["place:upstream"].sentence).toMatch(
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
  const unread = environment(
    slots(
      stations(base(), () => unknown),
      () => "unknown",
    ),
    {
      tone: "neutral",
      sub: "deployability unread",
    },
  );
  const rows = statusRows(selectStrip(unread), NOW);
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
