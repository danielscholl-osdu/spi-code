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
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { watchFixtureText } from "../../test-utils/watch-fixtures.test-helper.js";
import { clockTime, dayLine } from "../../time.js";
import { bandHolds } from "./Band.js";
import Today from "./index.js";

const bad = watchFixtureText("snapshot-bad.json", readFixture);
const busy = watchFixtureText("snapshot-busy.json", readFixture);
const calm = watchFixtureText("snapshot-calm.json", readFixture);

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
  it("dates the page by its sweep only and keeps the frame in briefing order", async () => {
    const body = morning(name);
    const { container } = await mount(body);
    const date = container.querySelector(".place-header .today-date");
    expect(date?.getAttribute("dateTime")).toBe(body.sweptAt);
    expect(date?.textContent).toBe(dayLine(body.sweptAt));
    expect(date?.textContent).toMatch(/^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]{2}$/);
    const frame = container.querySelector(".today .place-reading.today-frame");
    expect(frame).not.toBeNull();
    if (bandHolds(body)) expect(frame?.querySelector(".today-head")).toBeNull();
    else expect(frame?.firstElementChild?.className).toBe("today-head");
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

const VERDICT_GONE = ".today-head, .today-verdict, .today-since, .today-band-mark, .today-held";

/** The calm morning with one of busy's Interrupts, so its band is drawn. */
function calmWithBand() {
  const body = morning("calm");
  const [item] = morning("busy").briefing.focus.filter(
    ({ attention }) => attention === "interrupt",
  );
  if (!item) throw new Error("busy carries no Interrupt");
  body.briefing.focus.push(item);
  return body;
}

/** The busy morning with nothing in its band. */
function busyWithoutBand() {
  const body = morning("busy");
  for (const item of [...body.briefing.focus, ...body.briefing.rest])
    if (item.attention === "interrupt") item.attention = "surface";
  if (!body.briefing.decisions || !body.briefing.ambient) throw new Error("busy is incomplete");
  body.briefing.decisions = { items: 0, text: "", groups: [] };
  body.briefing.ambient.failing = { items: 0, text: "", lines: [] };
  return body;
}

describe("the verdict", () => {
  it.each([
    ["calm", () => morning("calm")],
    ["busy with its band emptied", busyWithoutBand],
  ] as const)("is drawn with its mark on the %s morning, whose band is empty", async (_, make) => {
    const body = make();
    const { verdict } = body.briefing;
    if (!verdict) throw new Error("the morning carries no verdict");
    const { container } = await mount(body);
    expect(container.querySelector(".today-band")).toBeNull();
    const head = container.querySelector(".today-frame > .today-head > .today-verdict");
    expect(head?.querySelector(".today-headline")?.textContent).toBe(verdict.text);
    expect(head?.getAttribute("data-mark")).toBe(verdict.mark);
    expect(head?.querySelectorAll(".kit-mark")).toHaveLength(1);
    expect(head?.querySelector(".kit-mark")?.textContent).toBe(GLYPH[verdict.mark]);
    expect(container.querySelector(".today-since, .today-band-mark")).toBeNull();
  });

  it.each([
    ["busy", () => morning("busy")],
    ["calm with an Interrupt", calmWithBand],
  ] as const)(
    "and the since rows and place marks are not drawn on the %s morning, whose band is",
    async (_, make) => {
      const body = make();
      expect(body.briefing.verdict).toBeDefined();
      expect(body.briefing.since?.rows.length).toBeGreaterThan(0);
      const { container } = await mount(body);
      expect(container.querySelector(".today-band")).not.toBeNull();
      expect(container.querySelector(VERDICT_GONE)).toBeNull();
      expect(container.querySelector(".today-frame")?.textContent).not.toContain(
        body.briefing.verdict?.text,
      );
    },
  );

  it("draws no head and no mark when core sends no verdict, never a calm mark", async () => {
    const body = morning("calm");
    delete body.briefing.verdict;
    const { container } = await mount(body);
    expect(container.querySelector(`${VERDICT_GONE}, .today-frame > .kit-mark`)).toBeNull();
    expect(container.querySelector(".today-frame")).not.toBeNull();
  });
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
