// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import november6 from "../../../../fixtures/watch/snapshot-1106.json?raw";
import unread from "../../../../fixtures/watch/snapshot-1106-unread.json?raw";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { closeSheet } from "./navigation.js";
import { Shell } from "./Shell.js";

const previousWatch = watchStore.getState();
const previousSpi = window.spi;
let unmount: (() => Promise<void>) | undefined;

async function mount(raw: string, hash: string) {
  const body = ViewSnapshotSchema.parse(JSON.parse(raw));
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
    engineeringTile: [
      text("section.place .place-tile:nth-child(3) .place-tile-value"),
      text("section.place .place-tile:nth-child(3) .place-tile-counts"),
    ],
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  closeSheet();
  window.spi = {
    proof: false,
    openExternal: vi.fn(async () => true),
    setAppearance: vi.fn(async () => true),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
  selectionStore.getState().clear();
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  closeSheet();
  watchStore.setState(previousWatch, true);
  window.spi = previousSpi;
  window.location.hash = "";
  vi.unstubAllGlobals();
});

it("counts all 13 forks on the strip, the sidebar and Today when 5 forks were not read", async () => {
  const today = await mount(unread, "#today");
  expect(today.strip).toBe("0/13");
  expect(today.sidebar).toBe("0 of 13");
  expect(today.engineeringTile).toEqual(["0 of 13", "forks on 7d269b5 · 5 not read yet"]);
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
  expect(today.engineeringTile).toEqual(["0 of 13", "forks on 7d269b5"]);
  await unmount?.();
  const place = await mount(november6, "#engineering-system");
  expect(place.tile).toEqual(["0 of 13", "forks on 7d269b5"]);
});
