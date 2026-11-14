// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { expect, it } from "vitest";
import current from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { pinWord } from "./pin-word.js";

const body = ViewSnapshotSchema.parse(JSON.parse(current));
const words = (snapshot: ViewSnapshot) =>
  Object.fromEntries(
    snapshot.stations.flatMap(({ service }) => {
      const word = pinWord(snapshot, service);
      return word ? [[service, `${word.text} ${word.tone}`]] : [];
    }),
  );

it("words the Nov 6 fleet's stopped and waiting services and leaves the rest bare", () => {
  expect(words(body)).toEqual({
    partition: "waiting warn",
    entitlements: "stopped bad",
    legal: "waiting warn",
    storage: "waiting warn",
    indexer: "waiting warn",
    "indexer-queue": "waiting warn",
  });
});

it("gives no word when a line station is unread, even beside a stopped one", () => {
  const unread = structuredClone(body);
  const entitlements = unread.stations.find(({ service }) => service === "entitlements");
  const first = entitlements?.stations[0];
  if (!first) throw new Error("Recorded stations required");
  first.state = "unknown";
  expect(pinWord(unread, "entitlements")).toBeUndefined();
  expect(pinWord(unread, "partition")).toEqual({ text: "waiting", tone: "warn" });
});

it("ignores the stack lane, which neither stops nor leaves a line unread", () => {
  const lane = structuredClone(body);
  const crs = lane.stations.find(({ service }) => service === "crs-catalog")?.stations[5];
  const entitlements = lane.stations.find(({ service }) => service === "entitlements")?.stations[5];
  if (!crs || !entitlements) throw new Error("Recorded stations required");
  crs.substate = "stopped";
  crs.state = "stopped";
  entitlements.state = "unknown";
  expect(pinWord(lane, "crs-catalog")).toBeUndefined();
  expect(pinWord(lane, "entitlements")).toEqual({ text: "stopped", tone: "bad" });
});

it("gives no word without a snapshot, without station data, or for a service it does not name", () => {
  expect(pinWord(undefined, "entitlements")).toBeUndefined();
  expect(pinWord({ ...body, stations: [] }, "entitlements")).toBeUndefined();
  expect(pinWord(body, "gone")).toBeUndefined();
  const empty = structuredClone(body) as unknown as {
    stations: { service: string; stations: unknown[] }[];
  };
  for (const row of empty.stations) row.stations = [];
  expect(pinWord(empty as unknown as ViewSnapshot, "entitlements")).toBeUndefined();
});
