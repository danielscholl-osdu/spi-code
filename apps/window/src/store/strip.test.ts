// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Station, Tone, ViewSnapshot } from "@spi-code/contracts";
import { expect, it } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { fixtureLoader } from "../test-utils/harness.js";
import { selectStrip } from "./strip.js";

const fixture = () => fixtureLoader(readFixture)("snapshot-1106.json");
type Body = ReturnType<typeof fixture>;
type SlotState = "empty" | "occupied" | "done" | "waiting" | "broken" | "unknown";

function environment(
  body: Body,
  fact: { tone: Tone; sub: string; figure?: string },
  hold?: string,
) {
  body.briefing.facts = body.briefing.facts.map((entry) =>
    entry.label === "Environment" ? { ...entry, ...fact } : entry,
  );
  const lane = body.briefing.environment.lanes.find(({ id }) => id === "holds");
  if (lane && hold !== undefined)
    lane.events.push({
      id: "hold-open",
      start: "2026-11-04T15:00:00.000Z",
      state: "held",
      label: hold,
      detail: `in maintenance for ${hold} so far`,
    });
  return body;
}

function rollout(body: Body, slots: (service: string, index: number) => SlotState) {
  for (const place of body.briefing.places ?? []) {
    if (place.visual?.kind !== "rollout") continue;
    place.visual.slots = place.visual.slots.map((slot, index) => ({
      ...slot,
      state: slots(slot.service, index),
    }));
  }
  return body;
}

function forks(body: Body, station: (service: string, id: Station["id"]) => Partial<Station>) {
  for (const row of body.stations) {
    row.stations = row.stations.map((entry) => ({
      ...entry,
      substate: "ready",
      state: "idle",
      ...station(row.service, entry.id),
    })) as typeof row.stations;
  }
  return body;
}

const flowing = (body: Body) => forks(body, () => ({}));
const current = (body: Body) => rollout(body, () => "done");
const STOPPED = new Set(["storage", "indexer", "search", "workflow"]);
const WAITING = new Set(["legal", "schema"]);

