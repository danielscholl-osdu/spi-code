// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-1106.json?raw";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { Shell } from "./Shell.js";

it("opens a tray destination the preload held from before the renderer subscribed", async () => {
  const previous = window.spi;
  const previousWatch = watchStore.getState();
  const previousSelection = selectionStore.getState();
  const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
  selectionStore.setState({ selected: null, open: false, tab: "detail" });
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage: vi.fn(),
    onMessage: () => () => {},
    onNavigate: (listener) => {
      listener({ to: "evidence" });
      return () => {};
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Shell />));
    expect(selectionStore.getState()).toMatchObject({
      open: true,
      tab: "evidence",
      evidenceScope: "sweep",
    });
    expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    watchStore.setState(previousWatch, true);
    selectionStore.setState(previousSelection, true);
    window.spi = previous;
  }
});
