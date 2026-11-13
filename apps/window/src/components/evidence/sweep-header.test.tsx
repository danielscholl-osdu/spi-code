// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress, SweepStatus } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { clockTime } from "../../time.js";
import { after, midSweep, SWEEP_START, sweepStatus } from "../sweep/test-helper.js";
import { SweepEvidence } from "./EvidenceTab.js";

const previousWatch = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
const cleanups: (() => Promise<void>)[] = [];
const body = { ...fixtureLoader(readFixture)("snapshot-1106.json"), sweptAt: after(120) };
const clock = (at: string) => clockTime(at, { now: Date.now(), hint: false });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(SWEEP_START + 130_000);
  harness = installSpi();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  watchStore.setState(previousWatch, true);
  harness.restore();
  vi.useRealTimers();
});

async function render(
  sweep: SweepStatus | null = sweepStatus(),
  progress: SweepProgress | null = null,
) {
  watchStore.setState({
    snapshot: { cursor: body.cursor, body },
    sweep,
    progress,
    sweepRequest: null,
    sweepRequestError: null,
    setup: { tools: [], watchReady: true, disabledReason: null },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpenSettings = vi.fn();
  await act(async () =>
    root.render(
      <SweepEvidence
        snapshot={body}
        sweep={sweep}
        progress={progress}
        onOpenSettings={onOpenSettings}
      />,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return {
    container,
    onOpenSettings,
    header: () => container.querySelector("[data-sweep-header]"),
    schedule: () => container.querySelector("[data-sweep-schedule]")?.textContent,
    button: () => container.querySelector<HTMLButtonElement>(".sweep-now > button"),
  };
}

it("shows the saved time and next sweep alongside the shared forced-sweep control", async () => {
  const h = await render();
  expect(h.schedule()).toBe(`Swept ${clock(after(120))} · next sweep ${clock(after(430))}`);
  expect(h.header()?.contains(h.button() ?? null)).toBe(true);
  expect(h.button()?.textContent).toBe("Sweep now");
  await act(async () => h.button()?.click());
  expect(window.spi.postMessage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ type: "sweep.request", payload: { now: true } }),
  );
  expect(h.button()?.disabled).toBe(true);
});

it.each([null, after(129), after(130)])(
  "omits a missing or expired next sweep: %s",
  async (nextSweepAt) => {
    const h = await render(sweepStatus({ nextSweepAt }));
    expect(h.schedule()).toBe(`Swept ${clock(after(120))}`);
    expect(h.header()?.textContent).not.toContain("next sweep");
  },
);

it("removes a next sweep promise at its deadline without another host event", async () => {
  const h = await render(sweepStatus({ nextSweepAt: after(135) }));
  expect(h.schedule()).toContain("next sweep");
  await act(async () => vi.advanceTimersByTimeAsync(4999));
  expect(h.schedule()).toContain("next sweep");
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(h.schedule()).toBe(`Swept ${clock(after(120))}`);
});

it("shows the live start and count, and View live sweep keeps Evidence open without a request", async () => {
  const progress = midSweep({
    first: false,
    startedAt: after(125),
    sources: midSweep().sources.map(({ source }, index) =>
      index < 4
        ? { source, state: "read", startedAt: after(125), endedAt: after(129) }
        : { source, state: "waiting" },
    ),
  });
  const h = await render(sweepStatus(), progress);
  expect(h.schedule()).toBe(`Sweeping since ${clock(after(125))} · 4 of 12`);
  expect(h.header()?.textContent).not.toContain("next sweep");
  expect(h.button()?.textContent).toBe("Sweeping · 4 of 12");
  expect(h.button()?.disabled).toBe(true);
  await act(async () => h.container.querySelector<HTMLButtonElement>(".sweep-now-view")?.click());
  expect(h.container.querySelector('[data-evidence="sweep"]')).not.toBeNull();
  expect(window.spi.postMessage).not.toHaveBeenCalled();
  expect(h.onOpenSettings).not.toHaveBeenCalled();
});

it("opens Readiness through the shared control when Watch is not ready", async () => {
  const h = await render();
  await act(async () =>
    watchStore.setState({ setup: { tools: [], watchReady: false, disabledReason: "Install git" } }),
  );
  expect(h.button()?.disabled).toBe(true);
  await act(async () =>
    h.container.querySelector<HTMLButtonElement>(".sweep-now-readiness")?.click(),
  );
  expect(h.onOpenSettings).toHaveBeenCalledTimes(1);
  expect(window.spi.postMessage).not.toHaveBeenCalled();
});
