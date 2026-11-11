// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type SweepProgress,
  SweepProgressSchema,
  SweepReasonCodeSchema,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import november6 from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import bad from "../../../../../fixtures/watch/snapshot-bad.json?raw";
import busy from "../../../../../fixtures/watch/snapshot-busy.json?raw";
import calm from "../../../../../fixtures/watch/snapshot-calm.json?raw";
import { SLOT_STATES } from "../../components/kit/Slot.js";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { clockTime, dayLine } from "../../time.js";
import Today from "./index.js";

const MORNINGS = {
  calm: ViewSnapshotSchema.parse(JSON.parse(calm)),
  busy: ViewSnapshotSchema.parse(JSON.parse(busy)),
  "snapshot-1106": ViewSnapshotSchema.parse(JSON.parse(november6)),
  bad: ViewSnapshotSchema.parse(JSON.parse(bad)),
} as const;
type Morning = keyof typeof MORNINGS;
const morning = (name: Morning) => structuredClone(MORNINGS[name]);
const NAMES = Object.keys(MORNINGS) as Morning[];
const cleanups: (() => Promise<void>)[] = [];

async function mount(body: ViewSnapshot, completed: SweepProgress | null = null) {
  const port = { postMessage: vi.fn() };
  const store = createWatchStore(vi.fn(), createSelectionStore(port));
  store.setState({ snapshot: { cursor: body.cursor, body }, completed });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpenSettings = vi.fn();
  const onOpenEvidence = vi.fn();
  await act(async () =>
    root.render(
      <Today store={store} onOpenSettings={onOpenSettings} onOpenEvidence={onOpenEvidence} />,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, onOpenSettings, onOpenEvidence };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const texts = (container: Element, selector: string) =>
  [...container.querySelectorAll(selector)].map((element) => element.textContent);
const clock = (at: string) => clockTime(at, { hint: false });

const GLYPH = { stopped: "✕", "needs-person": "!", "in-progress": "◐", "nothing-due": "○" };

describe.each(NAMES)("on the %s morning", (name) => {
  it("draws core's verdict with its mark, and since rows with a legend of drawn states only", async () => {
    const body = morning(name);
    const { verdict, since } = body.briefing;
    if (!verdict || !since) throw new Error(`${name} carries no verdict or since rows`);
    const { container } = await mount(body);
    const head = container.querySelector(".today-verdict");
    expect(head?.querySelector(".today-headline")?.textContent).toBe(verdict.text);
    expect(head?.getAttribute("data-mark")).toBe(verdict.mark);
    expect(head?.querySelectorAll(".kit-mark")).toHaveLength(1);
    expect(head?.querySelector(".kit-mark")?.textContent).toBe(GLYPH[verdict.mark]);

    const rows = [...container.querySelectorAll(".today-since-row")];
    expect(rows.map((row) => row.getAttribute("data-workflow"))).toEqual(
      since.rows.map(({ workflow }) => workflow),
    );
    expect(texts(container, ".today-since .kit-slot-row-label")).toEqual(
      since.rows.map(({ label }) => label),
    );
    expect(texts(container, ".today-since .kit-slot-row-count")).toEqual(
      since.rows.map(({ countText }) => countText),
    );
    rows.forEach((row, index) => {
      expect(
        [...row.querySelectorAll(".kit-slot")].map((slot) => slot.getAttribute("aria-label")),
      ).toEqual(since.rows[index]?.slots.map(({ text }) => text));
    });
    const drawn = new Set(since.rows.flatMap(({ slots }) => slots.map(({ state }) => state)));
    expect(container.querySelectorAll(".today-since .kit-slot-legend")).toHaveLength(1);
    expect(
      [...container.querySelectorAll(".today-since .kit-slot-legend [data-state]")].map((entry) =>
        entry.getAttribute("data-state"),
      ),
    ).toEqual(SLOT_STATES.filter((state) => drawn.has(state)));
  });

  it("dates the page by its sweep only and keeps the frame in briefing order", async () => {
    const body = morning(name);
    const { container } = await mount(body);
    const date = container.querySelector(".place-header .today-date");
    expect(date?.getAttribute("dateTime")).toBe(body.sweptAt);
    expect(date?.textContent).toBe(dayLine(body.sweptAt));
    expect(date?.textContent).toMatch(/^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]{2}$/);
    const frame = container.querySelector(".today .place-reading.today-frame");
    expect(frame).not.toBeNull();
    expect(frame?.firstElementChild?.className).toBe("today-head");
    const order = ["band", "horizon", "places", "releases", "motion"];
    const slots = [...(frame?.querySelectorAll(".today-slot") ?? [])].map((slot) =>
      order.indexOf(slot.getAttribute("data-today-slot") ?? ""),
    );
    expect(
      slots.every((at, index) => at >= 0 && (index === 0 || at > (slots[index - 1] ?? 0))),
    ).toBe(true);
    expect(frame?.querySelectorAll(".today-slot:empty")).toHaveLength(0);
    expect(frame?.querySelector('[data-today-slot="places"]')).not.toBeNull();
    expect(frame?.querySelectorAll("[data-today-slot=horizon]")).toHaveLength(1);
  });
});

describe("the caveat band", () => {
  it.each([
    ["calm", []],
    ["busy", []],
    ["snapshot-1106", ["radar"]],
    ["bad", ["github"]],
  ] as const)(
    "on %s shows exactly the areas that failed or were cut this sweep",
    async (name, areas) => {
      const body = morning(name);
      const { container } = await mount(body);
      const band = container.querySelector(".today-caveat");
      if (areas.length === 0) {
        expect(band).toBeNull();
        return;
      }
      expect(band?.getAttribute("role")).toBe("note");
      expect([...(band?.querySelectorAll("li") ?? [])].map((li) => li.dataset.area)).toEqual(areas);
      expect(texts(container, ".today-caveat-actions button")).toEqual(["Evidence ›"]);
    },
  );

  it("names the area, the sweep's time and what may be missing, and opens Evidence", async () => {
    const body = morning("bad");
    const { container, onOpenEvidence } = await mount(body);
    expect(container.querySelector(".today-caveat li")?.textContent).toBe(
      `GitHub issues and PRs read failed at ${clock(body.sweptAt)}; items from it may be missing.`,
    );
    expect(container.querySelector(".today-caveat li time")?.getAttribute("dateTime")).toBe(
      body.sweptAt,
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".today-caveat-actions button")?.click(),
    );
    expect(onOpenEvidence).toHaveBeenCalledOnce();
  });

  it("says a cut read was read only in part, and leaves an area that was only not read this sweep out", async () => {
    const body = morning("busy");
    const radar = body.areas.find(({ area }) => area === "radar");
    const security = body.areas.find(({ area }) => area === "security");
    if (!radar || !security) throw new Error("busy carries no radar or security area");
    radar.envelope = {
      source: "radar",
      state: "incomplete",
      observedAt: body.sweptAt,
      completeness: { kind: "cut", read: 6, total: 13, reason: "budget" },
    };
    security.envelope = { source: "security", state: "unread" };
    const { container } = await mount(body);
    expect(texts(container, ".today-caveat li")).toEqual([
      `Upstream radar was read only in part at ${clock(body.sweptAt)}; items from it may be missing.`,
    ]);
    radar.envelope = {
      source: "radar",
      state: "fresh",
      observedAt: body.sweptAt,
      completeness: { kind: "complete" },
    };
    const unreadOnly = await mount(body);
    expect(unreadOnly.container.querySelector(".today-caveat")).toBeNull();
  });

  it.each(SweepReasonCodeSchema.options)(
    "offers Open Settings only for a Readiness-fixable code: %s",
    async (code) => {
      const body = morning("bad");
      const completed = SweepProgressSchema.parse({
        sweep: "sweep-9",
        first: false,
        outcome: "committed",
        startedAt: "2026-11-06T14:00:00Z",
        usualMs: 120_000,
        nextAttemptAt: null,
        sources: [
          {
            source: "github",
            state: "failed",
            startedAt: "2026-11-06T14:00:10Z",
            endedAt: "2026-11-06T14:00:20Z",
            code,
            reason: "GitHub could not be read.",
          },
        ],
      });
      const { container, onOpenSettings } = await mount(body, completed);
      const actions = texts(container, ".today-caveat-actions button");
      expect(actions).toEqual(
        code === "signin" ? ["Evidence ›", "Open Settings ›"] : ["Evidence ›"],
      );
      if (code !== "signin") return;
      await act(async () =>
        container.querySelectorAll<HTMLButtonElement>(".today-caveat-actions button")[1]?.click(),
      );
      expect(onOpenSettings).toHaveBeenCalledOnce();
    },
  );
});

