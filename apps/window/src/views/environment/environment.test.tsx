// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import consoleHtml from "../../../../../fixtures/rib-59d6895/oracle/console.html?raw";
import placement from "../../../../../fixtures/rib-59d6895/oracle/environment-place.json?raw";
import releases from "../../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { testSnapshot } from "../../store/test-snapshot.js";
import { createWatchStore } from "../../store/watch.js";
import Environment from "./index.js";
import { eventWhen, firstEvent, hourTicks, place } from "./timeline.js";

const snapshot = testSnapshot(briefing, releases);
const environment = snapshot.briefing.environment;
const from = Date.parse(environment.from);
const to = Date.parse(environment.to);
const first = environment.lanes[0]?.events[0];
if (!first) throw new Error("Oracle must contain an event");

it("places every frozen event exactly as the rib oracle", () => {
  expect({
    from: environment.from,
    to: environment.to,
    lanes: environment.lanes.map((lane) => ({
      id: lane.id,
      placed: place(lane.events, from, to),
    })),
  }).toEqual(JSON.parse(placement));
});

it("sorts without mutation, clips open events and bounds overlapping tiers at six", () => {
  const event = first;
  const events = Array.from({ length: 8 }, (_, id) => ({
    ...event,
    id: String(id),
    start: new Date(500).toISOString(),
    end: new Date(500).toISOString(),
    label: "a",
    state: "ok" as const,
  }));
  expect(
    place(events, 0, 1000).map(({ left, width, tier, flip }) => [left, width, tier, flip]),
  ).toEqual([0, 1, 2, 3, 4, 5, 0, 0].map((tier) => [50, 0, tier, false]));
  const early = { ...event, start: new Date(-500).toISOString() };
  const late = { ...event, start: new Date(1500).toISOString() };
  const unsorted = [late, early];
  expect(
    place(unsorted, 0, 1000).map(({ e, left, width, flip }) => [e.start, left, width, flip]),
  ).toEqual([
    [early.start, 0, 100, true],
    [late.start, 100, 0, true],
  ]);
  expect(unsorted).toEqual([late, early]);
});

it("reuses cleared tiers and reserves space for a flipped label", () => {
  const events = [10, 11, 50, 95].map((at, id) => ({
    ...first,
    id: String(id),
    label: "a",
    state: "ok" as const,
    start: new Date(at).toISOString(),
    end: new Date(at + 5).toISOString(),
  }));
  expect(
    place(events, 0, 100).map(({ left, width, tier, flip }) => [left, width, tier, flip]),
  ).toEqual([
    [10, expect.closeTo(5), 0, false],
    [11, expect.closeTo(5), 1, false],
    [50, expect.closeTo(5), 0, false],
    [95, expect.closeTo(5), 0, true],
  ]);
});

it("prefers the newest failed event, otherwise the newest event, and uses the track clock", () => {
  const events = [10, 20, 30].map((at, id) => ({
    ...first,
    id: String(id),
    start: new Date(at).toISOString(),
    state: id === 1 ? ("failed" as const) : ("running" as const),
  }));
  const lane = { id: "upgrade" as const, label: "Upgrade", events };
  expect(firstEvent([lane])).toBe("upgrade:1");
  expect(firstEvent([{ ...lane, events: events.filter((e) => e.state !== "failed") }])).toBe(
    "upgrade:2",
  );
  expect(firstEvent([])).toBeUndefined();
  expect(eventWhen({ ...first, start: new Date(0).toISOString() }, new Date(3_600_000))).toContain(
    "to now \u00b7 1 h",
  );
});

it("ticks at local hours strictly inside the window", () => {
  const start = new Date(2026, 9, 21, 10, 30).getTime();
  const end = new Date(2026, 9, 21, 13).getTime();
  expect(hourTicks(start, end).map(({ text }) => text)).toEqual(["11:00", "12:00"]);
  expect(hourTicks(new Date(2026, 9, 21, 11).getTime(), end).map(({ text }) => text)).toEqual([
    "12:00",
  ]);
});

it("renders oracle lane order, labels, facts and bars; selects details and the inspector", async () => {
  const store = createWatchStore(vi.fn());
  const receive = (body: typeof snapshot) =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: "snapshot",
      kind: "event",
      type: "view.snapshot",
      payload: body,
    });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Environment store={store} />));
    expect(container.textContent).toContain("Waiting for the first sweep.");
    await act(async () => receive(snapshot));
    expect(container.querySelector("h2")?.textContent).toBe(environment.headline);
    const labels = [...consoleHtml.matchAll(/<div class="tl-lab">([^<]+)<\/div>/g)].map(
      (match) => match[1],
    );
    expect([...container.querySelectorAll(".env-lane-label")].map((el) => el.textContent)).toEqual(
      labels,
    );
    expect(
      [...container.querySelectorAll("[data-lane]")].map((el) => el.getAttribute("data-lane")),
    ).toEqual(JSON.parse(placement).lanes.map((lane: { id: string }) => lane.id));
    for (const fact of environment.facts) {
      expect(container.textContent).toContain(fact.label);
      expect(container.textContent).toContain(fact.figure);
      expect(container.textContent).toContain(fact.sub);
    }
    expect(container.textContent).toContain(environment.note);
    expect(container.querySelectorAll(".env-none")).toHaveLength(2);
    for (const lane of JSON.parse(placement).lanes) {
      for (const p of lane.placed) {
        const bar = container.querySelector<HTMLButtonElement>(
          `[data-event="${lane.id}:${p.e.id}"]`,
        );
        expect(bar?.style.left).toBe(`${p.left}%`);
        expect(bar?.style.width).toBe(`${p.width}%`);
        expect(bar?.style.top).toBe(`${p.tier * 22 + 10}px`);
        expect(bar?.querySelector(".env-event-label")?.classList.contains("flip")).toBe(p.flip);
      }
    }
    const bars = container.querySelectorAll<HTMLButtonElement>("[data-event]");
    await act(async () => bars[1]?.click());
    expect(bars[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(bars[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".env-detail")?.textContent).toContain(
      environment.lanes[3]?.events[0]?.detail,
    );
    await act(async () => container.querySelector<HTMLButtonElement>(".env-inspect")?.click());
    expect(store.getState().selection?.id).toBe("stack:38181620856");

    const failed = { ...first, id: "failure", state: "failed" as const };
    await act(async () =>
      receive({
        ...snapshot,
        cursor: 2,
        briefing: {
          ...snapshot.briefing,
          environment: {
            ...environment,
            lanes: [{ id: "upgrade", label: "Upgrade", events: [failed] }],
          },
        },
      }),
    );
    expect(container.querySelector("[data-event]")?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".env-detail")?.textContent).toContain("failed");
    await act(async () =>
      receive({
        ...snapshot,
        cursor: 3,
        briefing: { ...snapshot.briefing, environment: { ...environment, lanes: [] } },
      }),
    );
    expect(container.querySelector(".env-timeline")).toBeNull();
    expect(container.querySelector(".env-detail")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
