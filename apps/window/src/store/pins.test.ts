// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  LEGACY_PINS_STORAGE_KEY,
  LINE_PIN,
  movePin,
  PINS_STORAGE_KEY,
  pin,
  pinOf,
  readPins,
  SEED_PINS,
  unpin,
} from "./pins.js";

const SEED = [
  LINE_PIN,
  "place:upstream",
  "place:environment",
  "place:engineering-system",
  "place:releases",
  "place:security",
];

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

async function restart() {
  vi.resetModules();
  return (await import("./pins.js")).readPins();
}

it("seeds Line and the five places in order when nothing is stored", async () => {
  expect(SEED_PINS).toEqual(SEED);
  expect(readPins()).toEqual(SEED);
  expect(await restart()).toEqual(SEED);
});

it("keeps the legacy service pins after the seed, once", async () => {
  localStorage.setItem(LEGACY_PINS_STORAGE_KEY, JSON.stringify(["legal", "schema", "legal"]));
  expect(readPins()).toEqual([...SEED, "legal", "schema"]);
  pin("file");
  expect(JSON.parse(localStorage.getItem(PINS_STORAGE_KEY) ?? "null")).toEqual([
    ...SEED,
    "legal",
    "schema",
    "file",
  ]);
  localStorage.setItem(LEGACY_PINS_STORAGE_KEY, JSON.stringify(["storage"]));
  expect(await restart()).toEqual([...SEED, "legal", "schema", "file"]);
});

it.each([
  ["not JSON", "{"],
  ["not a list", '{"legal":true}'],
  ["a list with a non-name", '["legal", 3]'],
])("drops a corrupt legacy entry (%s) and keeps the seed", (_, raw) => {
  localStorage.setItem(LEGACY_PINS_STORAGE_KEY, raw);
  expect(readPins()).toEqual(SEED);
});

it("keeps a valid empty list empty across a restart", async () => {
  for (const id of SEED) unpin(id);
  expect(readPins()).toEqual([]);
  expect(localStorage.getItem(PINS_STORAGE_KEY)).toBe("[]");
  localStorage.setItem(LEGACY_PINS_STORAGE_KEY, JSON.stringify(["legal"]));
  expect(await restart()).toEqual([]);
});

it.each([
  ["not JSON", "[line"],
  ["not a list", '"line"'],
  ["null", "null"],
  ["a list with an empty name", '["sheet:line", ""]'],
  ["a list with a non-name", '["sheet:line", null]'],
])("falls back to the seed from a corrupt entry: %s", (_, raw) => {
  localStorage.setItem(PINS_STORAGE_KEY, raw);
  localStorage.setItem(LEGACY_PINS_STORAGE_KEY, JSON.stringify(["legal"]));
  expect(readPins()).toEqual(SEED);
});

it("falls back to the seed when storage cannot be read, and holds writes for the window", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(readPins()).toEqual(SEED);
  unpin("place:security");
  expect(readPins()).toEqual(SEED.slice(0, 5));
});

it("persists an unpin, a pin again and a move across a restart", async () => {
  unpin(LINE_PIN);
  pin("legal");
  movePin("legal", "place:upstream");
  movePin("place:security", "place:environment");
  pin(LINE_PIN);
  expect(await restart()).toEqual([
    "legal",
    "place:upstream",
    "place:security",
    "place:environment",
    "place:engineering-system",
    "place:releases",
    LINE_PIN,
  ]);
  const pins = await import("./pins.js");
  pins.movePin(LINE_PIN, "legal");
  pins.movePin("legal", "place:upstream");
  expect(await restart()).toEqual([
    LINE_PIN,
    "place:upstream",
    "legal",
    "place:security",
    "place:environment",
    "place:engineering-system",
    "place:releases",
  ]);
});

it("names a pin for Line, the places and services, and none for Today or a month", () => {
  expect(pinOf({ kind: "line" })).toBe(LINE_PIN);
  expect(pinOf({ kind: "releases", section: "forming-releases" })).toBe("place:releases");
  expect(pinOf({ kind: "engineering-system" })).toBe("place:engineering-system");
  expect(pinOf({ kind: "service", id: "line" })).toBe("line");
  expect(pinOf({ kind: "today" })).toBeUndefined();
  expect(pinOf({ kind: "release", month: "2026-10" })).toBeUndefined();
});
