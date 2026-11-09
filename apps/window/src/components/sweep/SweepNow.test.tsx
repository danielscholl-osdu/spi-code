// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { LastSweep, SweepProgress } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import snapshot from "../../../../../fixtures/watch/snapshot-1106.json" with { type: "json" };
import { createWatchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import { SweepNow } from "./SweepNow.js";
import {
  after,
  midSweep,
  SWEEP_START,
  savedSweep,
  sweepEvent,
  sweepStatus,
} from "./test-helper.js";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(SWEEP_START + 130_000);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

async function harness({
  first = false,
  connected = true,
  ready = true,
  knownSetup = true,
  initialStatus = sweepStatus(),
} = {}) {
  const send = vi.fn();
  const store = createWatchStore(send);
  const receive = (type: string, payload: unknown) =>
    act(async () => store.getState().receive(sweepEvent(type, payload)));
  if (!first) await receive("view.snapshot", { ...snapshot, cursor: 1, sweptAt: after(-300) });
  if (connected) await receive("sweep.status", initialStatus);
  if (knownSetup)
    await receive("setup.state", {
      tools: [],
      watchReady: ready,
      disabledReason: ready ? null : "Install git",
    });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onViewSweep = vi.fn();
  const onOpenReadiness = vi.fn();
  await act(async () =>
    root.render(
      <SweepNow store={store} onViewSweep={onViewSweep} onOpenReadiness={onOpenReadiness} />,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const button = () => container.querySelector<HTMLButtonElement>(".sweep-now > button");
  async function finish(progress: SweepProgress, { commit = true, requested = true } = {}) {
    if (progress.outcome === "running") throw new Error("Expected a terminal sweep");
    await receive("sweep.progress", progress);
    const lastSweep: LastSweep =
      progress.outcome === "failed"
        ? {
            sweep: progress.sweep,
            startedAt: progress.startedAt,
            endedAt: after(130),
            outcome: "failed",
            code: progress.code,
            requested,
          }
        : {
            sweep: progress.sweep,
            startedAt: progress.startedAt,
            endedAt: after(130),
            outcome: progress.outcome,
            requested,
          };
    await receive("sweep.status", sweepStatus({ lastSweep }));
    if (commit && progress.outcome === "committed")
      await receive("view.snapshot", { ...snapshot, cursor: 2, sweptAt: after(0) });
  }
  return { store, send, receive, container, button, onViewSweep, onOpenReadiness, finish };
}
const clock = (at: string) => clockTime(at, { now: Date.now(), hint: false });

it("sends one forced request and disables duplicate clicks while awaiting host progress", async () => {
  const h = await harness();
  await act(async () => {
    h.button()?.click();
    h.button()?.click();
  });
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: "sweep.request", payload: { now: true } }),
  );
  expect(h.button()?.disabled).toBe(true);
  expect(h.container.textContent).toContain("Requesting sweep.");
});

it.each([false, true])(
  "shows the live list count and callback before first snapshot = %s",
  async (first) => {
    const h = await harness({ first });
    await h.receive("sweep.progress", midSweep({ first }));
    expect(h.button()?.textContent).toBe(`${first ? "First sweep running" : "Sweeping"} · 9 of 12`);
    expect(h.button()?.disabled).toBe(true);
    const link = h.container.querySelector<HTMLButtonElement>(".sweep-now-view");
    expect(link?.textContent).toBe("View live sweep →");
    await act(async () => link?.click());
    expect(h.onViewSweep).toHaveBeenCalledTimes(1);
    expect(h.container.textContent).not.toContain("Next");
  },
);

it("does not claim saved on terminal progress or an older snapshot, then uses the saved time", async () => {
  const h = await harness();
  await act(async () => h.button()?.click());
  await h.finish(savedSweep(), { commit: false });
  expect(h.container.textContent).not.toContain("Sweep saved");
  expect(h.container.textContent).toContain("Waiting for saved sweep.");
  expect(h.button()?.disabled).toBe(true);
  await h.receive("view.snapshot", { ...snapshot, cursor: 2, sweptAt: after(0) });
  expect(h.container.textContent).toContain(`Sweep saved at ${clock(after(130))}.`);
  expect(h.button()?.disabled).toBe(false);
  expect(h.container.querySelector(".sweep-now-view")).toBeNull();
  vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(h.container.textContent).toContain(`Sweep saved at ${clock(after(130))}.`);
});