const cases: [
  string,
  (body: Body) => Body,
  "environment" | "template" | "forks",
  string,
  number?,
][] = [
  ["ready environment", (b) => b, "environment", "fine"],
  [
    "maintenance",
    (b) => environment(b, { tone: "bad", sub: "held" }, "2 d"),
    "environment",
    "maintenance",
  ],
  [
    "refreshing",
    (b) => environment(b, { tone: "warn", sub: "refresh running · at deploy" }, "2 d"),
    "environment",
    "refreshing",
  ],
  ["current templates", current, "template", "fine"],
  [
    "pending templates",
    (b) => rollout(b, (_s, i) => (i < 3 ? "occupied" : "done")),
    "template",
    "pending",
    3,
  ],
  [
    "failed templates win over pending",
    (b) => rollout(b, (_s, i) => (i === 0 ? "broken" : i < 3 ? "waiting" : "done")),
    "template",
    "failed",
    1,
  ],
  [
    "templates count a done slot outside the fleet",
    (b) => {
      for (const place of b.briefing.places ?? [])
        if (place.visual?.kind === "rollout")
          place.visual.slots.push({ service: "retired", state: "done", text: "retired done" });
      return b;
    },
    "template",
    "fine",
  ],
  [
    "templates count an empty slot outside the fleet",
    (b) => {
      for (const place of b.briefing.places ?? [])
        if (place.visual?.kind === "rollout")
          place.visual.slots.push({ service: "retired", state: "empty", text: "retired empty" });
      return b;
    },
    "template",
    "pending",
    1,
  ],
  ["flowing forks", flowing, "forks", "fine"],
  [
    "stopped forks win over a fork not read",
    (b) =>
      forks(b, (s, id) =>
        s === "storage" && id === "main"
          ? { substate: "stopped", state: "stopped" }
          : s === "file" && id === "sync"
            ? { state: "unknown" }
            : {},
      ),
    "forks",
    "stopped",
    1,
  ],
  [
    "waiting forks win over a fork not read",
    (b) =>
      forks(b, (s, id) =>
        id === "sync" && WAITING.has(s)
          ? { substate: "waiting-on-person", state: "waiting" }
          : s === "file" && id === "sync"
            ? { state: "unknown" }
            : {},
      ),
    "forks",
    "waiting",
    2,
  ],
  [
    "stopped forks win over waiting",
    (b) =>
      forks(b, (s, id) =>
        id !== "lane" && STOPPED.has(s)
          ? { substate: "stopped", state: "stopped" }
          : id === "sync" && WAITING.has(s)
            ? { substate: "waiting-on-person", state: "waiting" }
            : {},
      ),
    "forks",
    "stopped",
    4,
  ],
  [
    "waiting forks",
    (b) =>
      forks(b, (s, id) =>
        id === "sync" && WAITING.has(s) ? { substate: "waiting-on-person", state: "waiting" } : {},
      ),
    "forks",
    "waiting",
    2,
  ],
  [
    "unread environment figure",
    (b) => environment(b, { tone: "ok", sub: "deployable", figure: "?" }),
    "environment",
    "unread",
  ],
  [
    "empty environment figure",
    (b) => environment(b, { tone: "ok", sub: "deployable", figure: "" }),
    "environment",
    "unread",
  ],
  [
    "unknown environment",
    (b) => environment(b, { tone: "neutral", sub: "deployability unread" }),
    "environment",
    "unread",
  ],
  [
    "missing environment",
    (b) => {
      b.briefing.facts = b.briefing.facts.filter((f) => f.label !== "Environment");
      return b;
    },
    "environment",
    "unread",
  ],
  [
    "unknown rollout slot",
    (b) => rollout(b, (_s, i) => (i === 0 ? "unknown" : "done")),
    "template",
    "unread",
  ],
  [
    "missing rollout",
    (b) => {
      b.briefing.places = b.briefing.places?.filter((p) => p.place !== "engineering");
      return b;
    },
    "template",
    "unread",
  ],
  [
    "empty rollout",
    (b) => {
      for (const p of b.briefing.places ?? [])
        if (p.visual?.kind === "rollout") p.visual.slots = [];
      return b;
    },
    "template",
    "unread",
  ],
  [
    "missing rollout slot",
    (b) => {
      for (const p of b.briefing.places ?? [])
        if (p.visual?.kind === "rollout") p.visual.slots.pop();
      return b;
    },
    "template",
    "unread",
  ],
  [
    "unknown station",
    (b) => forks(b, (s, id) => (s === "file" && id === "sync" ? { state: "unknown" } : {})),
    "forks",
    "unread",
  ],
  [
    "empty fleet",
    (b) => {
      b.stations = [];
      return b;
    },
    "forks",
    "unread",
  ],
  [
    "templates without a fleet",
    (b) => {
      b.stations = [];
      return b;
    },
    "template",
    "unread",
  ],
  [
    "empty service stations",
    (b) => {
      const row = b.stations[0];
      if (!row) throw new Error("Missing fixture stations");
      row.stations = [] as unknown as ViewSnapshot["stations"][number]["stations"];
      return b;
    },
    "forks",
    "unread",
  ],
  [
    "missing non-lane stations",
    (b) => {
      const row = b.stations[0];
      if (!row) throw new Error("Missing fixture stations");
      row.stations = row.stations.filter(
        (s) => s.id === "lane",
      ) as ViewSnapshot["stations"][number]["stations"];
      return b;
    },
    "forks",
    "unread",
  ],
];

it.each(cases)("classifies %s from the snapshot", (_name, change, field, classification, count) => {
  const fields = selectStrip(change(current(flowing(fixture()))));
  expect(fields[field].classification).toBe(classification);
  expect(fields[field].count).toBe(count);
});

it("keeps unknown and empty service stations out of the fine pip class", () => {
  for (const change of cases.filter(([name]) =>
    ["unknown station", "empty service stations", "missing non-lane stations"].includes(name),
  )) {
    const fields = selectStrip(change[1](flowing(fixture())));
    expect(fields.pips.some((p) => p.state === "unread")).toBe(true);
  }
});

it.each([
  ["snapshot-1106.json", "pending", 13],
  ["snapshot-1106-unread.json", "pending", 8],
  ["snapshot-1106-unverified.json", "failed", 1],
] as const)(
  "classifies template counts and names every service not done on the recorded %s sweep",
  (name, classification, count) => {
    const snapshot = fixtureLoader(readFixture)(name);
    const field = selectStrip(snapshot).template;
    expect(field.classification).toBe(classification);
    expect(field.count).toBe(count);
    const visual = snapshot.briefing.places?.find(({ place }) => place === "engineering")?.visual;
    if (visual?.kind !== "rollout") throw new Error("Missing recorded rollout");
    const fleet = snapshot.stations.map(({ service }) => service);
    const slotted = new Set(visual.slots.map(({ service }) => service));
    const owed = [
      ...visual.slots.filter(({ state }) => state !== "done").map(({ service }) => service),
      ...fleet.filter((service) => !slotted.has(service)),
    ];
    const named = new Set(field.label.match(/[\w-]+/g)?.filter((word) => fleet.includes(word)));
    expect([...named].sort()).toEqual([...new Set(owed)].sort());
  },
);
