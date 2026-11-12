// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-1106.json?raw";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { PANES_STORAGE_KEY } from "./pane-layout.js";
import { closeSheet, pinSheet } from "./routes.js";
import { Shell } from "./Shell.js";

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

/** Recorded from Shell on main at 45e318c2. */
const RECORDED_ON_MAIN: Record<string, string> = {
  "1440 closed":
    "div.shell data-layout=wide data-line-presentation=closed data-line-sheet=closed data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:0px --sidebar-col:232px --sidebar-width:232px --topbar-height:0px",
  "1440 right panel":
    "div.shell data-layout=wide data-line-presentation=closed data-line-sheet=closed data-right-panel=open data-right-presentation=inline data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:360px --right-panel-width:360px --sheet-col:0px --sidebar-col:232px --sidebar-width:232px --topbar-height:0px",
  "1440 line sheet":
    "div.shell data-layout=wide data-line-presentation=inline data-line-sheet=pinned data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:360px --sidebar-col:232px --sidebar-width:232px --topbar-height:0px",
  "900 closed":
    "div.shell data-layout=wide data-line-presentation=closed data-line-sheet=closed data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:0px --sidebar-col:232px --sidebar-width:232px --topbar-height:0px",
  "900 right panel":
    "div.shell data-layout=wide data-line-presentation=closed data-line-sheet=closed data-right-panel=open data-right-presentation=sheet data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:360px --sheet-col:0px --sidebar-col:232px --sidebar-width:232px --topbar-height:0px",
  "900 line sheet":
    "div.shell data-layout=wide data-line-presentation=stacked data-line-sheet=pinned data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=inline data-sidebar-state=expanded data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:0px --sidebar-col:232px --sidebar-width:232px --topbar-height:0px",
  "740 closed":
    "div.shell data-layout=narrow data-line-presentation=closed data-line-sheet=closed data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=off-canvas data-sidebar-state=collapsed data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:0px --sidebar-col:0px --sidebar-width:232px --topbar-height:0px",
  "740 right panel":
    "div.shell data-layout=narrow data-line-presentation=closed data-line-sheet=closed data-right-panel=open data-right-presentation=sheet data-sidebar-presentation=off-canvas data-sidebar-state=collapsed data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:360px --sheet-col:0px --sidebar-col:0px --sidebar-width:232px --topbar-height:0px",
  "740 line sheet":
    "div.shell data-layout=narrow data-line-presentation=stacked data-line-sheet=pinned data-right-panel=closed data-right-presentation=closed data-sidebar-presentation=off-canvas data-sidebar-state=collapsed data-slot=sidebar-wrapper data-window-controls=none --panel-col:0px --right-panel-width:0px --sheet-col:0px --sidebar-col:0px --sidebar-width:232px --topbar-height:0px",
};

type Panes = "closed" | "right panel" | "line sheet";

async function root(width: number, panes: Panes) {
  (window as unknown as HappyWindow).happyDOM.setViewport({ width, height: 900 });
  localStorage.removeItem(PANES_STORAGE_KEY);
  closeSheet();
  window.location.hash = "#today";
  const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
  selectionStore.setState({ selected: null, open: panes === "right panel" });
  if (panes === "line sheet") pinSheet();
  const previous = window.spi;
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
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
    window.spi = previous;
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