it("marks since pips held from a kept read with the oldest last good time, and opens Evidence", async () => {
  const body = morning("bad");
  const github = body.areas.find(({ area }) => area === "github")?.envelope;
  if (github?.state !== "failed" || !github.observedAt) throw new Error("bad keeps no github read");
  const { container, onOpenEvidence } = await mount(body);
  const held = container.querySelector<HTMLButtonElement>(".today-since .today-held");
  expect(held?.textContent).toBe(`⌀ from ${clock(github.observedAt)}`);
  expect(held?.querySelector("time")?.getAttribute("dateTime")).toBe(github.observedAt);
  expect(held?.title).toContain("GitHub issues and PRs · read failed");
  await act(async () => held?.click());
  expect(onOpenEvidence).toHaveBeenCalledOnce();

  for (const name of ["calm", "busy", "snapshot-1106"] as const) {
    const fresh = await mount(morning(name));
    expect(fresh.container.querySelector(".today-held")).toBeNull();
  }
  const unread = morning("calm");
  const runs = unread.areas.find(({ area }) => area === "runs");
  if (!runs) throw new Error("calm carries no runs area");
  runs.envelope = { source: "runs", state: "unread" };
  const notRead = await mount(unread);
  expect(notRead.container.querySelector(".today-held")?.textContent).toBe("⌀ not read");
});

