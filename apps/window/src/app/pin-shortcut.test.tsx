// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { selectionStore } from "../panels/selection.js";
import { PINS_STORAGE_KEY, readPins } from "../store/pins.js";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, installSpi } from "../test-utils/harness.js";
import { closeSheet, navigate, type Route } from "./navigation.js";
import { Shell } from "./Shell.js";

const body = fixtureLoader(readFixture)("snapshot-59d6895.json");
const previous = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  window.location.hash = "";
  closeSheet();
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(["place:upstream"]));
  harness = installSpi();
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Shell />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  closeSheet();
  selectionStore.getState().clear();
  watchStore.setState(previous);
  harness.restore();
  window.location.hash = "";
  localStorage.removeItem(PINS_STORAGE_KEY);
  localStorage.removeItem("spi-code.line-sheet.pinned");
  vi.restoreAllMocks();
});

const press = (key: string, init: KeyboardEventInit = { ctrlKey: true, shiftKey: true }) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
const go = (route: Route) => act(async () => navigate(route));
const control = () => container.querySelector<HTMLButtonElement>(".centre-end > .pin-control");
const stored = () => localStorage.getItem(PINS_STORAGE_KEY);

it("pins and unpins the place or service open in the centre", async () => {
  await go({ kind: "upstream" });
  expect(control()?.getAttribute("aria-label")).toBe("Unpin Upstream from sidebar (Ctrl+Shift+P)");
  await press("P");
  expect(readPins()).toEqual([]);
  expect(control()?.getAttribute("aria-label")).toBe("Pin Upstream to sidebar (Ctrl+Shift+P)");
  await go({ kind: "service", id: "legal" });
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
  await press("P");
  expect(readPins()).toEqual([]);
  await press("p", { metaKey: true, shiftKey: true });
  expect(readPins()).toEqual(["legal"]);
  expect(control()?.getAttribute("aria-label")).toBe("Unpin legal from sidebar (⌘⇧P)");
});

it("draws no control and does nothing on Today, a release month or a fixed place", async () => {
  const before = stored();
  for (const route of [
    { kind: "today" },
    { kind: "release", month: "2026-11" },
    { kind: "environment" },
    { kind: "engineering-system" },
  ] as const) {
    await go(route);
    expect(control()).toBeNull();
    await press("P");
    expect(stored()).toBe(before);
  }
});

it("does nothing while Settings is open or the Line sheet overlays the centre, and acts beside a docked one", async () => {
  await go({ kind: "releases" });
  await press(",", { ctrlKey: true });
  expect(document.querySelector("[role=dialog]")).not.toBeNull();
  await press("P");
  expect(readPins()).toEqual(["place:upstream"]);
  await press("Escape", {});
  expect(document.querySelector("[role=dialog]")).toBeNull();

  await press("l", { ctrlKey: true });
  expect(container.querySelector(".line-sheet")?.getAttribute("data-presentation")).toBe("overlay");
  await press("P");
  expect(readPins()).toEqual(["place:upstream"]);
  const dock = [...container.querySelectorAll<HTMLButtonElement>(".line-toolbar button")].find(
    (button) => button.textContent === "Dock",
  );
  await act(async () => dock?.click());
  await press("P");
  expect(readPins()).toEqual(["place:upstream", "place:releases"]);
});

it("leaves the open place alone while Find takes the shortcut for its highlighted result", async () => {
  await go({ kind: "upstream" });
  await press("k", { ctrlKey: true });
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "Security");
    input?.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await press("P");
  expect(readPins()).toEqual(["place:upstream", "place:security"]);
});
