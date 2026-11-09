// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { ago } from "../src/brief/words.js";
import { usualText } from "../src/model/stack.js";
import { againstUsual, span } from "../src/util.js";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

it.each([
  ["minutes", span(34 * minute), "34\u00a0min"],
  ["hours and minutes", span(5 * hour + 12 * minute), "5\u00a0h 12\u00a0min"],
  ["days and hours", span(4 * day + 17 * hour), "4\u00a0d 17\u00a0h"],
  [
    "relative time",
    ago("2026-11-06T09:00:00Z", new Date("2026-11-06T14:20:00Z")),
    "5\u00a0h 20\u00a0min ago",
  ],
  [
    "usual minute range",
    usualText({ min: minute, max: 12 * minute, n: 2 }),
    "green runs 1–12\u00a0min",
  ],
  [
    "usual minutes",
    usualText({ min: 12 * minute, max: 12 * minute, n: 2 }),
    "green runs 12\u00a0min",
  ],
  [
    "usual hours and minutes",
    usualText({ min: 90 * minute, max: 90 * minute, n: 2 }),
    "green runs 1\u00a0h 30\u00a0min",
  ],
])("keeps numbers and units inseparable in core's %s", (_, text, expected) => {
  expect(text).toBe(expected);
  expect(text).not.toMatch(/\d[ \t]+(?:s|min|h|d)\b/);
});

it("keeps the usual unit elided only when both durations are minutes", () => {
  expect(againstUsual(7 * minute, 2 * minute)).toBe("7\u00a0min, usually 2");
  expect(againstUsual(7 * minute, 2 * minute, " after its release")).toBe(
    "7\u00a0min after its release, usually 2",
  );
  expect(againstUsual(2 * hour, 2 * minute)).toBe("2\u00a0h, usually 2\u00a0min");
  expect(againstUsual(7 * minute, 7 * minute)).toBe("7\u00a0min");
});
