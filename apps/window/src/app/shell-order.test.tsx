// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, installSpi } from "../test-utils/harness.js";
import { Shell } from "./Shell.js";

const loadFixture = fixtureLoader((path) => readFileSync(path, "utf8"));

it("opens a tray destination the preload held from before the renderer subscribed", async () => {
  const previousWatch = watchStore.getState();
  const previousSelection = selectionStore.getState();
  const body = loadFixture("snapshot-1106.json");
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
  selectionStore.setState({ selected: null, open: false, tab: "detail" });
  const harness = installSpi({
    onNavigate: (listener) => {
      listener({ to: "evidence" });
      return () => {};
    },
  });
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
    harness.restore();
  }
});
