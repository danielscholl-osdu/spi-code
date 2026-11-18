// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FIXED_PINS,
  LEGACY_PINS_STORAGE_KEY,
  movePin,
  movePinBeside,
  PINS_STORAGE_KEY,
  pin,
  pinOf,
  readPins,
  SEED_PINS,
  unpin,
  V2_PINS_STORAGE_KEY,
} from "./pins.js";

const LINE_PIN = "sheet:line";
const FIXED = ["place:environment", "place:engineering-system"];
const SEED = ["place:upstream", "place:releases", "place:security"];

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function restart() {
  vi.resetModules();
  return (await import("./pins.js")).readPins();
}

/** Stands in for storage, recording each write; `refuse` makes writes throw, `refuseRead` reads of a key. */
function watchWrites() {
  const real = localStorage;
  const writes: [string, string][] = [];
  const control = { writes, refuse: false, refuseRead: undefined as string | undefined };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => {
      if (key === control.refuseRead) throw new Error("denied");
      return real.getItem(key);
    },
    setItem: (key: string, value: string) => {
      if (control.refuse) throw new Error("quota");
      writes.push([key, value]);
      real.setItem(key, value);
    },
  });
  return control;
}

const stored = (key = PINS_STORAGE_KEY) => JSON.parse(localStorage.getItem(key) ?? "null");

it("seeds Upstream, Releases and Security when nothing is stored, and writes nothing", async () => {
  expect(SEED_PINS).toEqual(SEED);
  expect(FIXED_PINS).toEqual(FIXED);
  expect(readPins()).toEqual(SEED);
  expect(await restart()).toEqual(SEED);
  expect(localStorage.length).toBe(0);
});

it("reads a readable v3 list over v2 and the legacy key, dropping the retired Line pin", async () => {
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(["legal", LINE_PIN, "place:releases"]));
  localStorage.setItem(V2_PINS_STORAGE_KEY, JSON.stringify(["schema"]));
  localStorage.setItem(LEGACY_PINS_STORAGE_KEY, JSON.stringify(["file"]));
  expect(readPins()).toEqual(["legal", "place:releases"]);
  expect(await restart()).toEqual(["legal", "place:releases"]);
});

it.each([
  ["not JSON", "[legal"],
  ["null", "null"],
  ["not a list", '"legal"'],
  ["a list with a non-name", '["legal", 3]'],
  ["a list with an empty name", '["legal", ""]'],
])("gives the seed, never v2, from a corrupt v3 entry: %s", async (_, raw) => {
  localStorage.setItem(PINS_STORAGE_KEY, raw);
  localStorage.setItem(V2_PINS_STORAGE_KEY, JSON.stringify(["schema"]));
  expect(readPins()).toEqual(SEED);
  expect(await restart()).toEqual(SEED);
});

it("migrates v2 without the fixed block, keeping the other pins in order and an unpinned place unpinned", async () => {
  const v2 = JSON.stringify([
    "place:security",
    LINE_PIN,
    "legal",
    "place:environment",
    "place:upstream",
    "place:engineering-system",
  ]);
  localStorage.setItem(V2_PINS_STORAGE_KEY, v2);
  localStorage.setItem(LEGACY_PINS_STORAGE_KEY, JSON.stringify(["file"]));
  const migrated = ["place:security", "legal", "place:upstream"];
  expect(readPins()).toEqual(migrated);
  expect(stored()).toEqual(migrated);
  expect(localStorage.getItem(V2_PINS_STORAGE_KEY)).toBe(v2);
  expect(await restart()).toEqual(migrated);
});

it("migrates the legacy services after the seed, once", async () => {
  localStorage.setItem(LEGACY_PINS_STORAGE_KEY, JSON.stringify(["legal", "schema", "legal"]));
  expect(readPins()).toEqual([...SEED, "legal", "schema"]);
  pin("file");
  localStorage.setItem(LEGACY_PINS_STORAGE_KEY, JSON.stringify(["storage"]));
  expect(await restart()).toEqual([...SEED, "legal", "schema", "file"]);
});

it.each([
  [V2_PINS_STORAGE_KEY, "not JSON", "{"],
  [V2_PINS_STORAGE_KEY, "not a list", '{"legal":true}'],
  [V2_PINS_STORAGE_KEY, "a list with an empty name", '["legal", ""]'],
  [LEGACY_PINS_STORAGE_KEY, "not JSON", "{"],
  [LEGACY_PINS_STORAGE_KEY, "a list with a non-name", '["legal", 3]'],
])("gives the seed from a corrupt %s entry: %s", (key, _, raw) => {
  localStorage.setItem(key, raw);
  expect(readPins()).toEqual(SEED);
});

