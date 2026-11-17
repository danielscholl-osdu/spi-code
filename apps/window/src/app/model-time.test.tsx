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
])("reads a Today deadline's and Line cell's instant under TZ=%s", async (zone, expected) => {
  process.env.TZ = zone;
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T14:02:00Z"));
  const [{ TodayTable }, { default: Line }, { watchStore }] = await Promise.all([
    import("../views/today/Table.js"),
    import("../views/line/index.js"),
    import("../store/watch.js"),
  ]);
  const body: ViewSnapshot = ViewSnapshotSchema.parse(JSON.parse(recorded));
  const line = body.briefing.lines?.[0];
  const station = body.stations[0]?.stations.find(({ id }) => id === "main");
  if (!line || !station) throw new Error("Recorded Today line and Line cell required");
  line.deadline = { at, reason: `Before the next upstream sync, ${at}` };
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
        <TodayTable snapshot={body} />
        <Line presentation="pinned" />
      </>,
    ),
  );
  const today = container.querySelector(".today-row-clock")?.getAttribute("aria-label");
  const cell = container.querySelector('td[data-station="main"] button');
  expect(today).toBe(`Before the next upstream sync, ${expected}`);
  expect(cell?.textContent).toContain(`main run red at ${expected}`);
  expect(cell?.querySelector("time")?.getAttribute("datetime")).toBe(at);
  expect([today, cell?.textContent].join(" ")).not.toContain("(in ");
});
