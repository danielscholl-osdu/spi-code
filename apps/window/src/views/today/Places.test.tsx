// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import bad from "../../../../../fixtures/watch/snapshot-bad.json?raw";
import busy from "../../../../../fixtures/watch/snapshot-busy.json?raw";
import calm from "../../../../../fixtures/watch/snapshot-calm.json?raw";
import { selectionStore } from "../../panels/selection.js";
import { clockTime } from "../../time.js";
import { Places } from "./Places.js";

const mornings = { calm, busy, bad };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  selectionStore.getState().setOpen(false);
  vi.restoreAllMocks();
});
const snapshot = (name: keyof typeof mornings) =>
  ViewSnapshotSchema.parse(JSON.parse(mornings[name]));
async function mount(body: ViewSnapshot) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onNavigate = vi.fn();
  await act(async () => root.render(<Places snapshot={body} onNavigate={onNavigate} />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, onNavigate };
}

it.each(["calm", "busy", "bad"] as const)(
  "draws %s cards and micro-visuals from core in sidebar order",
  async (name) => {
    const body = snapshot(name);
    const { container } = await mount(body);
    const cards = [...container.querySelectorAll<HTMLElement>(".today-place")];
    expect(cards.map((card) => card.dataset.place)).toEqual([
      "line",
      "environment",
      "engineering",
      "security",
    ]);
    cards.forEach((card, index) => {
      const row = body.briefing.places?.[index];
      if (!row) throw new Error("Missing core place");
      expect(card.dataset.mark).toBe(row.mark);
      expect(card.querySelector(".kit-mark")?.getAttribute("title")).toBeTruthy();
      expect(card.querySelector(".today-place-figure")?.textContent).toBe(row.figure);
      expect(card.querySelector(".today-place-figure")?.getAttribute("data-tone")).toBe(row.tone);
      expect(card.querySelector(".today-place-reason")?.textContent ?? undefined).toBe(
        row.mark === "nothing-due" ? undefined : row.reason,
      );
      expect(card.querySelector(".today-place-caveat")?.textContent ?? undefined).toBe(row.caveat);
      expect(card.querySelector(".today-place-open")?.getAttribute("title")).toBe(row.line);
      const visual = row.visual;
      expect(card.querySelector("[data-visual]")?.getAttribute("data-visual")).toBe(visual?.kind);
      if (visual?.kind === "pips" || visual?.kind === "rollout") {
        const slots = [...card.querySelectorAll(".today-place-slot")];
        expect(slots.map((slot) => slot.getAttribute("aria-label"))).toEqual(
          visual.slots.map(({ text }) => text),
        );
        expect(slots.map((slot) => slot.getAttribute("data-state"))).toEqual(
          visual.slots.map(({ state }) => state),
        );
        if (visual.kind === "pips")
          expect(
            [...card.querySelectorAll(".today-place-stopped button")].map(
              (button) => button.textContent,
            ),
          ).toEqual(visual.stopped);
      } else if (visual?.kind === "lifecycle") {
        expect(
          [...card.querySelectorAll("meter")].map((meter) => [
            Number(meter.getAttribute("value")),
            Number(meter.getAttribute("max")),
            meter.title,
          ]),
        ).toEqual(visual.lanes.map((lane) => [lane.green, lane.total || 1, lane.text]));
        expect(card.querySelector(".today-place-green time")?.getAttribute("datetime")).toBe(
          visual.greenSince,
        );
      } else if (visual?.kind === "forkColumns") {
        const columns = [...card.querySelectorAll<HTMLElement>(".today-place-column")];
        expect(columns.map((column) => column.dataset.service)).toEqual(
          visual.columns.map(({ service }) => service),
        );
        expect(columns.map((column) => column.getAttribute("aria-label"))).toEqual(
          visual.columns.map(({ text }) => text),
        );
        expect(columns.map((column) => column.dataset.count)).toEqual(
          visual.columns.map(({ count }) => String(count)),
        );
        expect(card.querySelector(".today-place-program")?.textContent).toBe(visual.program?.text);
        expect(card.querySelector(".today-place-largest")?.textContent).toBe(visual.largest?.text);
        const line = body.briefing.places?.find(({ place }) => place === "line")?.visual;
        if (line?.kind === "pips")
          expect(visual.columns.map(({ service }) => service)).toEqual(
            line.slots.map(({ service }) => service),
          );
      }
    });
  },
);

