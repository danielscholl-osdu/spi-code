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
import { midSweep } from "../../components/sweep/test-helper.js";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { watchFixtureText } from "../../test-utils/watch-fixtures.test-helper.js";
import { clockTime, dayLine } from "../../time.js";
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
  const send = vi.fn();
  const store = createWatchStore(send, createSelectionStore(port));
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
  return { container, onOpenSettings, onOpenEvidence, store, send };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const texts = (container: Element, selector: string) =>
  [...container.querySelectorAll(selector)].map((element) => element.textContent);
const clock = (at: string) => clockTime(at, { hint: false });

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
    const fleet = body.briefing.today?.fleet;
    const unread =
      fleet && [...fleet.stations, ...fleet.doors].some(({ notRead }) => notRead.length);
    expect(
      [...(frame?.children ?? [])]
        .map((child) => child.className || child.getAttribute("role"))
        .filter((name) => name !== "today-caveat"),
    ).toEqual([
      ...(fleet ? ["flow-wrap"] : []),
      ...(unread ? ["today-not-read"] : []),
      "today-tabs",
      "tabpanel",
    ]);
    const order = ["blocked", "waiting", "can-wait"];
    const sections = [...(frame?.querySelectorAll<HTMLElement>(".today-section") ?? [])].map(
      ({ dataset }) => dataset.section ?? "",
    );
    expect(sections).toEqual(order.filter((id) => sections.includes(id)));
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
      expect(texts(container, ".today-caveat button")).not.toContain("Evidence ›");
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
    const link = container.querySelector<HTMLButtonElement>(".today-caveat li button");
    expect(link?.textContent).toBe("GitHub issues and PRs");
    expect(link?.getAttribute("aria-label")).toBe("GitHub issues and PRs: open Evidence");
    await act(async () => link?.click());
    expect(onOpenEvidence).toHaveBeenCalledOnce();
  });

  it("links each affected area's line to Evidence on its own", async () => {
    const body = morning("bad");
    const radar = body.areas.find(({ area }) => area === "radar");
    if (!radar) throw new Error("bad carries no radar area");
    radar.envelope = {
      source: "radar",
      state: "incomplete",
      observedAt: body.sweptAt,
      completeness: { kind: "cut", read: 6, total: 13, reason: "budget" },
    };
    const { container, onOpenEvidence } = await mount(body);
    const links = [...container.querySelectorAll<HTMLButtonElement>(".today-caveat li button")];
    expect(links.map((link) => link.closest("li")?.dataset.area)).toEqual(["github", "radar"]);
    for (const link of links) await act(async () => link.click());
    expect(onOpenEvidence).toHaveBeenCalledTimes(2);
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
        code === "signin" ? ["Read again", "Open Settings ›"] : ["Read again"],
      );
      if (code !== "signin") return;
      await act(async () =>
        container.querySelectorAll<HTMLButtonElement>(".today-caveat-actions button")[1]?.click(),
      );
      expect(onOpenSettings).toHaveBeenCalledOnce();
    },
  );
});

describe("Read again on the caveat band", () => {
  const readAgain = (container: Element) =>
    [...container.querySelectorAll<HTMLButtonElement>(".today-caveat-actions button")].find(
      ({ textContent }) => textContent === "Read again",
    );

  it("sends one sweep request without now, and sends nothing more while it is pending", async () => {
    const { container, send } = await mount(morning("bad"));
    await act(async () => readAgain(container)?.click());
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ type: "sweep.request", payload: {} });
    expect(send.mock.calls[0]?.[0].payload).not.toHaveProperty("now");
    expect(readAgain(container)?.disabled).toBe(true);
    await act(async () => readAgain(container)?.click());
    expect(send).toHaveBeenCalledOnce();
  });

  it("is disabled while a sweep runs, and live again once it ends", async () => {
    const { container, store, send } = await mount(morning("bad"));
    await act(async () => store.setState({ progress: midSweep() }));
    expect(readAgain(container)?.disabled).toBe(true);
    await act(async () => readAgain(container)?.click());
    expect(send).not.toHaveBeenCalled();
    await act(async () => store.setState({ progress: midSweep({ outcome: "committed" }) }));
    expect(readAgain(container)?.disabled).toBe(false);
  });
});

it.each(NAMES)(
  "draws no verdict, horizon, place cards, releases or In motion on the %s morning, with or without lines",
  async (name) => {
    const gone =
      ".today-head, .today-verdict, .today-headline, .kit-mark, .today-horizon, .today-place, .today-releases, .today-motion, .today-canwait, [data-today-slot]";
    const body = morning(name);
    const { container } = await mount(body);
    expect(container.querySelector(gone)).toBeNull();
    const older = morning(name);
    delete older.briefing.lines;
    const { container: before } = await mount(older);
    expect(before.querySelector(gone)).toBeNull();
    expect(before.querySelector(".today-frame")).not.toBeNull();
  },
);

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
    expect(today?.textContent).not.toMatch(/Before next sync|\bOwned\b|\bNew\b|\d+ more\b/);
    const members = new Set(
      body.briefing.lines?.flatMap(({ members }) => members.map(({ id }) => id)),
    );
    for (const item of [...body.briefing.focus, ...body.briefing.rest])
      expect(today?.querySelectorAll(`[data-item-id="${item.id}"]`)).toHaveLength(
        members.has(item.id) ? 1 : 0,
      );
  },
);
