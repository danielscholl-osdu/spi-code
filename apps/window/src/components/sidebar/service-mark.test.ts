// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { expect, it } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readGenerated } from "../../../../../scripts/watch-generated.mjs";
import nov16 from "../../views/today/snapshot-1116.json?raw";
import { serviceMark } from "./service-mark.js";

const sixth = ViewSnapshotSchema.parse(JSON.parse(recorded));
const sixteenth = ViewSnapshotSchema.parse(JSON.parse(nov16));

const none = { ...sixth, services: [] };

it.each([
  ["Blocked", sixteenth, "indexer", { kind: "count", tone: "error", count: 2 }],
  ["Waiting only", sixteenth, "partition", { kind: "count", tone: "warning", count: 2 }],
  ["none and read", sixteenth, "file", { kind: "check", tone: "success" }],
  [
    "none and not read",
    ViewSnapshotSchema.parse(JSON.parse(readGenerated("snapshot-1106-unread.json"))),
    "crs-catalog",
    { kind: "unread" },
  ],
  ["a count with an unread area", sixth, "unit", { kind: "count", tone: "warning", count: 2 }],
  ["no home", none, "unit", undefined],
] as const)("marks a service with %s", (_, body, service, expected) => {
  const mark = serviceMark(body, service);
  if (expected === undefined) expect(mark).toBeUndefined();
  else expect(mark).toMatchObject(expected);
});

it("keeps unit's count although its read failed on 6 Nov", () => {
  expect(sixth.tree.find(({ id }) => id === "service:unit")?.status).toBe("failed");
});