it("keeps bad morning figures muted with core's oldest last-good time and names each affected area", async () => {
  const body = snapshot("bad");
  const { container } = await mount(body);
  for (const row of body.briefing.places ?? []) {
    const card = container.querySelector(`[data-place="${row.place}"]`);
    expect(card?.hasAttribute("data-unread")).toBe(Boolean(row.unread));
    if (!row.unread) continue;
    const held = card?.querySelector(".today-place-held");
    expect(held).not.toBeNull();
    expect(held?.querySelector("time")?.getAttribute("datetime")).toBe(row.unread.lastGood);
    if (row.unread.lastGood)
      expect(held?.textContent).toContain(clockTime(row.unread.lastGood, { hint: false }));
    for (const area of row.unread.areas) expect(held?.getAttribute("data-areas")).toContain(area);
  }
});

it("opens each card, each fork and a fresh chip at its own place", async () => {
  const body = snapshot("busy");
  const row = body.briefing.places?.find(({ place }) => place === "security");
  if (!row) throw new Error("Missing Security");
  row.fresh.itemIds = ["fresh-background"];
  const { container, onNavigate } = await mount(body);
  const expected = ["line", "environment", "engineering-system", "security"];
  for (const [index, button] of [
    ...container.querySelectorAll<HTMLButtonElement>(".today-place-open"),
  ].entries()) {
    await act(async () => button.click());
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: expected[index] });
  }
  for (const button of container.querySelectorAll<HTMLButtonElement>("button[data-service]")) {
    await act(async () => button.click());
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "service", id: button.dataset.service });
  }
  expect(container.querySelectorAll(".today-place-new")).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>(".today-place-new")?.click());
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "security" });
});

it("opens affected-area Evidence and scrolls to that source", async () => {
  const body = snapshot("bad");
  const { container } = await mount(body);
  const source = document.createElement("div");
  source.setAttribute("data-evidence", "sweep");
  source.innerHTML = '<div data-source="github"></div>';
  document.body.append(source);
  const target = source.firstElementChild as HTMLElement;
  target.scrollIntoView = vi.fn();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  for (const button of container.querySelectorAll<HTMLButtonElement>(".today-place-held")) {
    await act(async () => button.click());
    expect(selectionStore.getState()).toMatchObject({
      open: true,
      tab: "evidence",
      evidenceScope: "sweep",
    });
    expect(target.scrollIntoView).toHaveBeenCalled();
  }
  source.remove();
});

it("does not infer missing visuals, freshness, reasons or last-good reads", async () => {
  const body = snapshot("calm");
  const row = body.briefing.places?.[0];
  if (!row) throw new Error("Missing Line");
  delete row.visual;
  row.unread = { areas: ["github"] };
  const { container } = await mount(body);
  expect(container.querySelector('[data-place="line"] [data-visual]')).toBeNull();
  expect(container.querySelector(".today-place-new")).toBeNull();
  expect(container.querySelector('[data-place="line"] .today-place-held time')).toBeNull();
  expect(container.querySelector('[data-place="line"] .today-place-held')?.textContent).toContain(
    "not read",
  );
});

it("keeps a zero Security column distinct from an unknown read and labels the program separately", async () => {
  const body = snapshot("busy");
  const visual = body.briefing.places?.find(({ place }) => place === "security")?.visual;
  if (visual?.kind !== "forkColumns" || !visual.columns[0] || !visual.columns[1])
    throw new Error("Missing Security columns");
  visual.columns[0].count = 0;
  visual.columns[1].count = null;
  const { container } = await mount(body);
  const [zero, unknown] = container.querySelectorAll<HTMLElement>(".today-place-column");
  expect(zero?.querySelector<HTMLElement>(".kit-segment")?.style.height).toBe("2px");
  expect(zero?.querySelector(".today-place-unknown")).toBeNull();
  expect(unknown?.textContent).toBe("?");
  expect(container.querySelectorAll(".today-place-column")).toHaveLength(13);
  expect(container.querySelector(".today-place-program")?.textContent).toBe(visual.program?.text);
});

