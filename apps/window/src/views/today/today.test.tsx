// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type SweepProgress, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import november6 from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { midSweep, savedSweep, sweepEvent } from "../../components/sweep/test-helper.js";
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
    expect(
      [...(frame?.children ?? [])].map((child) => child.className || child.getAttribute("role")),
    ).toEqual([...(fleet ? ["fleet"] : []), "today-tabrow", "tabpanel"]);
    expect(frame?.querySelector(".fleet > .today-not-read") !== null).toBe(
      (fleet?.notRead?.length ?? 0) > 0,
    );
    const order = ["blocked", "waiting", "moving", "can-wait", "history"];
    const sections = [...(frame?.querySelectorAll<HTMLElement>(".today-section") ?? [])].map(
      ({ dataset }) => dataset.section ?? "",
    );
    expect(sections).toEqual(order.filter((id) => sections.includes(id)));
  });
});

const header = (container: Element) =>
  container.querySelector(".place-header .today-read-state")?.textContent ?? "";
const calmLine = (container: Element) =>
  container.querySelector(".today-table-calm")?.textContent ?? null;
const chip = (container: Element) => container.querySelector<HTMLButtonElement>(".today-read-gap");
const readAgain = (container: Element) =>
  container.querySelector<HTMLButtonElement>('.place-header button[aria-label="Read again"]');
const forkCount = (body: ViewSnapshot) => {
  const fleet = body.briefing.today?.fleet;
  if (!fleet) throw new Error("no fleet");
  return fleet.forks.yours.length + fleet.forks.rest.forks.length;
};
const REQUEST = {
  id: "r1",
  sweep: null,
  previousSweep: null,
  afterCursor: 0,
  joined: false,
} as const;

describe("the header and the empty line", () => {
  it.each([
    [
      "read complete",
      "busy",
      null,
      false,
      (at: string, forks: number) => [`Read ${at} · ${forks} forks`, "Nothing is yours to move."],
    ],
    [
      "reading again",
      "busy",
      midSweep({ first: false }),
      false,
      (at: string) => [`Read ${at} · reading 9 of 12`, `At ${at}, nothing was yours to move.`],
    ],
    [
      "partly read",
      "bad",
      null,
      false,
      (at: string) => [`Read ${at}`, "Nothing is yours in what was read."],
    ],
    [
      "partly read while reading",
      "bad",
      midSweep({ first: false }),
      false,
      (at: string) => [`Read ${at} · reading 9 of 12`, `At ${at}, nothing was yours to move.`],
    ],
    [
      "a re-read with no progress yet",
      "busy",
      savedSweep(),
      true,
      (at: string) => [`Read ${at} · reading`, `At ${at}, nothing was yours to move.`],
    ],
  ] as const)("%s", async (_, name, progress, requested, expected) => {
    const body = morning(name);
    body.briefing.lines = [];
    const { container, store } = await mount(body);
    await act(async () => store.setState({ progress, sweepRequest: requested ? REQUEST : null }));
    expect([header(container), calmLine(container)]).toEqual(
      expected(clock(body.sweptAt), forkCount(body)),
    );
    expect(chip(container) !== null).toBe(name === "bad");
  });

  it("leaves the fork count out with no fleet, and never says a count it cannot read", async () => {
    const body = morning("busy");
    delete body.briefing.today;
    const { container } = await mount(body);
    expect(header(container)).toBe(`Read ${clock(body.sweptAt)}`);
    expect(container.querySelector(".place-header")?.textContent).not.toMatch(/\d+ forks?\b/);
  });

  it.each(NAMES)(
    "on the %s morning the chip shows exactly when an area failed or was cut",
    async (name) => {
      const body = morning(name);
      const { container } = await mount(body);
      const gaps = body.areas.filter(({ envelope }) =>
        ["failed", "incomplete"].includes(envelope.state),
      );
      if (gaps.length === 0) {
        expect(chip(container)).toBeNull();
        expect(container.querySelector(".place-header")?.textContent).not.toMatch(
          /not read|read failed|in part|⌀/,
        );
        return;
      }
      expect(chip(container)?.textContent).toBe(`⌀ ${gaps.length} ›`);
    },
  );

  it("names each failed or partly read area in the chip's title and opens Evidence", async () => {
    const body = morning("bad");
    const radar = body.areas.find(({ area }) => area === "radar");
    const security = body.areas.find(({ area }) => area === "security");
    if (!radar || !security) throw new Error("bad carries no radar or security area");
    radar.envelope = {
      source: "radar",
      state: "incomplete",
      observedAt: body.sweptAt,
      completeness: { kind: "cut", read: 6, total: 13, reason: "budget" },
    };
    security.envelope = { source: "security", state: "unread" };
    const { container, onOpenEvidence } = await mount(body);
    const gap = chip(container);
    expect(gap?.textContent).toBe("⌀ 2 ›");
    expect(gap?.title).toBe(
      "GitHub issues and PRs read failed, Upstream radar read only in part · opens Evidence",
    );
    expect(gap?.getAttribute("aria-label")).toBe(
      "GitHub issues and PRs read failed, Upstream radar read only in part, open Evidence",
    );
    await act(async () => gap?.click());
    expect(onOpenEvidence).toHaveBeenCalledOnce();
  });
});

describe("Read again in the header", () => {
  it("sends one sweep request without now, and sends nothing more while it is pending", async () => {
    const { container, send } = await mount(morning("busy"));
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

  it("sends nothing on a press that lands before disabled commits", async () => {
    const { container, store, send } = await mount(morning("bad"));
    await act(async () => {
      store.getState().receive(sweepEvent("sweep.progress", midSweep()));
      expect(readAgain(container)?.disabled).toBe(false);
      readAgain(container)?.click();
    });
    expect(send).not.toHaveBeenCalled();
    await act(async () => store.setState({ progress: midSweep({ outcome: "committed" }) }));
    await act(async () => {
      readAgain(container)?.click();
      expect(readAgain(container)?.disabled).toBe(false);
      readAgain(container)?.click();
    });
    expect(send).toHaveBeenCalledOnce();
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
      expect(
        today?.querySelectorAll(`[data-item-id="${item.id}"], [data-member-ids~="${item.id}"]`),
      ).toHaveLength(members.has(item.id) ? 1 : 0);
  },
);
