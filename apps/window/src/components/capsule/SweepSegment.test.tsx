// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { closeSheet } from "../../app/navigation.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { PINS_STORAGE_KEY } from "../../store/pins.js";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { clockTime } from "../../time.js";
import { after, midSweep, SWEEP_START, sweepStatus } from "../sweep/test-helper.js";

const loadFixture = fixtureLoader(readFixture);
const fixture = () => loadFixture("snapshot-1106.json");
const previousWatch = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let unmount: (() => Promise<void>) | undefined;

function show(body: ViewSnapshot) {
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
}

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

const strip = () => container.querySelector<HTMLElement>(".window-strip [data-strip]");
const field = (name: string) => strip()?.querySelector<HTMLElement>(`[data-field="${name}"]`);
const sheet = () => container.querySelector(".line-sheet");

beforeEach(() => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Mac OS X) Electron/44.10.0",
  );
  closeSheet();
  window.location.hash = "#today";
  harness = installSpi();
  selectionStore.getState().clear();
  selectionStore.getState().setOpen(false);
  show(fixture());
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  closeSheet();
  watchStore.setState(previousWatch, true);
  harness.restore();
  localStorage.removeItem(PINS_STORAGE_KEY);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const glyph = () => container.querySelector<HTMLButtonElement>("header [data-sweep-line]");
const display = () => glyph()?.querySelector("[data-sweep-display]")?.textContent;
const glyphName = () =>
  document.getElementById(glyph()?.getAttribute("aria-labelledby") ?? "")?.textContent;
const line = () => container.querySelector<HTMLElement>("[data-sweep-progress]");
const popover = () => document.querySelector<HTMLElement>("[data-sweep-popover]");
const popoverButton = (name: string) =>
  [...(popover()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (button) => button.textContent === name,
  );
const receive = (type: string, payload: unknown) =>
  act(async () =>
    watchStore
      .getState()
      .receive({ version: PROTOCOL_VERSION, id: "host", kind: "event", type, payload }),
  );
const openPopover = async () => {
  await act(async () => glyph()?.click());
  expect(popover()).not.toBeNull();
};
const openEvidence = async () => {
  if (!popover()) await openPopover();
  await act(async () => popoverButton("Evidence")?.click());
  await act(() => new Promise((done) => setTimeout(done, 20)));
  expect(popover()).toBeNull();
};

it("adds only a future next sweep to the sweep's hover and accessible name, expiring on time", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(SWEEP_START + 130_000);
  const body = { ...fixture(), sweptAt: after(120) };
  show(body);
  watchStore.setState({ sweep: sweepStatus({ nextSweepAt: after(135) }) });
  await mount();
  const freshness = field("freshness");
  const label = () => document.getElementById(freshness?.getAttribute("aria-labelledby") ?? "");
  const next = `next sweep ${clockTime(after(135), { hint: false })}`;
  expect(freshness?.title).toContain(next);
  expect(label()?.textContent).toBe(freshness?.title);
  expect(display()).not.toContain("next sweep");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(freshness?.title).not.toContain("next sweep");
  expect(label()?.textContent).toBe(freshness?.title);
  await act(async () => watchStore.setState({ sweep: sweepStatus({ nextSweepAt: after(140) }) }));
  expect(freshness?.title).toContain("next sweep");
  await act(async () => watchStore.setState({ sweep: sweepStatus({ nextSweepAt: null }) }));
  expect(freshness?.title).not.toContain("next sweep");
});

it("shows the sweep time with no count, lists its sources, and opens the sweep Evidence", async () => {
  const body = fixture();
  delete body.briefing.nextSyncAt;
  show(body);
  await mount();
  expect(display()).toBe(clockTime(body.sweptAt));
  expect(glyphName()).toBe(`Swept ${clockTime(body.sweptAt)} · 1 failed, 3 not read yet`);
  expect(glyph()?.dataset.tone).toBe("bad");
  expect(line()).toBeNull();
  await openPopover();
  expect(popover()?.querySelectorAll("[data-source]")).toHaveLength(12);
  expect(popover()?.querySelector("[data-next=sync]")?.textContent).toBe("not read yet");
  expect(popover()?.querySelector("[data-next=sweep]")?.textContent).toBe("not read yet");
  expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).toBeNull();
  await openEvidence();
  expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).not.toBeNull();
});

