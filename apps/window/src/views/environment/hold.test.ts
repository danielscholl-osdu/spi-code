// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { expect, it } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { fixtureLoader } from "../../test-utils/harness.js";
import { openHold } from "./hold.js";

const loadFixture = fixtureLoader(readFixture);
type Event = ViewSnapshot["briefing"]["environment"]["lanes"][number]["events"][number];

function withHolds(...events: Event[]) {
  const body = loadFixture("snapshot-1106.json");
  const lane = body.briefing.environment.lanes.find(({ id }) => id === "holds");
  if (!lane) throw new Error("fixture has no Held lane");
  lane.events = events;
  return body;
}

const closed: Event = {
  id: "1",
  start: "2026-11-05T04:07:05.000Z",
  end: "2026-11-05T04:20:16.000Z",
  state: "held",
  label: "13 min",
  detail: "in maintenance for 13 min",
};
const open: Event = {
  id: "2",
  start: "2026-11-04T15:00:00.000Z",
  state: "held",
  label: "2 d 13 h",
  detail: "in maintenance for 2 d 13 h so far",
  inspect: "maintenance:stack",
};

it("finds nothing when every hold in the Held lane has ended", () => {
  expect(openHold(loadFixture("snapshot-1106.json"))).toBeUndefined();
  expect(openHold(withHolds(closed))).toBeUndefined();
  expect(openHold(withHolds())).toBeUndefined();
});

it("finds nothing when the snapshot has no Held lane", () => {
  const body = withHolds(open);
  body.briefing.environment.lanes = body.briefing.environment.lanes.filter(
    ({ id }) => id !== "holds",
  );
  expect(openHold(body)).toBeUndefined();
});

it("gives the open hold's label, start and inspect id", () => {
  expect(openHold(withHolds(closed, open))).toEqual({
    label: "2 d 13 h",
    start: "2026-11-04T15:00:00.000Z",
    inspect: "maintenance:stack",
  });
  const { inspect: _inspect, ...bare } = open;
  expect(openHold(withHolds(bare))).toEqual({
    label: "2 d 13 h",
    start: "2026-11-04T15:00:00.000Z",
  });
});

it("gives no length when core could not word one", () => {
  expect(openHold(withHolds({ ...open, label: "?" }))).toEqual({
    start: open.start,
    inspect: open.inspect,
  });
});

it("ignores an open event that is not a hold", () => {
  expect(openHold(withHolds({ ...open, state: "running" }))).toBeUndefined();
});