it.each([false, true])(
  "keeps the requested saved line after a later snapshot, including reload = %s",
  async (reload) => {
    let h = await harness();
    await act(async () => h.button()?.click());
    await h.finish(savedSweep());
    const status = h.store.getState().sweep;
    const progress = h.store.getState().progress;
    expect(h.button()?.disabled).toBe(false);
    if (reload) {
      h = await harness();
      await h.receive("sweep.progress", progress);
      await h.receive("sweep.status", status);
    }
    vi.setSystemTime(SWEEP_START + 160_000);
    await h.receive("view.snapshot", { ...snapshot, cursor: 3, sweptAt: after(160) });
    expect(h.button()?.disabled).toBe(false);
    expect(h.container.textContent).toContain(`Sweep saved at ${clock(after(130))}.`);
    expect(h.container.textContent).not.toContain("Waiting for saved sweep.");
  },
);

it.each([false, true])(
  "releases the tracked sweep and gives completion feedback only when requested = %s",
  async (requested) => {
    const h = await harness();
    if (requested) await h.receive("sweep.progress", midSweep({ first: false }));
    await act(async () => h.store.getState().requestSweepNow());
    if (!requested) await h.receive("sweep.progress", midSweep({ first: false }));
    expect(h.button()?.disabled).toBe(true);
    await h.finish(savedSweep(), { requested, commit: requested });
    expect(h.store.getState().sweepRequest).toBeNull();
    expect(h.button()?.disabled).toBe(false);
    expect(h.send).toHaveBeenCalledTimes(1);
    if (requested) {
      expect(h.container.textContent).toContain(`Sweep saved at ${clock(after(130))}.`);
    } else {
      expect(h.container.querySelector('[role="status"]')?.textContent).toBe("");
      expect(h.container.textContent).not.toMatch(/Requesting sweep|saved|stopped/);
    }
  },
);

it.each([1, 2])(
  "counts %s failed sources, including partial reads, and offers View sweep",
  async (count) => {
    const h = await harness();
    const progress = savedSweep();
    progress.sources[0] = {
      source: "auth",
      state: "cut",
      incomplete: { count: 0, total: 3, failed: 2 },
      failure: "Two reads failed.",
    };
    if (count === 2)
      progress.sources[1] = {
        source: "fleet",
        state: "failed",
        code: "other",
        reason: "Fleet read failed.",
      };
    await h.finish(progress);
    expect(h.container.textContent).toContain(
      `Sweep saved at ${clock(after(130))} · ${count} ${count === 1 ? "source" : "sources"} failed.`,
    );
    await act(async () => h.container.querySelector<HTMLButtonElement>(".sweep-now-view")?.click());
    expect(h.onViewSweep).toHaveBeenCalledTimes(1);
  },
);

it.each(["failed", "cancelled"] as const)(
  "shows %s with only a future scheduled attempt",
  async (outcome) => {
    const h = await harness();
    await h.finish(
      outcome === "failed"
        ? midSweep({ outcome, code: "save", failure: "Could not save.", nextAttemptAt: after(430) })
        : midSweep({ outcome }),
    );
    expect(h.container.textContent).toContain(
      `Sweep stopped. Next attempt at ${clock(after(430))}.`,
    );
    expect(h.container.querySelector("time")?.getAttribute("datetime")).toBe(after(430));
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(h.container.textContent).toContain("Sweep stopped.");
    expect(h.container.textContent).not.toContain("Next attempt");
    expect(h.container.querySelector("time")).toBeNull();
  },
);

it("has no Next line before the first snapshot even when the host schedules a retry", async () => {
  const h = await harness({ first: true });
  await h.finish(
    midSweep({
      outcome: "failed",
      code: "save",
      failure: "Could not save.",
      nextAttemptAt: after(430),
    }),
  );
  expect(h.container.textContent).toContain("Sweep stopped.");
  expect(h.container.textContent).not.toContain("Next");
});

it("recovers cooldown from replayed status and expires it exactly without another status", async () => {
  const status = sweepStatus({ forceCooldownUntil: Date.now() + 45_123, nextSweepAt: null });
  const h = await harness({ initialStatus: status });
  expect(h.button()?.disabled).toBe(true);
  expect(h.button()?.title).toBe("A sweep just ran.");
  await act(async () => vi.advanceTimersByTimeAsync(45_122));
  expect(h.button()?.disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(h.store.getState().sweep).toEqual(status);
  expect(h.button()?.disabled).toBe(false);
  expect(h.button()?.title).not.toBe("A sweep just ran.");
  await act(async () => h.button()?.click());
  expect(h.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: "sweep.request", payload: { now: true } }),
  );
});

it.each([0, -1])(
  "ignores an already expired cooldown (%s ms) even on first render",
  async (delta) => {
    const h = await harness({
      initialStatus: sweepStatus({ forceCooldownUntil: Date.now() + delta }),
    });
    expect(h.button()?.disabled).toBe(false);
  },
);

