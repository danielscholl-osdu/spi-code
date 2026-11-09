// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  PROTOCOL_VERSION,
  type SweepProgress,
  SweepProgressSchema,
  type SweepReasonCode,
  SweepReasonCodeSchema,
  ViewSnapshotSchema,
  WatchMessageSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { after, midSweep, SWEEP_START } from "../../components/sweep/test-helper.js";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import Today from "./index.js";

const sweepSchedule = {
  sweepMs: 300_000,
  gitlabMs: 1_800_000,
  securityMs: 1_800_000,
  releasesMs: 3_600_000,
};

const fixture = ViewSnapshotSchema.parse(JSON.parse(recorded));
const NOW = SWEEP_START + 130_000;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.useFakeTimers({
    now: NOW,
    toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(send = vi.fn()) {
  const port = { postMessage: vi.fn() };
  const store = createWatchStore(send, createSelectionStore(port));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpenSettings = vi.fn();
  await act(async () =>
    root.render(<Today store={store} onNavigate={vi.fn()} onOpenSettings={onOpenSettings} />),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const receive = (type: string, payload: unknown) =>
    act(async () =>
      store
        .getState()
        .receive({ version: PROTOCOL_VERSION, id: "host", kind: "event", type, payload }),
    );
  return { container, store, port, send, onOpenSettings, receive };
}

const one = (container: Element, selector: string) =>
  container.querySelector(selector)?.textContent;
const status = (container: Element) => one(container, '.today > [role="status"]');
const clock = (at: string) => clockTime(at, { now: NOW, hint: false });
const button = (container: Element, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(".today-first button")].find(
    (item) => item.textContent === label,
  );

function finished(progress: SweepProgress): SweepProgress {
  return SweepProgressSchema.parse({
    ...progress,
    outcome: "committed",
    sources: progress.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? { source: source.source, state: "read", startedAt: after(120), endedAt: after(128) }
        : source,
    ),
  });
}

function stopped(overrides: Record<string, unknown> = {}): SweepProgress {
  const body: Record<string, unknown> = {
    ...midSweep(),
    outcome: "failed",
    code: "timeout",
    failure: "GitHub did not answer in time.",
    source: "runs",
    nextAttemptAt: "2026-11-09T08:07:00Z",
    sources: midSweep().sources.map((source, index) =>
      index < 3
        ? source
        : index === 3
          ? { source: source.source, state: "reading", startedAt: after(43) }
          : { source: source.source, state: "waiting" },
    ),
    ...overrides,
  };
  if (body.source === undefined) delete body.source;
  return SweepProgressSchema.parse(body);
}

it("reads the program before any progress, then lists the sweep live with no raw field names", async () => {
  const { container, receive } = await mount();
  expect(one(container, "h2")).toBe("First sweep is reading the program.");
  expect(one(container, ".today-first-sub")).toBe(
    "A first sweep takes a few minutes. Today opens here when it's done.",
  );
  expect(one(container, ".today-first-foot")).toBe(
    "You can close this window. SPI Code tells you when Today is ready.",
  );
  expect(container.querySelector(".sweep-row, .sweep-bar")).toBeNull();
  await receive("sweep.status", {
    remaining: 123,
    floor: 100,
    resetAt: "2026-11-09T09:00:00Z",
    deferredAreas: [{ area: "radar", reason: "budget" }],
    nextSweepAt: null,
    schedule: sweepSchedule,
    lastSweep: null,
  });
  await receive("sweep.progress", midSweep());
  expect(container.querySelectorAll(".sweep-row")).toHaveLength(12);
  expect(container.querySelectorAll(".sweep-segment")).toHaveLength(12);
  expect(one(container, ".sweep-meta")).toBe("2\u00a0min 10\u00a0s so far · 1 source failed");
  expect(container.querySelector("dl, dt")).toBeNull();
  expect(container.textContent).not.toMatch(
    /remaining|floor|resetAt|deferredAreas|nextAttemptAt|resumeAt|usualMs|startedAt|endedAt|outcome|incomplete:|signin|sweep-1|API calls/,
  );
  await receive("sweep.progress", midSweep({ usualMs: 125_000 }));
  expect(one(container, ".today-first-sub")).toBe("Usually about 2\u00a0min.");
});

it("announces each stage politely and never the ticking seconds", async () => {
  const { container, receive } = await mount();
  await receive("sweep.progress", midSweep());
  const region = container.querySelector('.today > [role="status"]');
  expect(region?.className).toBe("visually-hidden");
  expect(status(container)).toBe("9 of 12 sources done, 1 failed.");
  const radar = () => one(container, '.sweep-row[data-source="radar"] .sweep-outcome');
  expect(radar()).toBe("reading · 14\u00a0s");
  await act(async () => vi.advanceTimersByTime(5_000));
  expect(radar()).toBe("reading · 19\u00a0s");
  expect(one(container, ".sweep-meta")).toBe("2\u00a0min 15\u00a0s so far · 1 source failed");
  expect(status(container)).toBe("9 of 12 sources done, 1 failed.");
  const progress = midSweep();
  await receive(
    "sweep.progress",
    SweepProgressSchema.parse({
      ...progress,
      sources: progress.sources.map((source) =>
        source.source === "radar" ? { ...source, state: "read", endedAt: after(134) } : source,
      ),
    }),
  );
  expect(status(container)).toBe("10 of 12 sources done, 1 failed.");
});

it("hands over on view.snapshot only, crossfades in place and keeps the completed list", async () => {
  const { container, store, port, receive } = await mount();
  await receive("sweep.progress", midSweep());
  const committed = finished(midSweep());
  await receive("sweep.progress", committed);
  expect(one(container, "h2")).toBe("First sweep is reading the program.");
  expect(container.querySelector(".place-reading")).toBeNull();
  expect(status(container)).toBe("12 of 12 sources done, 1 failed.");
  await receive("view.snapshot", fixture);
  expect(container.querySelector(".today .place-reading")).not.toBeNull();
  expect(container.querySelector(".today")?.classList.contains("today-handover")).toBe(true);
  const leaving = container.querySelector(".today-leaving");
  expect(leaving?.getAttribute("aria-hidden")).toBe("true");
  expect(leaving?.hasAttribute("inert")).toBe(true);
  expect(leaving?.querySelector('[role="status"], [role="alert"]')).toBeNull();
  expect(leaving?.querySelectorAll(".sweep-row")).toHaveLength(12);
  expect(container.querySelectorAll(".place-header")).toHaveLength(1);
  await act(async () => vi.advanceTimersByTime(200));
  expect(container.querySelector(".today-leaving")).toBeNull();
  expect(container.querySelector(".today")?.className).toBe("today");
  expect(store.getState().completed).toEqual(committed);
  expect(store.getState().selection).toBeNull();
  expect(port.postMessage).not.toHaveBeenCalled();
});

it("never reflows the brief while a later sweep runs, fails or commits", async () => {
  const { container, receive } = await mount();
  await receive("sweep.progress", finished(midSweep()));
  await receive("view.snapshot", fixture);
  await act(async () => vi.advanceTimersByTime(200));
  const brief = container.querySelector(".today")?.outerHTML;
  const later = midSweep({ first: false, sweep: "sweep-2" });
  await receive("sweep.progress", later);
  expect(container.querySelector(".today")?.outerHTML).toBe(brief);
  await receive("sweep.progress", stopped({ first: false, sweep: "sweep-2" }));
  expect(container.querySelector(".today")?.outerHTML).toBe(brief);
  await receive("sweep.progress", finished(later));
  expect(container.querySelector(".today")?.outerHTML).toBe(brief);
  expect(container.querySelector(".sweep-row, .today-first, .today-leaving")).toBeNull();
});

it("swaps the brief in without a crossfade under reduced motion", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
    })),
  );
  const { container, receive } = await mount();
  await receive("sweep.progress", finished(midSweep()));
  await receive("view.snapshot", fixture);
  expect(container.querySelector(".today .place-reading")).not.toBeNull();
  expect(container.querySelector(".today-leaving")).toBeNull();
  expect(container.querySelector(".today")?.className).toBe("today");
});

