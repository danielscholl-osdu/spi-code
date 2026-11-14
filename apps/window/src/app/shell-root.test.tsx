// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, installSpi } from "../test-utils/harness.js";
import { PANES_STORAGE_KEY } from "./pane-layout.js";
import { closeSheet, pinSheet } from "./routes.js";
import { Shell } from "./Shell.js";

const loadFixture = fixtureLoader((path) => readFileSync(path, "utf8"));

type HappyWindow = { happyDOM: { setViewport(viewport: { width: number; height: number }): void } };

afterEach(() => {
  vi.restoreAllMocks();
});

function serialize(element: Element): string {
  const style = (element as HTMLElement).style;
  const data = Array.from(element.attributes)
    .filter((attribute) => attribute.name.startsWith("data-"))
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .sort();
  const properties = Array.from({ length: style.length }, (_, index) => style.item(index))
    .filter((name) => name.startsWith("--"))
    .sort()
    .map((name) => `${name}:${style.getPropertyValue(name)}`);
  return [`${element.tagName.toLowerCase()}.${element.className}`, ...data, ...properties].join(
    " ",
  );
}

/** Recorded from Shell on main at 45e318c2, less the top-row height it no longer measures. */
const RECORDED_ON_MAIN: Record<string, string> = {
  "1440 closed":
    "div.shell data-layout=wide data-line-presentation=closed data-line-sheet=closed data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:0px --sidebar-col:232px --sidebar-width:232px",
  "1440 right panel":
    "div.shell data-layout=wide data-line-presentation=closed data-line-sheet=closed data-right-panel=open data-right-presentation=inline data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:360px --right-panel-width:360px --sheet-col:0px --sidebar-col:232px --sidebar-width:232px",
  "1440 line sheet":
    "div.shell data-layout=wide data-line-presentation=inline data-line-sheet=pinned data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:360px --sidebar-col:232px --sidebar-width:232px",
  "900 closed":
    "div.shell data-layout=wide data-line-presentation=closed data-line-sheet=closed data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:0px --sidebar-col:232px --sidebar-width:232px",
  "900 right panel":
    "div.shell data-layout=wide data-line-presentation=closed data-line-sheet=closed data-right-panel=open data-right-presentation=sheet data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:360px --sheet-col:0px --sidebar-col:232px --sidebar-width:232px",
  "900 line sheet":
    "div.shell data-layout=wide data-line-presentation=stacked data-line-sheet=pinned data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:0px --sidebar-col:232px --sidebar-width:232px",
  "740 closed":
    "div.shell data-layout=narrow data-line-presentation=closed data-line-sheet=closed data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=off-canvas data-sidebar-state=collapsed data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:0px --sidebar-col:0px --sidebar-width:232px",
  "740 right panel":
    "div.shell data-layout=narrow data-line-presentation=closed data-line-sheet=closed data-right-panel=open data-right-presentation=sheet data-sidebar-presentation=off-canvas data-sidebar-state=collapsed data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:360px --sheet-col:0px --sidebar-col:0px --sidebar-width:232px",
  "740 line sheet":
    "div.shell data-layout=narrow data-line-presentation=stacked data-line-sheet=pinned data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=off-canvas data-sidebar-state=collapsed data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:0px --sidebar-col:0px --sidebar-width:232px",
};

type Panes = "closed" | "right panel" | "line sheet";

async function root(width: number, panes: Panes) {
  (window as unknown as HappyWindow).happyDOM.setViewport({ width, height: 900 });
  localStorage.removeItem(PANES_STORAGE_KEY);
  closeSheet();
  window.location.hash = "#today";
  const body = loadFixture("snapshot-1106.json");
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
  selectionStore.setState({ selected: null, open: panes === "right panel" });
  if (panes === "line sheet") pinSheet();
  const harness = installSpi();
  const container = document.createElement("div");
  document.body.append(container);
  const view = createRoot(container);
  await act(async () => view.render(<Shell />));
  try {
    const element = container.firstElementChild;
    if (!element) throw new Error("Shell rendered nothing");
    return serialize(element);
  } finally {
    await act(async () => view.unmount());
    container.remove();
    closeSheet();
    harness.restore();
  }
}

it("renders the same Shell root element on snapshot-1106 at 1440, 900 and 740", async () => {
  const roots: Record<string, string> = {};
  for (const width of [1440, 900, 740]) {
    for (const panes of ["closed", "right panel", "line sheet"] as const) {
      roots[`${width} ${panes}`] = await root(width, panes);
    }
  }
  expect(roots).toEqual(RECORDED_ON_MAIN);
});
