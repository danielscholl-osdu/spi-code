// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-1106.json?raw";

const previousZone = process.env.TZ;
const at = "2026-11-07T00:00:00.000Z";
let unmount: (() => Promise<void>) | undefined;

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});

it.each([
  ["America/Chicago", "18:00"],
  ["UTC", "11-07 00:00"],
])("reads a Today item's and Line cell's instant under TZ=%s", async (zone, expected) => {
  process.env.TZ = zone;
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T14:02:00Z"));
  const [{ AttentionBand }, { default: Line }, { createSelectionStore }, { watchStore }] =
    await Promise.all([
      import("../views/today/Band.js"),
      import("../views/line/index.js"),
      import("../panels/selection.js"),
      import("../store/watch.js"),
    ]);
  const body: ViewSnapshot = ViewSnapshotSchema.parse(JSON.parse(recorded));
  const item = body.briefing.focus[0];
  const station = body.stations[0]?.stations.find(({ id }) => id === "main");
  if (!item || !station) throw new Error("Recorded Today item and Line cell required");
  item.title = `Maintenance held since ${at}`;
  station.text = `main run red at ${at}`;
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
    watchStore.setState({ snapshot: null });
  };
  await act(async () =>
    root.render(
      <>
        <AttentionBand
          snapshot={body}
          inspector={createSelectionStore({ postMessage: vi.fn() })}
          onNavigate={vi.fn()}
        />
        <Line presentation="pinned" />
      </>,
    ),
  );
  const today = container.querySelector(".today-need-title");
  const cell = container.querySelector('td[data-station="main"] button');
  expect(today?.textContent).toBe(`Maintenance held since ${expected}`);
  expect(cell?.textContent).toContain(`main run red at ${expected}`);
  expect(today?.querySelector("time")?.getAttribute("datetime")).toBe(at);
  expect(cell?.querySelector("time")?.getAttribute("datetime")).toBe(at);
  expect([today?.textContent, cell?.textContent].join(" ")).not.toContain("(in ");
});