it("says where a timeout stopped the first sweep, when it tries again, and offers only Try again", async () => {
  const { container, send, onOpenSettings, receive } = await mount();
  await receive("sweep.progress", stopped());
  expect(one(container, "h2")).toBe("The first sweep stopped.");
  expect(one(container, ".today-first-sub")).toBe(
    `It stopped while reading Workflow runs: GitHub did not answer in time. SPI Code tries again at ${clock("2026-11-09T08:07:00Z")}.`,
  );
  expect(container.querySelector(".today-first-sub time")?.getAttribute("datetime")).toBe(
    "2026-11-09T08:07:00Z",
  );
  expect(status(container)).toBe("The first sweep stopped.");
  expect(container.querySelector(".today-first-foot, .sweep-meta")).toBeNull();
  const outcomes = () =>
    [...container.querySelectorAll(".sweep-outcome")].map((element) => element.textContent);
  expect(outcomes()).toEqual([
    "read · 3\u00a0s",
    "read · 9\u00a0s",
    "read · 31\u00a0s",
    "failed · GitHub did not answer in time.",
    ...Array(8).fill("waiting"),
  ]);
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(outcomes()[3]).toBe("failed · GitHub did not answer in time.");
  await act(async () => button(container, "Try again")?.click());
  expect(send).toHaveBeenCalledOnce();
  const request = WatchMessageSchema.parse(send.mock.calls[0]?.[0]);
  expect(request).toMatchObject({ kind: "request", type: "sweep.request", payload: {} });
  expect(button(container, "Open Settings")).toBeUndefined();
  expect(onOpenSettings).not.toHaveBeenCalled();
});