it.each([
  ["a failed send", "Could not send the sweep request. Try again."],
  ["a host refusal", "Could not request a sweep. Try again."],
] as const)(
  "sends Settings' Sweep now request from the popover, alerts safely on %s, and reads Sweeping while one runs",
  async (failure, alert) => {
    await mount();
    await receive("setup.state", { tools: [], watchReady: true, disabledReason: null });
    await receive("sweep.status", sweepStatus());
    await openPopover();
    const now = () => popover()?.querySelector<HTMLButtonElement>(".capsule-sweep-now");
    const shown = () => popover()?.querySelector('[role="alert"]')?.textContent ?? null;
    const sent = expect.objectContaining({ type: "sweep.request", payload: { now: true } });
    if (failure === "a failed send")
      harness.spi.postMessage.mockImplementationOnce(() => {
        throw new Error("ipc channel closed");
      });
    expect(now()?.disabled).toBe(false);
    await act(async () => now()?.click());
    expect(harness.spi.postMessage).toHaveBeenCalledWith(sent);
    if (failure === "a host refusal")
      await act(async () =>
        watchStore.getState().receive({
          version: PROTOCOL_VERSION,
          id: watchStore.getState().sweepRequest?.id,
          kind: "response",
          type: "error",
          payload: { code: "host_failed", message: "ghp_FixtureSecret" },
        }),
      );
    expect(shown()).toBe(alert);
    expect(now()?.disabled).toBe(false);
    await act(async () => now()?.click());
    expect(shown()).toBeNull();
    expect(
      harness.spi.postMessage.mock.calls.filter(([message]) => sent.asymmetricMatch(message)),
    ).toHaveLength(2);
    await receive("sweep.progress", midSweep({ first: false, sweep: "sweep-2" }));
    expect(now()?.disabled).toBe(true);
    expect(now()?.textContent).toBe("Sweeping");
  },
);

it("spins the first sweep's icon over its progress line, keeps its count in the name, and scrolls the list into view", async () => {
  const scrolled: Element[] = [];
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  vi.stubGlobal("requestAnimationFrame", (step: FrameRequestCallback) =>
    setTimeout(() => step(0), 0),
  );
  try {
    window.location.hash = "#security";
    watchStore.setState({ snapshot: null, setup: null });
    await mount();
    expect(display()).toBe("Not swept");
    expect(glyphName()).toBe("Waiting for the first sweep");
    expect(line()).toBeNull();
    await receive("sweep.progress", midSweep());
    expect(display()).toBe("First sweep");
    expect(glyphName()).toBe("First sweep · 9 of 12 sources done");
    expect(glyph()?.title).toBe("First sweep · 9 of 12 sources done");
    expect(glyph()?.dataset.tone).toBe("run");
    expect(line()?.dataset.sweepProgress).toBe("0.75");
    await openEvidence();
    expect(window.location.hash).toBe("#today");
    expect(scrolled).toEqual([container.querySelector(".today-first .sweep-sources")]);
    expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).toBeNull();
    await receive("sweep.progress", { ...midSweep(), outcome: "cancelled" });
    expect(display()).toBe("First sweep stopped");
    expect(glyph()?.dataset.tone).toBe("bad");
    expect(line()).toBeNull();
  } finally {
    Element.prototype.scrollIntoView = scrollIntoView;
  }
});

it.each(["failed", "cancelled"] as const)(
  "names a %s first sweep as stopped, reveals its panel, and resumes on retry",
  async (outcome) => {
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    vi.stubGlobal("requestAnimationFrame", (step: FrameRequestCallback) =>
      setTimeout(() => step(0), 0),
    );
    window.location.hash = "#security";
    watchStore.setState({ snapshot: null, setup: null });
    await mount();
    await receive(
      "sweep.progress",
      outcome === "cancelled"
        ? {
            ...midSweep(),
            outcome,
          }
        : {
            ...midSweep(),
            outcome: "failed",
            code: "timeout",
            failure: "GitHub did not answer in time.",
            source: "radar",
            nextAttemptAt: null,
          },
    );
    expect(display()).toBe("First sweep stopped");
    expect(glyphName()).toBe("First sweep stopped");
    expect(glyph()?.title).toBe("First sweep stopped");
    expect(glyph()?.dataset.tone).toBe("bad");
    await openEvidence();
    expect(window.location.hash).toBe("#today");
    expect(scrolled).toEqual([container.querySelector(".today-first")]);
    expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).toBeNull();
    const retry = container.querySelector<HTMLButtonElement>(".today-first-actions button");
    expect(retry?.textContent).toBe("Try again");
    await act(async () => retry?.click());
    expect(window.spi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sweep.request", payload: {} }),
    );
    await receive("sweep.progress", midSweep({ sweep: "sweep-2" }));
    expect(display()).toBe("First sweep");
    expect(glyph()?.dataset.tone).toBe("run");
  },
);

