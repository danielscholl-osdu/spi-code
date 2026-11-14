// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ALWAYS_PINNED,
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

const ALWAYS = [LINE_PIN, "place:environment", "place:engineering-system"];
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
  vi.unstubAllGlobals();
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
  expect(readPins()).toEqual(SEED);
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

it("keeps Line, Environment and Engineering system in an emptied list across a restart", async () => {
  for (const id of SEED) unpin(id);
  expect(readPins()).toEqual(ALWAYS);
  expect(JSON.parse(localStorage.getItem(PINS_STORAGE_KEY) ?? "null")).toEqual(ALWAYS);
  localStorage.setItem(PINS_STORAGE_KEY, "[]");
  localStorage.setItem(LEGACY_PINS_STORAGE_KEY, JSON.stringify(["legal"]));
  expect(readPins()).toEqual(ALWAYS);
  expect(await restart()).toEqual(ALWAYS);
});

it("refuses to unpin Line, Environment and Engineering system, and writes nothing", async () => {
  expect(ALWAYS_PINNED).toEqual(ALWAYS);
  for (const id of ALWAYS) unpin(id);
  expect(readPins()).toEqual(SEED);
  expect(localStorage.getItem(PINS_STORAGE_KEY)).toBeNull();
  const stored = JSON.stringify(["place:upstream", ...ALWAYS, "legal"]);
  localStorage.setItem(PINS_STORAGE_KEY, stored);
  for (const id of ALWAYS) unpin(id);
  expect(localStorage.getItem(PINS_STORAGE_KEY)).toBe(stored);
  expect(await restart()).toEqual(JSON.parse(stored));
});

it.each([
  ["none of them", ["legal", "place:releases"], [...ALWAYS, "legal", "place:releases"]],
  [
    "one of them",
    ["legal", "place:environment", "place:upstream"],
    [LINE_PIN, "place:engineering-system", "legal", "place:environment", "place:upstream"],
  ],
])(
  "puts back the always-pinned ids a stored list lacks (%s), first and in seed order",
  async (_, stored, read) => {
    localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(stored));
    expect(readPins()).toEqual(read);
    expect(await restart()).toEqual(read);
  },
);

it("moves an always-pinned row and keeps it there across a restart", async () => {
  movePin("place:environment", "place:security");
  const moved = [
    LINE_PIN,
    "place:upstream",
    "place:engineering-system",
    "place:releases",
    "place:security",
    "place:environment",
  ];
  expect(readPins()).toEqual(moved);
  expect(await restart()).toEqual(moved);
});

it("adds a pin once when it is pinned again", () => {
  pin("legal");
  pin("legal");
  pin(LINE_PIN);
  expect(JSON.parse(localStorage.getItem(PINS_STORAGE_KEY) ?? "null")).toEqual([...SEED, "legal"]);
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
  const denied = () => {
    throw new Error("denied");
  };
  vi.stubGlobal("localStorage", { getItem: denied, setItem: denied });
  expect(readPins()).toEqual(SEED);
  unpin("place:security");
  expect(readPins()).toEqual(SEED.slice(0, 5));
});

it("persists an unpin, a pin again and a move across a restart", async () => {
  unpin("place:releases");
  pin("legal");
  movePin("legal", "place:upstream");
  movePin("place:security", "place:environment");
  pin("place:releases");
  expect(await restart()).toEqual([
    LINE_PIN,
    "legal",
    "place:upstream",
    "place:security",
    "place:environment",
    "place:engineering-system",
    "place:releases",
  ]);
  const pins = await import("./pins.js");
  pins.movePin(LINE_PIN, "legal");
  pins.movePin("place:releases", "place:upstream");
  expect(await restart()).toEqual([
    "legal",
    LINE_PIN,
    "place:releases",
    "place:upstream",
    "place:security",
    "place:environment",
    "place:engineering-system",
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