it("labels the since window from core's basis, with 24 h only for the fallback", async () => {
  const body = morning("snapshot-1106");
  const since = body.briefing.since;
  if (!since) throw new Error("1106 carries no since rows");
  const chip = (container: Element) => container.querySelector(".today-since-basis time");
  const cases = [
    [{ ...since, basis: "fallback" as const }, "24 h", since.from],
    [{ ...since, basis: "seen" as const }, `since ${clock(since.from)}`, since.from],
    [{ ...since, basis: "history-short" as const }, `since ${clock(since.from)}`, since.from],
    [
      { ...since, basis: "stale" as const, asOf: body.sweptAt },
      `as of ${clock(body.sweptAt)}`,
      body.sweptAt,
    ],
  ] as const;
  for (const [basis, label, time] of cases) {
    const { container } = await mount({ ...body, briefing: { ...body.briefing, since: basis } });
    expect(container.querySelector(".today-since")?.getAttribute("data-basis")).toBe(basis.basis);
    expect(chip(container)?.textContent).toBe(label);
    expect(chip(container)?.getAttribute("dateTime")).toBe(time);
  }
});

it("draws no mark and no since rows when core sends neither, never a calm mark", async () => {
  const body = morning("busy");
  delete body.briefing.verdict;
  delete body.briefing.since;
  const { container } = await mount(body);
  expect(
    container.querySelector(
      ".today-head .today-verdict, .today-head .kit-mark, .today-head .today-since",
    ),
  ).toBeNull();
  expect(container.querySelector(".today-frame")).not.toBeNull();
});

it.each(NAMES)(
  "draws no tile, fold, deadline group or capped item list on the %s morning",
  async (name) => {
    const body = morning(name);
    const { container } = await mount(body);
    const today = container.querySelector(".today");
    expect(
      today?.querySelector(
        ".place-tiles, .place-tile, details, summary, .today-folded, .place-group, .place-item",
      ),
    ).toBeNull();
    const releases = today?.querySelector(".today-releases")?.textContent ?? "";
    const text = today?.textContent?.replace(releases, releases.replaceAll("release PRs open", ""));
    expect(text).not.toMatch(
      /Before next sync|\bOwned\b|\bNew\b|\d+ more\b|release PRs open|osdu-spi/,
    );
    for (const item of [...body.briefing.focus, ...body.briefing.rest])
      expect(today?.querySelectorAll(`[data-item-id="${item.id}"]`)).toHaveLength(
        item.attention === "interrupt" ? 1 : 0,
      );
  },
);