it("reads Sweeping over an older snapshot while a later sweep runs and opens its live list", async () => {
  const body = fixture();
  await mount();
  const later = midSweep({ first: false, sweep: "sweep-2" });
  await receive("sweep.progress", later);
  expect(display()).toBe("Sweeping");
  expect(glyphName()).toBe(`Swept ${clockTime(body.sweptAt)} · sweeping, 9 of 12 sources done`);
  expect(glyph()?.dataset.tone).toBe("run");
  expect(line()?.dataset.sweepProgress).toBe("0.75");
  await openEvidence();
  const evidence = () => container.querySelector('#app-right-panel [data-evidence="sweep"]');
  expect(evidence()?.querySelector("[data-sweep-list]")?.getAttribute("data-sweep-list")).toBe(
    "live",
  );
  expect(evidence()?.querySelectorAll(".sweep-row")).toHaveLength(12);
  const facts = [...(evidence()?.querySelectorAll(".sweep-row .evidence-fact") ?? [])];
  expect(facts.length).toBeGreaterThan(0);
  expect(facts.map((fact) => fact.textContent).join()).not.toMatch(/last read/);
  await receive("sweep.progress", {
    ...later,
    outcome: "committed",
    sources: later.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? { source: source.source, state: "read", startedAt: after(120), endedAt: after(128) }
        : source,
    ),
  });
  expect(display()).toBe(clockTime(body.sweptAt));
  expect(line()).toBeNull();
  expect(evidence()?.querySelector("[data-sweep-list]")?.getAttribute("data-sweep-list")).toBe(
    "completed",
  );
  expect(evidence()?.querySelectorAll(".sweep-row")).toHaveLength(12);
  expect(evidence()?.querySelector(".sweep-meta")).toBeNull();
});

it("shows a newer sweep that stopped over the last completed list, with its reason and retry", async () => {
  vi.useFakeTimers({ now: Date.parse(after(130)), toFake: ["Date"] });
  await mount();
  const done = midSweep({ first: false, sweep: "sweep-2" });
  await receive("sweep.progress", {
    ...done,
    outcome: "committed",
    sources: done.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? { source: source.source, state: "read", startedAt: after(120), endedAt: after(128) }
        : source,
    ),
  });
  await openEvidence();
  const list = () =>
    container.querySelector<HTMLElement>(
      '#app-right-panel [data-evidence="sweep"] [data-sweep-list]',
    );
  expect(list()?.dataset.sweepList).toBe("completed");
  const later = midSweep({ first: false, sweep: "sweep-3" });
  await receive("sweep.progress", later);
  expect(list()?.dataset.sweepList).toBe("live");
  await receive("sweep.progress", {
    ...later,
    outcome: "failed",
    code: "timeout",
    failure: "GitLab did not answer in time.",
    source: "radar",
    nextAttemptAt: "2026-11-09T08:07:00Z",
  });
  expect(list()?.dataset.sweepList).toBe("stopped");
  const outcome = list()?.querySelector('[data-sweep-outcome="failed"]');
  expect(outcome?.textContent).toMatch(
    /^This sweep stopped\. It stopped while reading .+: GitLab did not answer in time\. SPI Code tries again at /,
  );
  expect(outcome?.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-09T08:07:00Z");
  expect(list()?.querySelector<HTMLElement>('.sweep-row[data-source="radar"]')?.dataset.tone).toBe(
    "bad",
  );
  expect(list()?.querySelectorAll(".sweep-row")).toHaveLength(12);
});

it("opens each place and the Line with one line before the first snapshot, its sidebar row muted", async () => {
  window.location.hash = "#upstream";
  watchStore.setState({ snapshot: null, setup: null, progress: midSweep() });
  await mount();
  const main = () => container.querySelector("[data-before-sweep] .place-before-sweep");
  expect(container.querySelector("main header h1")?.textContent).toBe("Upstream");
  expect(main()?.textContent).toBe("Upstream opens after the first sweep. It is read 9th of 12.");
  const row = (key: string) =>
    container.querySelector<HTMLElement>(`.app-sidebar [data-sidebar-row="${key}"]`);
  expect(row("upstream")?.hasAttribute("data-before-sweep")).toBe(true);
  expect(row("today")?.hasAttribute("data-before-sweep")).toBe(false);
  await act(async () => {
    window.location.hash = "#security";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(main()?.textContent).toBe("Security opens after the first sweep. It is read 11th of 12.");
  await act(async () => container.querySelector<HTMLElement>('[data-sidebar-row="line"]')?.click());
  expect(sheet()?.querySelector(".line-before-sweep")?.textContent).toBe(
    "Service rows appear after the first sweep.",
  );
  await act(async () => show(fixture()));
  expect(container.querySelector("[data-before-sweep]")).toBeNull();
  expect(sheet()?.querySelector(".line-before-sweep")).toBeNull();
  expect(row("upstream")?.hasAttribute("data-before-sweep")).toBe(false);
});

it("opens the first sweep's retained list in Evidence after hand-over", async () => {
  const body = fixture();
  watchStore.setState({ snapshot: null, setup: null });
  await mount();
  const first = midSweep();
  await receive("sweep.progress", first);
  await receive("sweep.progress", {
    ...first,
    outcome: "committed",
    sources: first.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? { source: source.source, state: "read", startedAt: after(120), endedAt: after(128) }
        : source,
    ),
  });
  await receive("view.snapshot", body);
  expect(display()).toBe(clockTime(body.sweptAt));
  await openEvidence();
  const list = container.querySelector(
    '#app-right-panel [data-evidence="sweep"] [data-sweep-list]',
  );
  expect(list?.getAttribute("data-sweep-list")).toBe("completed");
  expect(list?.querySelectorAll(".sweep-row")).toHaveLength(12);
  expect(list?.querySelector('.sweep-row[data-source="upstream"]')?.textContent).toMatch(/failed/i);
});
