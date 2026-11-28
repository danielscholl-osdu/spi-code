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
])("reads a Today deadline's instant under TZ=%s", async (zone, expected) => {
  process.env.TZ = zone;
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-06T14:02:00Z"));
  const { TodayTable } = await import("../views/today/Table.js");
  const body: ViewSnapshot = ViewSnapshotSchema.parse(JSON.parse(recorded));
  const line = body.briefing.lines?.[0];
  if (!line) throw new Error("Recorded Today line required");
  line.deadline = { at, reason: `Before the next upstream sync, ${at}` };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () => root.render(<TodayTable snapshot={body} />));
  const today = container.querySelector(".today-row-due")?.getAttribute("aria-label");
  expect(today).toBe(`Before the next upstream sync, ${expected}`);
});