it("uses each affected area's hover time and only core's oldest time on the card", async () => {
  const body = snapshot("bad");
  const line = body.briefing.places?.find(({ place }) => place === "line");
  const runs = body.areas.find(({ area }) => area === "runs");
  if (!line || !runs) throw new Error("Missing Line or runs");
  const at = "2026-11-06T12:32:00Z";
  runs.envelope = {
    source: "runs",
    state: "failed",
    observedAt: at,
    completeness: { kind: "complete" },
  };
  line.unread = { areas: ["github", "runs"], lastGood: at };
  const { container } = await mount(body);
  const held = container.querySelector('[data-place="line"] .today-place-held');
  expect(held?.querySelector("time")?.getAttribute("datetime")).toBe(at);
  expect(held?.getAttribute("title")).toContain(clockTime(at, { hint: false }));
  expect(held?.getAttribute("title")).toContain("GitHub issues and PRs");
  expect(held?.getAttribute("title")).toContain("Workflow runs");
});

it("opens the horizon chip at the horizon block", async () => {
  const { container } = await mount(snapshot("busy"));
  const horizon = document.createElement("div");
  horizon.setAttribute("data-today-slot", "horizon");
  horizon.scrollIntoView = vi.fn();
  document.body.append(horizon);
  await act(async () => container.querySelector<HTMLButtonElement>(".kit-chip--upstream")?.click());
  expect(horizon.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  horizon.remove();
});

it.each(["unknown", "broken", "waiting"] as const)(
  "draws a kit %s mark for an unverified Engineering rollout slot",
  async (state) => {
    const body = snapshot("busy");
    const visual = body.briefing.places?.find(({ place }) => place === "engineering")?.visual;
    if (visual?.kind !== "rollout" || !visual.slots[0]) throw new Error("Missing rollout slots");
    const slot = visual.slots[0];
    slot.state = state;
    slot.text = `${slot.service}: ${state}`;
    const { container } = await mount(body);
    const button = container.querySelector('[data-place="engineering"] .today-place-slot');
    const mark = button?.querySelector(`.kit-slot--${state}`);
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("aria-label")).toBe(slot.text);
    expect(mark?.getAttribute("data-shape")).toBe(
      state === "unknown" ? "dotted-circle" : state === "broken" ? "diamond" : "triangle",
    );
    expect(button?.querySelector(".kit-cell--outlined")).toBeNull();
  },
);

it("uses Evidence's cut wording in the held-read hover", async () => {
  const body = snapshot("bad");
  const line = body.briefing.places?.find(({ place }) => place === "line");
  const runs = body.areas.find(({ area }) => area === "runs");
  if (!line || !runs) throw new Error("Missing Line or runs");
  const at = "2026-11-06T12:32:00Z";
  runs.envelope = {
    source: "runs",
    state: "incomplete",
    observedAt: at,
    completeness: { kind: "cut", reason: "page_limit", read: 2, total: 13 },
  };
  line.unread = { areas: ["runs"], lastGood: at };
  const { container } = await mount(body);
  const held = container.querySelector('[data-place="line"] .today-place-held');
  expect(held?.getAttribute("title")).toBe(
    `Workflow runs: cut, last good ${clockTime(at, { hint: false })}`,
  );
});

it("opens the oldest affected read even when a newer area is listed first", async () => {
  const body = snapshot("bad");
  const line = body.briefing.places?.find(({ place }) => place === "line");
  const runs = body.areas.find(({ area }) => area === "runs");
  const github = body.areas.find(({ area }) => area === "github");
  if (!line || !runs || !github) throw new Error("Missing affected areas");
  const lastGood = "2026-11-06T12:32:00Z";
  runs.envelope = {
    source: "runs",
    state: "failed",
    observedAt: lastGood,
    completeness: { kind: "complete" },
  };
  github.envelope = {
    source: "github",
    state: "failed",
    observedAt: "2026-11-06T13:52:00Z",
    completeness: { kind: "complete" },
  };
  line.unread = { areas: ["github", "runs"], lastGood };
  const { container } = await mount(body);
  const evidence = document.createElement("div");
  evidence.dataset.evidence = "sweep";
  evidence.innerHTML = '<div data-source="github"></div><div data-source="runs"></div>';
  document.body.append(evidence);
  cleanups.push(async () => evidence.remove());
  const newest = evidence.children[0] as HTMLElement;
  const oldest = evidence.children[1] as HTMLElement;
  newest.scrollIntoView = vi.fn();
  oldest.scrollIntoView = vi.fn();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-place="line"] .today-place-held')?.click(),
  );
  expect(selectionStore.getState()).toMatchObject({
    open: true,
    tab: "evidence",
    evidenceScope: "sweep",
  });
  expect(oldest.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  expect(newest.scrollIntoView).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(oldest);
});
