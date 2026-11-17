// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-1106.json?raw";
import type { Route } from "./routes.js";
import { useRouteScroll } from "./useRouteScroll.js";

function Probe({ route, snapshot }: { route: Route; snapshot: ViewSnapshot | undefined }) {
  const { middle, onScrollCapture } = useRouteScroll(route, snapshot);
  return (
    <div ref={middle} onScrollCapture={onScrollCapture}>
      <article />
    </div>
  );
}

it("neither resets nor saves route scroll before the first snapshot", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async (kind: "today" | "security", snapshot?: ViewSnapshot) =>
    act(async () => root.render(<Probe route={{ kind }} snapshot={snapshot} />));
  try {
    await render("today");
    const frame = container.querySelector("article");
    if (!frame) throw new Error("Missing scrolling frame");
    frame.scrollTop = 120;
    await render("security");
    expect(frame.scrollTop).toBe(120);
    const snapshot = ViewSnapshotSchema.parse(JSON.parse(recorded));
    await render("security", snapshot);
    await render("today", snapshot);
    expect(frame.scrollTop).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});
