// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, expect, it, vi } from "vitest";

let pins: typeof import("./pins.js");
let feedback: typeof import("./pin-feedback.js");
let stop: () => void;
let shown = false;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  pins = await import("./pins.js");
  feedback = await import("./pin-feedback.js");
  localStorage.setItem(pins.PINS_STORAGE_KEY, JSON.stringify(["legal", "schema", "file"]));
  shown = false;
  stop = feedback.observePinFeedback(() => shown);
});
afterEach(() => {
  stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("reports every actual pin change with its old index, restores there, and persists", async () => {
  const changes: import("./pins.js").PinChange[] = [];
  const unsubscribe = pins.subscribePinChanges((change) => changes.push(change));
  pins.unpin("schema");
  expect(changes).toEqual([{ kind: "unpinned", pin: "schema", index: 1 }]);
  expect(feedback.readPinNotice()).toMatchObject({ kind: "unpinned", pin: "schema", index: 1 });
  expect(feedback.undoPinChange()).toBe(true);
  expect(pins.readPins()).toEqual(["legal", "schema", "file"]);
  expect(JSON.parse(localStorage.getItem(pins.PINS_STORAGE_KEY) ?? "null")).toEqual(
    pins.readPins(),
  );
  expect(feedback.readPinNotice()).toBeNull();
  pins.pin("legal");
  pins.unpin("missing");
  pins.pin("sheet:line");
  expect(changes).toHaveLength(1);
  unsubscribe();
});

it("flashes an appended pin only with Pinned shown, and replaces the previous notice", () => {
  pins.unpin("schema");
  shown = true;
  pins.pin("partition");
  expect(pins.readPins()).toEqual(["legal", "file", "partition"]);
  expect(feedback.readPinNotice()).toBeNull();
  expect(feedback.readJustPinned()).toBe("partition");
  vi.advanceTimersByTime(1_000);
  expect(feedback.readJustPinned()).toBeNull();
  shown = false;
  pins.pin("schema");
  expect(feedback.readPinNotice()).toMatchObject({ kind: "pinned", pin: "schema" });
  feedback.undoPinChange();
  expect(pins.readPins()).toEqual(["legal", "file", "partition"]);
  expect(feedback.readPinNotice()).toBeNull();
});

it("gives an unpin eight unpaused seconds, with independent hover and focus pauses", () => {
  pins.unpin("schema");
  vi.advanceTimersByTime(3_000);
  feedback.pausePinNotice("hover", true);
  feedback.pausePinNotice("focus", true);
  vi.advanceTimersByTime(20_000);
  feedback.pausePinNotice("hover", false);
  vi.advanceTimersByTime(20_000);
  expect(feedback.readPinNotice()).not.toBeNull();
  feedback.pausePinNotice("focus", false);
  vi.advanceTimersByTime(4_999);
  expect(feedback.readPinNotice()).not.toBeNull();
  vi.advanceTimersByTime(1);
  expect(feedback.readPinNotice()).toBeNull();
  expect(feedback.pinUndoClaimsShortcut()).toBe(false);
  expect(feedback.undoPinChange()).toBe(false);
});

it("replaces a notice with a fresh eight seconds and the newest change's Undo", () => {
  pins.unpin("schema");
  vi.advanceTimersByTime(7_000);
  pins.unpin("file");
  vi.advanceTimersByTime(7_000);
  expect(feedback.readPinNotice()).toMatchObject({ pin: "file", index: 1 });
  feedback.undoPinChange();
  expect(pins.readPins()).toEqual(["legal", "file"]);
});

it("keeps refused writes in the window, with honest words and Undo, and reloads what storage held", async () => {
  const real = localStorage;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => real.getItem(key),
    setItem: () => {
      throw new Error("quota");
    },
  });
  expect(() => pins.unpin("schema")).not.toThrow();
  expect(pins.readPins()).toEqual(["legal", "file"]);
  expect(real.getItem(pins.PINS_STORAGE_KEY)).toBe(JSON.stringify(["legal", "schema", "file"]));
  expect(feedback.readPinNotice()).toMatchObject({
    kind: "unpinned",
    pin: "schema",
    label: "schema",
    index: 1,
  });
  expect(() => feedback.undoPinChange()).not.toThrow();
  expect(pins.readPins()).toEqual(["legal", "schema", "file"]);
  stop();
  vi.resetModules();
  expect((await import("./pins.js")).readPins()).toEqual(["legal", "schema", "file"]);
});

it.each([-4, 1, 99])(
  "bounds a restored pin's index %s and refuses duplicate and fixed restores",
  (index) => {
    pins.unpin("schema");
    pins.restorePin("schema", index);
    const expected =
      index < 0
        ? ["schema", "legal", "file"]
        : index > 2
          ? ["legal", "file", "schema"]
          : ["legal", "schema", "file"];
    expect(pins.readPins()).toEqual(expected);
    pins.restorePin("schema", 0);
    pins.restorePin("sheet:line", 0);
    expect(pins.readPins()).toEqual(expected);
  },
);