it("drops a stopped sweep's already expired attempt and handles a clock jump past both deadlines", async () => {
  const h = await harness();
  await h.finish(
    midSweep({
      outcome: "failed",
      code: "save",
      failure: "Could not save.",
      nextAttemptAt: after(129),
    }),
  );
  const lastSweep = h.store.getState().sweep?.lastSweep ?? null;
  await h.receive("sweep.status", sweepStatus({ lastSweep, nextSweepAt: after(129) }));
  expect(h.container.textContent).not.toContain("Next attempt");
  await h.receive(
    "sweep.status",
    sweepStatus({
      lastSweep,
      forceCooldownUntil: Date.now() + 60_000,
      nextSweepAt: after(430),
    }),
  );
  expect(h.button()?.disabled).toBe(true);
  expect(h.container.textContent).toContain("Next attempt");
  vi.setSystemTime(SWEEP_START + 600_000);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(h.button()?.disabled).toBe(false);
  expect(h.container.textContent).not.toContain("Next attempt");
});

it("does not invent a cooldown or a forced follow-up for a joined routine sweep", async () => {
  const h = await harness();
  await h.receive("sweep.progress", midSweep({ first: false }));
  await act(async () => h.store.getState().requestSweepNow());
  expect(h.button()?.textContent).toBe("Sweeping · 9 of 12");
  await h.finish(savedSweep());
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.button()?.disabled).toBe(false);
});

it("disables for Watch readiness and opens Readiness without a request", async () => {
  const h = await harness({ ready: false });
  expect(h.button()?.disabled).toBe(true);
  expect(h.container.textContent).toContain("Watch is not ready. Open Readiness.");
  await act(async () =>
    h.container.querySelector<HTMLButtonElement>(".sweep-now-readiness")?.click(),
  );
  expect(h.onOpenReadiness).toHaveBeenCalledTimes(1);
  expect(h.send).not.toHaveBeenCalled();
});

it("keeps the button disabled with no feedback until the first readiness state arrives", async () => {
  const h = await harness({
    knownSetup: false,
    initialStatus: sweepStatus({ remaining: null }),
  });
  expect(h.button()?.disabled).toBe(true);
  expect(h.container.querySelector('[role="status"]')?.textContent).toBe("");
  expect(h.container.querySelector(".sweep-now-readiness")).toBeNull();
  expect(h.send).not.toHaveBeenCalled();
  await h.receive("setup.state", { tools: [], watchReady: true, disabledReason: null });
  expect(h.button()?.disabled).toBe(false);
  expect(h.container.textContent).toContain("GitHub budget not reported yet.");
});

it("reports an unknown budget without blocking reads or promising the expired reset", async () => {
  const h = await harness();
  await h.receive("sweep.status", sweepStatus({ remaining: null, resetAt: after(129) }));
  expect(h.container.textContent).toContain("GitHub budget not reported yet.");
  expect(h.container.textContent).not.toContain("reset");
  expect(h.button()?.disabled).toBe(false);
});

it("leaves routine completions quiet and a low budget to the host's floor", async () => {
  const h = await harness();
  await h.finish(savedSweep(), { requested: false });
  await h.receive("sweep.status", sweepStatus({ remaining: 50 }));
  expect(h.container.textContent).not.toContain("saved");
  expect(h.button()?.disabled).toBe(false);
  await act(async () => h.button()?.click());
  expect(h.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: "sweep.request", payload: { now: true } }),
  );
});

it("shows reconnecting until the new host status arrives, retaining the committed brief", async () => {
  const h = await harness({ connected: false });
  expect(h.container.textContent).toContain("Reconnecting to the host.");
  expect(h.button()?.disabled).toBe(true);
  await h.receive("sweep.status", sweepStatus());
  expect(h.button()?.disabled).toBe(false);
  await h.receive("sweep.progress", midSweep());
  await h.receive("host.hello", { pid: 456 });
  expect(h.button()?.disabled).toBe(true);
  expect(h.container.textContent).toContain("Reconnecting to the host.");
  expect(h.container.textContent).not.toContain("View live");
  expect(h.store.getState().snapshot?.cursor).toBe(1);
  await h.receive("sweep.status", sweepStatus());
  expect(h.button()?.disabled).toBe(false);
});

it("surfaces send errors and clears them for a retry", async () => {
  const h = await harness();
  h.send.mockImplementationOnce(() => {
    throw new Error("Cannot send");
  });
  await act(async () => h.button()?.click());
  expect(h.container.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not send the sweep request. Try again.",
  );
  expect(h.button()?.disabled).toBe(false);
  await act(async () => h.button()?.click());
  expect(h.container.querySelector('[role="alert"]')).toBeNull();
});