it("writes v3 once on migration and leaves v2 and the legacy key as they were", async () => {
  const v2 = JSON.stringify(["legal", LINE_PIN]);
  const legacy = JSON.stringify(["schema"]);
  localStorage.setItem(V2_PINS_STORAGE_KEY, v2);
  localStorage.setItem(LEGACY_PINS_STORAGE_KEY, legacy);
  const storage = watchWrites();
  readPins();
  readPins();
  expect(await restart()).toEqual(["legal"]);
  expect(storage.writes).toEqual([[PINS_STORAGE_KEY, '["legal"]']]);
  expect(localStorage.getItem(V2_PINS_STORAGE_KEY)).toBe(v2);
  expect(localStorage.getItem(LEGACY_PINS_STORAGE_KEY)).toBe(legacy);
});

it.each([PINS_STORAGE_KEY, V2_PINS_STORAGE_KEY, LEGACY_PINS_STORAGE_KEY])(
  "gives the seed when storage refuses the read of %s, and holds writes in the window though it would take them",
  async (key) => {
    const storage = watchWrites();
    storage.refuseRead = key;
    vi.resetModules();
    const pins = await import("./pins.js");
    expect(pins.readPins()).toEqual(SEED);
    pins.unpin("place:security");
    pins.pin("legal");
    pins.movePin("legal", "place:upstream");
    expect(pins.readPins()).toEqual(["legal", "place:upstream", "place:releases"]);
    expect(storage.writes).toEqual([]);
    storage.refuseRead = undefined;
    expect(pins.readPins()).toEqual(["legal", "place:upstream", "place:releases"]);
    expect(await restart()).toEqual(SEED);
  },
);

it("holds a change in the window when storage refuses its write, and reads the stored list on the next launch", async () => {
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(["legal"]));
  const storage = watchWrites();
  storage.refuse = true;
  pin("schema");
  unpin("legal");
  expect(readPins()).toEqual(["schema"]);
  expect(stored()).toEqual(["legal"]);
  storage.refuse = false;
  expect(await restart()).toEqual(["legal"]);
});

it("holds the migrated list when storage refuses its write, and migrates again on the next launch", async () => {
  localStorage.setItem(V2_PINS_STORAGE_KEY, JSON.stringify([LINE_PIN, "legal"]));
  const storage = watchWrites();
  storage.refuse = true;
  expect(readPins()).toEqual(["legal"]);
  pin("schema");
  expect(readPins()).toEqual(["legal", "schema"]);
  expect(localStorage.getItem(PINS_STORAGE_KEY)).toBeNull();
  storage.refuse = false;
  expect(await restart()).toEqual(["legal"]);
  expect(stored()).toEqual(["legal"]);
});

it("refuses to pin or unpin Line, Environment and Template, and writes nothing", async () => {
  const storage = watchWrites();
  const tryFixed = () => {
    for (const id of [LINE_PIN, ...FIXED]) {
      pin(id);
      unpin(id);
    }
  };
  tryFixed();
  expect(readPins()).toEqual(SEED);
  expect(storage.writes).toEqual([]);
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(["legal"]));
  storage.writes.length = 0;
  tryFixed();
  expect(readPins()).toEqual(["legal"]);
  expect(storage.writes).toEqual([]);
  expect(await restart()).toEqual(["legal"]);
});

it("adds a pin once when it is pinned again", () => {
  pin("legal");
  pin("legal");
  expect(stored()).toEqual([...SEED, "legal"]);
});

it("persists an unpin, a pin again and moves across a restart", async () => {
  unpin("place:releases");
  pin("legal");
  movePin("legal", "place:upstream");
  pin("place:releases");
  movePinBeside("place:security", "place:releases", "after");
  expect(await restart()).toEqual(["legal", "place:upstream", "place:releases", "place:security"]);
  const pins = await import("./pins.js");
  pins.movePinBeside("place:security", "legal", "before");
  pins.movePin("place:releases", "place:upstream");
  expect(await restart()).toEqual(["place:security", "legal", "place:releases", "place:upstream"]);
});

it("names pins for the places and services, and none for Today tabs or a month", () => {
  expect(pinOf({ kind: "today", tab: "forks" })).toBeUndefined();
  expect(pinOf({ kind: "releases", section: "forming-releases" })).toBe("place:releases");
  expect(pinOf({ kind: "engineering-system" })).toBe("place:engineering-system");
  expect(pinOf({ kind: "service", id: "line" })).toBe("line");
  expect(pinOf({ kind: "today" })).toBeUndefined();
  expect(pinOf({ kind: "release", month: "2026-10" })).toBeUndefined();
});
