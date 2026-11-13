// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, installSpi, type SnapshotName } from "../test-utils/harness.js";
import { closeSheet } from "./navigation.js";
import { Shell } from "./Shell.js";

const loadFixture = fixtureLoader(readFixture);

const november6 = "snapshot-1106.json" as const;
const unread = "snapshot-1106-unread.json" as const;
const unverified = "snapshot-1106-unverified.json" as const;
const previousWatch = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
let unmount: (() => Promise<void>) | undefined;

async function mount(name: SnapshotName, hash: string) {
  const body = loadFixture(name);
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
  window.location.hash = hash;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const text = (selector: string) => container.querySelector(selector)?.textContent ?? null;
  return {
    strip: text('.window-strip [data-strip] [data-field="template"] b'),
    sidebar: text('[data-sidebar-row="engineering-system"] .sidebar-row-note'),
    tile: [
      text("section.place .place-tile:first-child .place-tile-value"),
      text("section.place .place-tile:first-child .place-tile-counts"),
    ],
  };
}

beforeEach(() => {
  closeSheet();
  harness = installSpi({
    openExternal: vi.fn(async () => true),
    setAppearance: vi.fn(async () => true),
  });
  selectionStore.getState().clear();
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  closeSheet();
  watchStore.setState(previousWatch, true);
  harness.restore();
  window.location.hash = "";
  vi.unstubAllGlobals();
});

it("counts all 13 forks on the strip and the sidebar when 5 forks were not read", async () => {
  const today = await mount(unread, "#today");
  expect(today.strip).toBe("0/13");
  expect(today.sidebar).toBe("0 of 13");
});

it("names the 5 forks not read in the Engineering system place", async () => {
  const place = await mount(unread, "#engineering-system");
  expect(place.strip).toBe("0/13");
  expect(place.sidebar).toBe("0 of 13");
  expect(place.tile).toEqual(["0 of 13", "forks on 7d269b5 · 5 not read yet"]);
});

it("reads as before when every fork is read", async () => {
  const today = await mount(november6, "#today");
  expect(today.strip).toBe("0/13");
  expect(today.sidebar).toBe("0 of 13");
  await unmount?.();
  const place = await mount(november6, "#engineering-system");
  expect(place.tile).toEqual(["0 of 13", "forks on 7d269b5"]);
});

it("counts only the verified fork on every surface when another is on 7d269b5 but red", async () => {
  const today = await mount(unverified, "#today");
  expect(today.strip).toBe("1/13");
  expect(today.sidebar).toBe("1 of 13");
  await unmount?.();
  const place = await mount(unverified, "#engineering-system");
  expect(place.strip).toBe("1/13");
  expect(place.sidebar).toBe("1 of 13");
  expect(place.tile).toEqual(["1 of 13", "forks on 7d269b5"]);
});