const SETTINGS_FIXABLE_STOP_CODES: readonly SweepReasonCode[] = ["signin"];

it.each(SweepReasonCodeSchema.options)(
  "offers Settings only for Readiness-fixable stop codes (signin), not reason text: %s",
  async (code) => {
    const { container, onOpenSettings, receive } = await mount();
    const fixable = SETTINGS_FIXABLE_STOP_CODES.includes(code);
    for (const state of ["reading", "throttled", "failed"] as const) {
      await receive(
        "sweep.progress",
        stopped({
          code,
          failure: "A tool needs sign-in.",
          source: code === "save" ? undefined : "runs",
          sources: [
            {
              source: "runs",
              state,
              startedAt: after(43),
              ...(state === "reading" ? {} : { code, reason: "A tool needs sign-in." }),
              ...(state === "throttled" ? { resumeAt: after(180) } : {}),
            },
          ],
        }),
      );
      const actions = container.querySelectorAll<HTMLButtonElement>(".today-first-actions button");
      expect([...actions].map((action) => action.textContent)).toEqual(
        fixable ? ["Try again", "Open Settings"] : ["Try again"],
      );
      const row = container.querySelector('.sweep-row[data-source="runs"]');
      const settings = row?.querySelector<HTMLButtonElement>("button");
      expect(settings?.textContent).toBe(fixable && code !== "save" ? "Open Settings" : undefined);
      if (fixable) {
        await act(async () => actions[1]?.click());
        expect(onOpenSettings).toHaveBeenCalled();
        await act(async () => settings?.click());
      }
    }
    expect(onOpenSettings).toHaveBeenCalledTimes(fixable ? 6 : 0);
  },
);

it("names a stop while saving, leaves out an unscheduled retry and says when Try again is not sent", async () => {
  const send = vi.fn(() => Promise.reject(new Error("closed")));
  const { container, receive } = await mount(send);
  await receive(
    "sweep.progress",
    stopped({ code: "save", failure: "The disk is full", nextAttemptAt: null, source: undefined }),
  );
  expect(one(container, ".today-first-sub")).toBe("It stopped while saving: The disk is full.");
  await act(async () => button(container, "Try again")?.click());
  expect(send).toHaveBeenCalledOnce();
  expect(one(container, '.today-first [role="alert"]')).toBe(
    "Could not send the request to SPI Code.",
  );
});

it("treats a cancelled first sweep as stopped, using only the future scheduled retry", async () => {
  const { container, send, receive } = await mount();
  await receive("sweep.status", {
    remaining: null,
    resetAt: after(3600),
    deferredAreas: [],
    nextSweepAt: after(420),
    schedule: sweepSchedule,
    lastSweep: null,
  });
  await receive("sweep.progress", midSweep({ outcome: "cancelled", sources: [] }));
  expect(one(container, "h2")).toBe("The first sweep stopped.");
  expect(status(container)).toBe("The first sweep stopped.");
  expect(one(container, ".today-first-sub")).toBe(
    `The sweep was cancelled. SPI Code tries again at ${clock(after(420))}.`,
  );
  expect(button(container, "Open Settings")).toBeUndefined();
  await act(async () => button(container, "Try again")?.click());
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ type: "sweep.request", payload: {} }),
  );
  await act(async () => vi.advanceTimersByTime(300_000));
  expect(container.querySelector(".today-first-sub time")).toBeNull();
  await receive("sweep.progress", midSweep({ sweep: "sweep-2" }));
  expect(one(container, "h2")).toBe("First sweep is reading the program.");
  expect(container.querySelector(".today-first-actions")).toBeNull();
});

it("keeps Settings on an earlier sign-in failure, not on the panel for a save failure", async () => {
  const { container, onOpenSettings, receive } = await mount();
  await receive(
    "sweep.progress",
    stopped({
      code: "save",
      failure: "SPI Code could not save the sweep.",
      source: undefined,
      sources: midSweep().sources,
    }),
  );
  expect(one(container, ".today-first-actions")).toBe("Try again");
  const settings = container.querySelectorAll<HTMLButtonElement>(".today-first button");
  expect([...settings].map((action) => action.textContent)).toEqual(["Try again", "Open Settings"]);
  expect(container.querySelector('.sweep-row[data-source="upstream"] button')?.textContent).toBe(
    "Open Settings",
  );
  await act(async () => settings[1]?.click());
  expect(onOpenSettings).toHaveBeenCalledOnce();
});
