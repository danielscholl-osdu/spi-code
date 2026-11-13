// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import consoleHtml from "../../../../../fixtures/rib-59d6895/oracle/console.html?raw";
import placement from "../../../../../fixtures/rib-59d6895/oracle/environment-place.json?raw";
import envInspect from "../../../../../fixtures/rib-59d6895/oracle/inspect/ENV.json?raw";
import releases from "../../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import {
  expectEvidenceMarks,
  expectNoEvidenceMarks,
} from "../../components/evidence/marks.test-helper.js";
import { RightPanel } from "../../panels/RightPanel.js";
import { createSelectionStore } from "../../panels/selection.js";
import { routeSelectionIds, selectionRows } from "../../panels/selection-rows.js";
import { inspectFromOracle, type OracleBoard } from "../../panels/test-inspect.js";
import { mixedSnapshot, testSnapshot } from "../../store/test-snapshot.js";
import { createWatchStore } from "../../store/watch.js";
import { watchFixtureText } from "../../test-utils/watch-fixtures.test-helper.js";
import { timedText } from "../../time.js";
import { lineStop } from "../today/LineStop.js";
import Environment from "./index.js";
import { eventWhen, hourTicks, place } from "./timeline.js";

const mixed = watchFixtureText("snapshot-mixed-59d6895.json", readFixture);

const snapshot = testSnapshot(briefing, releases);
const environmentStyles = readFileSync(
  resolve("apps/window/src/views/environment/environment.css"),
  "utf8",
);
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

it("uses the track clock for event duration", () => {
  expect(eventWhen({ ...first, start: new Date(0).toISOString() }, new Date(3_600_000))).toContain(
    "to now \u00b7 1\u00a0h",
  );
});

it.each([
  [2 * 24, "2\u00a0d"],
  [9 * 24 + 16, "9\u00a0d 16\u00a0h"],
])("keeps day and hour units bound in a %i-hour timeline event", (hours, expected) => {
  const end = new Date(hours * 3_600_000);
  expect(
    eventWhen({ ...first, start: new Date(0).toISOString(), end: end.toISOString() }, end),
  ).toContain(` \u00b7 ${expected}`);
});

it("ticks at local hours strictly inside the window", () => {
  const start = new Date(2026, 9, 21, 10, 30).getTime();
  const end = new Date(2026, 9, 21, 13).getTime();
  expect(hourTicks(start, end).map(({ text }) => text)).toEqual(["11:00", "12:00"]);
  expect(hourTicks(new Date(2026, 9, 21, 11).getTime(), end).map(({ text }) => text)).toEqual([
    "12:00",
  ]);
});

it("uses the rib's unknown timestamp marker for malformed dates", () => {
  const now = new Date(to);
  expect(eventWhen({ ...first, start: "invalid", end: undefined }, now)).toBe("? to now");
  expect(eventWhen({ ...first, start: "invalid", end: "invalid" }, now)).toBe("? to ?");
  expect(eventWhen({ ...first, end: "invalid" }, now)).toMatch(/ to \?$/);
});

it("keeps timeline affordances, and the empty lane's words clear of the sticky lane label", async () => {
  const store = createWatchStore(vi.fn());
  store.setState({
    snapshot: {
      cursor: 1,
      body: {
        ...snapshot,
        briefing: {
          ...snapshot.briefing,
          environment: {
            ...environment,
            lanes: [
              { id: "upgrade", label: "Upgrade", events: [first] },
              { id: "refresh", label: "Refresh", events: [] },
            ],
          },
        },
      },
    },
  });
  const container = document.createElement("div");
  container.style.color = "rgb(10, 20, 30)";
  container.style.setProperty("--error-text", "rgb(100, 0, 0)");
  container.style.setProperty("--warning-text", "rgb(100, 80, 0)");
  container.style.setProperty("--success-text", "rgb(0, 100, 0)");
  document.body.append(container);
  const root = createRoot(container);
  const style = document.createElement("style");
  style.textContent = environmentStyles;
  document.head.append(style);
  try {
    await act(async () => root.render(<Environment store={store} />));
    const bar = container.querySelector(".env-event");
    const empty = container.querySelector(".env-none");
    if (!bar || !empty) throw new Error("Missing environment elements");
    expect(container.querySelector(".env-detail, [aria-label='Event details']")).toBeNull();
    expect(container.querySelector(".env-inspect")).toBeNull();
    expect(getComputedStyle(bar).cursor).toBe("pointer");
    const label = container.querySelector(".env-lane-label");
    const row = container.querySelector(".env-row:not(.env-axis)");
    if (!label || !row) throw new Error("Missing lane row");
    const column = Number.parseFloat(getComputedStyle(row).gridTemplateColumns);
    expect(getComputedStyle(label).position).toBe("sticky");
    expect(getComputedStyle(label).left).toBe("0px");
    expect(getComputedStyle(empty).position).toBe("sticky");
    expect(Number.parseFloat(getComputedStyle(empty).left)).toBeGreaterThan(column);
  } finally {
    await act(async () => root.unmount());
    style.remove();
    container.remove();
  }
});

it("renders oracle lane order, labels, facts and bars; selects only in the right panel", async () => {
  const inspector = createSelectionStore({ postMessage: vi.fn() });
  const store = createWatchStore(vi.fn(), inspector);
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
    await act(async () => root.render(<Environment store={store} inspector={inspector} />));
    expect(container.querySelector(".place h1")?.textContent).toBe("Environment");
    expect(container.querySelector(".place-reading")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    await act(async () => receive(snapshot));
    expect(container.querySelector(".env-lead")?.textContent).toBe(environment.headline);
    const labels = [...consoleHtml.matchAll(/<div class="tl-lab">([^<]+)<\/div>/g)].map(
      (match) => match[1],
    );
    expect([...container.querySelectorAll(".env-lane-label")].map((el) => el.textContent)).toEqual(
      labels,
    );
    expect(
      [...container.querySelectorAll("[data-lane]")].map((el) => el.getAttribute("data-lane")),
    ).toEqual(JSON.parse(placement).lanes.map((lane: { id: string }) => lane.id));
    expect(container.querySelector(".place-tile dt")?.textContent).toBe("Maintenance");
    for (const fact of environment.facts.slice(1)) {
      expect(container.textContent).toContain(fact.label);
      expect(container.textContent).toContain(fact.figure);
      expect(container.textContent).toContain(timedText(fact.sub, { hint: false }));
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
    expect(bars[1]?.getAttribute("aria-selected")).toBe("true");
    expect(inspector.getState().row?.prefixes).toEqual(["/briefing/environment/lanes/3/events/0"]);
    expect(container.querySelector(".env-detail")).toBeNull();
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
    expect(container.querySelector("[data-event]")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".env-detail")).toBeNull();
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

it.each([
  ["mixed", mixedSnapshot(mixed)],
  ["plain", snapshot],
] as const)(
  "gives the %s fixture's environment sections one evidence line each, never per value",
  async (name, body) => {
    const store = createWatchStore(vi.fn());
    store.setState({ snapshot: { cursor: 1, body } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Environment store={store} />));
      if (name === "plain") {
        expectNoEvidenceMarks(container);
        return;
      }
      expectEvidenceMarks(container, body, {
        sections: [
          ["/briefing/environment/headline"],
          ["/briefing/environment/facts"],
          ["/briefing/environment/lanes"],
          ["/briefing/environment/note"],
          [
            `/briefing/repositories/rows/${body.briefing.repositories.rows.findIndex((row) => row.name === "osdu-spi-stack")}`,
          ],
        ],
      });
      expect(container.querySelector("[data-pointer] [data-inferred]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it("hands the inspector an id for every event: its queue item, else its run or hold", async () => {
  const inspector = createSelectionStore({ postMessage: vi.fn() });
  const store = createWatchStore(vi.fn(), inspector);
  const smoke = { ...first, id: "38190000001", label: "smoke", inspect: undefined };
  const hold = {
    ...first,
    id: "1791700000000",
    state: "held" as const,
    label: "2h",
    inspect: undefined,
  };
  const { inspect: _, ...bare } = smoke;
  const { inspect: __, ...closed } = hold;
  store.getState().receive({
    version: PROTOCOL_VERSION,
    id: "snapshot",
    kind: "event",
    type: "view.snapshot",
    payload: {
      ...snapshot,
      briefing: {
        ...snapshot.briefing,
        environment: {
          ...environment,
          lanes: [
            { id: "upgrade", label: "Upgrade", events: [first] },
            { id: "smoke", label: "Smoke", events: [bare] },
            { id: "holds", label: "Held", events: [closed] },
          ],
        },
      },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const pick = async (key: string) => {
    const bar = container.querySelector<HTMLButtonElement>(`[data-event="${key}"]`);
    expect(bar).not.toBeNull();
    await act(async () => bar?.click());
    return store.getState().selection?.id;
  };
  try {
    await act(async () => root.render(<Environment store={store} inspector={inspector} />));
    expect(await pick(`smoke:${bare.id}`)).toBe(`run:${bare.id}`);
    const smokeRow = container.querySelector<HTMLButtonElement>(`[data-event="smoke:${bare.id}"]`);
    if (!smokeRow) throw new Error("Missing smoke event");
    smokeRow.focus();
    await act(async () =>
      smokeRow.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      ),
    );
    expect(inspector.getState().selected).toBe(`hold:${closed.id}`);
    expect((document.activeElement as HTMLElement).dataset.event).toBe(`holds:${closed.id}`);
    expect(await pick(`holds:${closed.id}`)).toBe(`hold:${closed.id}`);
    expect(await pick(`upgrade:${first.id}`)).toBe(first.inspect);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("arrows between recorded upgrade and hold positions sharing one projected inspect id", async () => {
  const body = mixedSnapshot(mixed);
  const postMessage = vi.fn();
  const inspector = createSelectionStore({ postMessage });
  const store = createWatchStore(vi.fn(), inspector);
  store.setState({ snapshot: { cursor: body.cursor, body } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <>
          <Environment store={store} inspector={inspector} />
          <RightPanel store={inspector} snapshot={body} />
        </>,
      ),
    );
    const upgrade = container.querySelector<HTMLButtonElement>(
      '[data-lane="upgrade"] [data-event]',
    );
    const hold = container.querySelector<HTMLButtonElement>('[data-lane="holds"] [data-event]');
    if (!upgrade || !hold) throw new Error("Recorded fixture needs upgrade and hold events");
    expect(upgrade.dataset.selectionId).toBe("stack:38181620856");
    expect(hold.dataset.selectionId).toBe(upgrade.dataset.selectionId);
    const press = async (bar: HTMLButtonElement, key: string) =>
      act(async () => bar.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    const expectActive = (active: HTMLButtonElement, inactive: HTMLButtonElement) => {
      expect(document.activeElement).toBe(active);
      expect(active.getAttribute("aria-selected")).toBe("true");
      expect(inactive.getAttribute("aria-selected")).toBe("false");
      expect(container.querySelectorAll('[data-event][tabindex="0"]')).toHaveLength(1);
      expect(active.tabIndex).toBe(0);
      expect(inactive.tabIndex).toBe(-1);
      expect(inspector.getState().selected).toBe("stack:38181620856");
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "inspect.request",
          payload: { id: "stack:38181620856" },
        }),
      );
      expect(container.querySelector(".detail-title")?.textContent).toBe(
        inspector.getState().row?.title,
      );
    };
    expect(container.querySelectorAll('[data-event][tabindex="0"]')).toHaveLength(1);
    upgrade.focus();
    await act(async () => upgrade.click());
    await press(upgrade, "ArrowDown");
    expectActive(hold, upgrade);
    expect(inspector.getState().row?.prefixes).toEqual(["/briefing/environment/lanes/3/events/0"]);
    await press(hold, "ArrowUp");
    expectActive(upgrade, hold);
    expect(inspector.getState().row?.prefixes).toEqual(["/briefing/environment/lanes/0/events/0"]);
    hold.focus();
    await act(async () => hold.click());
    expectActive(hold, upgrade);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each(["identified", "unidentified"])(
  "keys repeated %s repository lines by position",
  async (identity) => {
    const body = mixedSnapshot(mixed);
    const section = body.briefing.repositories.rows.find((row) => row.name === "osdu-spi-stack")
      ?.sections[0];
    const line = section?.lines[0];
    if (!section || !line?.id) throw new Error("Missing recorded stack repository line");
    if (identity === "unidentified") {
      delete line.id;
      delete line.url;
    }
    section.lines = [line, { ...line }];
    const store = createWatchStore(vi.fn());
    store.setState({ snapshot: { cursor: body.cursor, body } });
    const errors = vi.spyOn(console, "error");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Environment store={store} />));
      expect(
        [...container.querySelectorAll(".env-repo-line")].filter((element) =>
          element.textContent?.includes(line.text),
        ),
      ).toHaveLength(2);
      expect(
        errors.mock.calls.filter((args) => args.some((arg) => String(arg).includes("same key"))),
      ).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      errors.mockRestore();
      container.remove();
    }
  },
);

it("orders the place, stack runs and stack repository; the right panel owns detail", async () => {
  const body = mixedSnapshot(mixed);
  const postMessage = vi.fn();
  const inspector = createSelectionStore({ postMessage });
  const store = createWatchStore(vi.fn(), inspector);
  store.setState({ snapshot: { cursor: body.cursor, body } });
  const repo = body.briefing.repositories.rows.find((row) => row.name === "osdu-spi-stack");
  const line = repo?.sections.flatMap((section) => section.lines).find((line) => line.id);
  if (!repo || !line?.id) throw new Error("Recorded stack lines need identity");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <>
          <Environment store={store} inspector={inspector} />
          <RightPanel store={inspector} snapshot={body} />
        </>,
      ),
    );
    const page = container.querySelector(".environment");
    if (!page) throw new Error("Missing Environment page");
    expect(
      [...page.children].map(
        (child) => child.getAttribute("data-part") ?? child.getAttribute("aria-label"),
      ),
    ).toEqual(["Environment", "runs", "repository"]);
    expect(page.textContent).not.toContain("not available yet");
    expect(page.textContent).not.toMatch(/\bM[0-9]\b/);
    for (const section of repo.sections) {
      expect(page.textContent).toContain(section.title);
      expect(page.textContent).toContain(section.count);
      if (section.rest) expect(page.textContent).toContain(section.rest);
      for (const entry of section.lines) {
        expect(page.textContent).toContain(entry.tag);
        expect(page.textContent).toContain(entry.text);
        expect(page.textContent).toContain(entry.sub);
      }
    }
    expect(page.textContent).toContain(repo.title);
    expect(page.textContent).toContain(repo.sub);
    expect(page.querySelector(".env-detail, .inspector, aside")).toBeNull();
    expect(container.querySelectorAll("aside[aria-label='Detail']")).toHaveLength(1);
    expect(inspector.getState().selected).toBeNull();

    const event = page.querySelector<HTMLButtonElement>("[data-event]");
    if (!event) throw new Error("Missing recorded event");
    await act(async () => event.click());
    const eventRow = selectionRows(body).find(
      (row) => row.kind === "environment" && row.id === inspector.getState().selected,
    );
    if (!eventRow) throw new Error("Event selection did not reach the shared store");
    expect(inspector.getState().row).toEqual(eventRow);
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "inspect.request",
        payload: { id: eventRow.id },
      }),
    );
    expect(container.querySelector(".detail-title")?.textContent).toBe(eventRow.title);
    const board: OracleBoard = JSON.parse(envInspect);
    const result = inspectFromOracle(board, eventRow.id);
    await act(async () =>
      inspector.getState().receive({
        version: PROTOCOL_VERSION,
        kind: "response",
        type: "inspect.result",
        id: inspector.getState().request,
        payload: result,
      }),
    );
    expect(container.querySelector("aside [data-field='effect']")?.textContent).toBe(result.effect);

    const option = [...page.querySelectorAll<HTMLButtonElement>("[data-selection-id]")].find(
      (element) => element.dataset.selectionId === line.id,
    );
    if (!option) throw new Error("Missing selectable recorded repository line");
    await act(async () => option.click());
    expect(inspector.getState().selected).toBe(line.id);
    expect(inspector.getState().row?.kind).toBe("repository-line");
    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(event.getAttribute("aria-selected")).toBe("false");
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "inspect.request",
        payload: { id: line.id },
      }),
    );
    expect(container.querySelector(".detail-title")?.textContent).toBe(line.text);
    await act(async () =>
      inspector.getState().receive({
        version: PROTOCOL_VERSION,
        kind: "response",
        type: "inspect.result",
        id: inspector.getState().request,
        payload: { ...result, id: line.id, cause: line.text },
      }),
    );
    expect(container.querySelector("aside [data-field='cause']")?.textContent).toBe(line.text);
    expect(routeSelectionIds(body, { kind: "environment" })).toContain(line.id);
    expect(selectionRows(body).find((row) => row.id === line.id)).toMatchObject({
      title: line.text,
      kind: "repository-line",
    });
    const next = repo.sections.flatMap((section) => section.lines).filter((entry) => entry.id)[1];
    if (!next?.id) throw new Error("Recorded stack needs two selectable lines");
    option.focus();
    await act(async () =>
      option.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    expect(inspector.getState().selected).toBe(next.id);
    expect((document.activeElement as HTMLElement).dataset.selectionId).toBe(next.id);
    expect(container.querySelector(".detail-title")?.textContent).toBe(next.text);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("omits absent snapshot parts and leaves unidentifiable lines as text, not fake selections", async () => {
  const body = mixedSnapshot(mixed);
  const inspector = createSelectionStore({ postMessage: vi.fn() });
  const store = createWatchStore(vi.fn(), inspector);
  const repo = body.briefing.repositories.rows.find((row) => row.name === "osdu-spi-stack");
  const line = repo?.sections[0]?.lines[0];
  if (!repo || !line) throw new Error("Missing recorded stack line");
  delete line.id;
  delete line.url;
  repo.note = "Recorded repository note";
  store.setState({ snapshot: { cursor: 1, body } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Environment store={store} inspector={inspector} />));
    const textLine = [...container.querySelectorAll(".env-repo-line")].find((element) =>
      element.textContent?.includes(line.text),
    );
    expect(textLine).toBeDefined();
    expect(textLine?.hasAttribute("data-selection-id")).toBe(false);
    expect(textLine?.tagName).not.toBe("BUTTON");
    expect(container.textContent).toContain(repo.note);
    const bare = structuredClone(body);
    bare.briefing.environment.facts = [];
    bare.briefing.environment.lanes = [];
    delete bare.briefing.environment.note;
    bare.briefing.repositories.rows = bare.briefing.repositories.rows.filter(
      (row) => row.name !== "osdu-spi-stack",
    );
    await act(async () => store.setState({ snapshot: { cursor: 2, body: bare } }));
    expect(container.querySelector(".env-part-body > .env-facts")).toBeNull();
    expect(container.querySelector("[aria-label='Events in the last 24 hours']")).toBeNull();
    expect(container.querySelector("[data-part='repository']")).toBeNull();
    expect(container.querySelector(".env-note")).toBeNull();
    expect(container.textContent).not.toContain(repo.note);
    expect(container.querySelector("[data-part='runs'] .env-lead")?.textContent).toBe(
      bare.briefing.environment.headline,
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

async function renderRecorded(body = mixedSnapshot(recorded)) {
  const postMessage = vi.fn();
  const inspector = createSelectionStore({ postMessage });
  const store = createWatchStore(vi.fn(), inspector);
  store.setState({ snapshot: { cursor: body.cursor, body } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <Environment store={store} inspector={inspector} />
        <RightPanel store={inspector} snapshot={body} />
      </>,
    ),
  );
  const page = container.querySelector<HTMLElement>(".environment");
  if (!page) throw new Error("Missing Environment place");
  return {
    body,
    container,
    page,
    inspector,
    postMessage,
    done: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Each tile as label, value, counts and tone. */
const tilesOf = (page: HTMLElement) =>
  [...page.querySelectorAll(".place-tiles > .place-tile")].map((tile) => [
    tile.querySelector("dt")?.textContent,
    tile.querySelector(".place-tile-value")?.textContent,
    tile.querySelector(".place-tile-counts")?.textContent,
    tile.getAttribute("data-tone") ?? undefined,
  ]);

const quietOf = (page: HTMLElement) =>
  [...page.querySelectorAll(".env-quiet > div")].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector("dd")?.textContent,
  ]);

const OPEN_HOLD = {
  id: "1794000000000",
  start: "2026-11-05T21:00:00.000Z",
  state: "held" as const,
  label: "13 h 20 min",
  detail: "in maintenance for 13 h 20 min so far",
};

const HOLDS = [
  "held, nothing running",
  "held, a run in flight",
  "held, Environment fact unread",
  "held, no Environment fact",
  "not held",
] as const;

/** The recorded morning, with an open hold and the top row's Environment fact as each case reads. */
function environmentAs(change: (typeof HOLDS)[number]) {
  const body = mixedSnapshot(recorded);
  const fact = body.briefing.facts.find(({ label }) => label === "Environment");
  const holds = body.briefing.environment.lanes.find(({ id }) => id === "holds");
  if (!fact || !holds)
    throw new Error("Recorded snapshot needs the Environment fact and Held lane");
  if (change !== "not held") holds.events.push(OPEN_HOLD);
  if (change === "held, nothing running")
    Object.assign(fact, { sub: "held \u00b7 maintenance is set", tone: "bad" });
  if (change === "held, a run in flight")
    Object.assign(fact, { sub: "upgrade running \u00b7 at verify", tone: "warn" });
  if (change === "held, Environment fact unread")
    Object.assign(fact, { figure: "?", sub: "held \u00b7 maintenance is set", tone: "bad" });
  if (change === "held, no Environment fact")
    body.briefing.facts = body.briefing.facts.filter((other) => other !== fact);
  return body;
}

it.each(
  HOLDS.map((change) => [
    change,
    change === "held, nothing running"
      ? "bad"
      : change === "held, a run in flight"
        ? "warn"
        : "neutral",
  ]),
)("leads with the environment's own state: %s", async (change, tone) => {
  const body = environmentAs(change);
  const [running, ...rest] = body.briefing.environment.facts;
  if (!running) throw new Error("Recorded snapshot needs the Running fact");
  const view = await renderRecorded(body);
  try {
    const tiles = tilesOf(view.page);
    expect(tiles[0]).toEqual(
      change === "not held"
        ? ["Running", running.figure, timedText(running.sub, { hint: false }), running.tone]
        : [
            "Maintenance",
            OPEN_HOLD.label,
            timedText(`since ${OPEN_HOLD.start}`, { hint: false }),
            tone,
          ],
    );
    expect(tiles.slice(1)).toEqual(
      rest.map((fact) => [
        fact.label,
        fact.figure,
        timedText(fact.sub, { hint: false }),
        fact.tone,
      ]),
    );
    expect(quietOf(view.page).map(([label]) => label)).toEqual([
      "Version",
      "Fork deploys",
      "Stack repository",
    ]);
  } finally {
    await view.done();
  }
});

it.each([
  "no environment facts",
  "no Held lane",
  "an unread Held lane with an open hold",
  "an unread Held lane with none open",
])("draws the reading's own tiles and no Maintenance tile with %s", async (change) => {
  const body = environmentAs(
    change === "an unread Held lane with none open" ? "not held" : "held, nothing running",
  );
  const environment = body.briefing.environment;
  if (change === "no environment facts") environment.facts = [];
  else if (change === "no Held lane")
    environment.lanes = environment.lanes.filter(({ id }) => id !== "holds");
  else {
    const lifecycle = body.areas.find(({ area }) => area === "lifecycle");
    const holds = environment.lanes.findIndex(({ id }) => id === "holds");
    const feeds = body.provenance.find(
      ({ path }) => path === `/briefing/environment/lanes/${holds}`,
    );
    if (!lifecycle || !feeds?.areas.includes("lifecycle"))
      throw new Error("Recorded snapshot needs the Held lane fed by lifecycle");
    lifecycle.envelope = { source: "lifecycle", state: "unread" };
  }
  const reading = body.readings.find(({ anchor }) => anchor.kind === "environment");
  if (!reading?.content) throw new Error("Recorded snapshot needs an environment reading");
  const view = await renderRecorded(body);
  try {
    expect(tilesOf(view.page)).toEqual(
      reading.content.tiles.map((tile) => [
        tile.label,
        tile.value,
        timedText(tile.counts, { hint: false }),
        undefined,
      ]),
    );
    expect(view.page.querySelector(".env-quiet")).toBeNull();
    expect(view.page.querySelector(".place-reading")?.textContent).not.toContain("Maintenance");
  } finally {
    await view.done();
  }
});

it("stops Today's line only from a Held lane that was read, as the place leads", () => {
  const body = mixedSnapshot(mixed);
  expect(lineStop(body)?.item.id).toBe("stack:38181620856");
  const lifecycle = body.areas.find(({ area }) => area === "lifecycle");
  if (!lifecycle) throw new Error("Mixed snapshot needs a lifecycle area");
  lifecycle.envelope = { source: "lifecycle", state: "unread" };
  expect(lineStop(body)).toBeUndefined();
});

it("draws the last 24 hours open between the tiles and the items, an open hold apart from an ended one", async () => {
  const body = mixedSnapshot(mixed);
  const environment = body.briefing.environment;
  const holds = environment.lanes.find(({ id }) => id === "holds");
  const [open] = holds?.events ?? [];
  if (!holds || !open || open.end) throw new Error("Mixed snapshot needs an open hold");
  const from = Date.parse(environment.from);
  const ended = {
    id: String(from + 3_600_000),
    start: new Date(from + 3_600_000).toISOString(),
    end: new Date(from + 7_200_000).toISOString(),
    state: "held" as const,
    label: "1 h",
    detail: "in maintenance for 1 h",
  };
  holds.events.unshift(ended);
  const view = await renderRecorded(body);
  try {
    const day = view.page.querySelector(".place-reading .env-day");
    const tiles = view.page.querySelector(".place-tiles");
    const groups = view.page.querySelector(".place-groups");
    if (!day || !tiles || !groups) throw new Error("Missing the place's tiles, timeline or items");
    expect(day.closest("details")).toBeNull();
    expect(day.querySelector("h3")?.textContent).toBe("Last 24 hours");
    expect(tiles.compareDocumentPosition(day)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(day.compareDocumentPosition(groups)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const holds = [...day.querySelectorAll<HTMLElement>('[data-lane="holds"] [data-event]')];
    expect(holds.map((bar) => [bar.dataset.event, bar.classList.contains("open")])).toEqual([
      [`holds:${open.id}`, true],
      [`holds:${ended.id}`, false],
    ]);
    for (const bar of day.querySelectorAll<HTMLElement>("[data-event]")) {
      const [lane, id] = bar.dataset.event?.split(":") ?? [];
      const event = environment.lanes
        .find((other) => other.id === lane)
        ?.events.find((e) => e.id === id);
      expect(bar.classList.contains("open"), bar.dataset.event).toBe(event?.end === undefined);
    }
  } finally {
    await view.done();
  }
});

it.each([
  ["1106", recorded],
  ["mixed", mixed],
] as const)(
  "reads no Lane label and no Stopped about fork deploys on the %s place",
  async (_, raw) => {
    const view = await renderRecorded(mixedSnapshot(raw));
    const reading = view.body.readings.find(({ anchor }) => anchor.kind === "environment");
    const deploys = reading?.content?.tiles.find(({ label }) => label === "Fork deploys");
    if (!deploys) throw new Error("Recorded reading needs its Fork deploys tile");
    try {
      const place = view.page.querySelector<HTMLElement>("section.place");
      if (!place) throw new Error("Missing the Environment place");
      const labels = [
        ...[...place.querySelectorAll("dt, h2, h3, .env-lane-label")].map(
          (element) => element.textContent ?? "",
        ),
        ...[...place.querySelectorAll("[aria-label]")].map(
          (element) => element.getAttribute("aria-label") ?? "",
        ),
      ];
      expect(labels.filter((label) => /\bLanes?\b/.test(label))).toEqual([]);
      expect(place.textContent).not.toMatch(/\bStopped\b/);
      expect(quietOf(view.page).find(([label]) => label === "Fork deploys")?.[1]).toBe(
        `${deploys.value} ${deploys.counts}`,
      );
    } finally {
      await view.done();
    }
  },
);

it("draws the recorded environment reading through the place, with no placeholders", async () => {
  const view = await renderRecorded();
  const reading = view.body.readings.find(({ anchor }) => anchor.kind === "environment");
  if (!reading?.content) throw new Error("Recorded snapshot needs an environment reading");
  try {
    const place = view.page.querySelector("section.place[aria-label='Environment']");
    expect(place).not.toBeNull();
    expect(view.page.firstElementChild).toBe(place);
    expect(place?.querySelector("h1")?.textContent).toBe("Environment");
    expect(place?.querySelector(".place-headline")?.textContent).toBe(
      timedText("v0.35.3 is ready, green since 2026-11-06T04:20:36.000Z.", { hint: false }),
    );
    expect(tilesOf(view.page)).toEqual(
      view.body.briefing.environment.facts.map((fact) => [
        fact.label,
        fact.figure,
        timedText(fact.sub, { hint: false }),
        fact.tone,
      ]),
    );
    expect(quietOf(view.page)).toEqual(
      reading.content.tiles.map((tile) => [
        tile.label,
        `${tile.value} ${timedText(tile.counts, { hint: false })}`,
      ]),
    );
    expect(reading.content.tiles.map(({ label }) => label)).toEqual([
      "Version",
      "Fork deploys",
      "Stack repository",
    ]);
    const order = [".place-tiles", ".env-day", ".place-groups", ".place-folded", ".env-quiet"]
      .map((selector) => place?.querySelector(selector))
      .filter((element) => element !== null && element !== undefined);
    expect(order.length).toBeGreaterThanOrEqual(4);
    order.slice(1).forEach((element, index) => {
      expect(order[index]?.compareDocumentPosition(element) ?? 0, String(element.className)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    expect(place?.querySelector(".place-folded")?.textContent).toBe(reading.content.folded);
    expect(
      view.page.querySelector("[aria-label='Threads'], [aria-label='Live cluster']"),
    ).toBeNull();
    expect(view.page.textContent).not.toMatch(/not available yet|Waiting for the first sweep/);
    expect(view.page.textContent).not.toMatch(/\bThreads\b|Live cluster/);
  } finally {
    await view.done();
  }
});

it.each([
  ["1106", recorded],
  ["mixed", mixed],
] as const)(
  "keeps %s Stack runs to the flow context, the run headline and the note",
  async (_, raw) => {
    const view = await renderRecorded(mixedSnapshot(raw));
    try {
      const runs = view.page.querySelector<HTMLDetailsElement>('[data-part="runs"]');
      if (!runs) throw new Error("Missing Stack runs disclosure");
      expect(runs.open).toBe(false);
      expect(runs.querySelector(".env-lead")?.textContent).toBe(
        timedText(view.body.briefing.environment.headline, { hint: false }),
      );
      expect(runs.querySelector(".env-note")?.textContent).toBe(
        view.body.briefing.environment.note,
      );
      expect(runs.querySelector("[aria-label='Upstream syncs']")).not.toBeNull();
      expect(runs.querySelector("[data-lane], .place-tile, [data-pointer*='/facts/']")).toBeNull();
      expect(view.page.querySelectorAll(".env-day [data-lane]")).toHaveLength(
        view.body.briefing.environment.lanes.length,
      );
    } finally {
      await view.done();
    }
  },
);

it.each(["different version", "unread fact", "unread tile", "declared tile", "no reading"])(
  "draws core's Running fact as it is sent with %s",
  async (change) => {
    const body = mixedSnapshot(recorded);
    const fact = body.briefing.environment.facts[0];
    const reading = body.readings.find(({ anchor }) => anchor.kind === "environment");
    const tile = reading?.content?.tiles[0];
    if (!fact || !reading || !tile) throw new Error("Missing recorded running sources");
    if (change === "different version") fact.figure = "v0.35.2";
    if (change === "unread fact") {
      fact.figure = "?";
      fact.sub = "readiness unread";
      fact.tone = "neutral";
    }
    if (change === "unread tile") tile.value = "not read yet";
    if (change === "declared tile") tile.counts = "declared \u00b7 running version not read yet";
    if (change === "no reading") reading.content = null;
    const view = await renderRecorded(body);
    try {
      expect(tilesOf(view.page)[0]).toEqual([
        "Running",
        fact.figure,
        timedText(fact.sub, { hint: false }),
        fact.tone,
      ]);
      expect(view.page.querySelector(".place-headline")?.textContent).toBe(
        reading.content ? timedText(reading.content.headline, { hint: false }) : undefined,
      );
    } finally {
      await view.done();
    }
  },
);

it.each(["deployable \u00b7 green at 03:20", "deployability unread"])(
  "draws core's words without rewriting them: %s",
  async (sub) => {
    const body = mixedSnapshot(recorded);
    const fact = body.briefing.environment.facts[0];
    if (!fact) throw new Error("Missing recorded running fact");
    fact.sub = sub;
    const view = await renderRecorded(body);
    try {
      expect(tilesOf(view.page)[0]?.[2]).toBe(sub);
      expect(view.page.textContent).not.toContain(sub.replace(/^deployab\w+/, "ready"));
    } finally {
      await view.done();
    }
  },
);

type FormerField = {
  field: string;
  find: (page: HTMLElement) => Element | undefined;
  text: string;
};

function formerFields(body: ReturnType<typeof mixedSnapshot>): FormerField[] {
  const env = body.briefing.environment;
  const now = new Date(Date.parse(env.to));
  const repo = body.briefing.repositories.rows.find(({ name }) => name === "osdu-spi-stack");
  if (!repo || !env.note) throw new Error("Recorded snapshot needs the stack row and lane note");
  const all = (page: HTMLElement, selector: string) => [...page.querySelectorAll(selector)];
  const holding = (selector: string, text: string) => (page: HTMLElement) =>
    all(page, selector).find((element) =>
      element.textContent?.includes(timedText(text, { hint: false })),
    );
  return [
    { field: "headline", find: holding(".env-lead", env.headline), text: env.headline },
    ...env.facts.flatMap((fact, index) =>
      (["label", "figure", "sub"] as const).map((part) => ({
        field: `fact ${index} ${part}`,
        find: (page: HTMLElement) =>
          page.querySelector(
            `.place-tile:nth-child(${index + 1}) ${{ label: "dt", figure: ".place-tile-value", sub: ".place-tile-counts" }[part]}`,
          ) ?? undefined,
        text: fact[part],
      })),
    ),
    ...env.lanes.flatMap((lane) => [
      {
        field: `lane ${lane.id}`,
        find: (page: HTMLElement) =>
          page.querySelector(`[data-lane='${lane.id}'] .env-lane-label`) ?? undefined,
        text: lane.label,
      },
      ...(lane.events.length === 0
        ? [
            {
              field: `lane ${lane.id} empty`,
              find: (page: HTMLElement) =>
                page.querySelector(`[data-lane='${lane.id}'] .env-none`) ?? undefined,
              text: "none in the last day",
            },
          ]
        : lane.events.map((event) => ({
            field: `lane ${lane.id} event ${event.id}`,
            find: (page: HTMLElement) =>
              all(page, `[data-lane='${lane.id}'] [data-event]`).find((element) =>
                element.getAttribute("aria-label")?.includes(eventWhen(event, now)),
              ),
            text: event.label,
          }))),
    ]),
    { field: "lane note", find: holding(".env-note", env.note), text: env.note },
    {
      field: "repository title",
      find: holding("[data-part='repository'] p", repo.title),
      text: repo.title,
    },
    { field: "repository sub", find: holding(".env-muted", repo.sub), text: repo.sub },
    ...repo.sections.flatMap((section) => [
      {
        field: `section ${section.title}`,
        find: holding(".env-repo-section h3", section.title),
        text: `${section.title} ${section.count}`,
      },
      ...section.lines.flatMap((line) =>
        [line.tag, line.text, line.sub].map((text) => ({
          field: `line ${line.id} ${text}`,
          find: (page: HTMLElement) =>
            all(page, ".env-repo-line").find(
              (element) => element.getAttribute("data-selection-id") === line.id,
            ),
          text,
        })),
      ),
    ]),
  ];
}

it("keeps every former Environment page field within one click", async () => {
  const view = await renderRecorded();
  const fields = formerFields(view.body);
  try {
    expect(fields.length).toBeGreaterThan(20);
    for (const { field, find, text } of fields) {
      const element = find(view.page);
      expect(element, field).toBeDefined();
      const shown = `${element?.textContent ?? ""} ${element?.getAttribute("aria-label") ?? ""}`;
      expect(shown, field).toContain(timedText(text, { hint: false }));
      const closed: HTMLDetailsElement[] = [];
      for (let node = element?.parentElement; node && node !== view.page; node = node.parentElement)
        if (node instanceof HTMLDetailsElement && !node.open) closed.push(node);
      expect(closed.length, field).toBeLessThanOrEqual(1);
      const [fold] = closed;
      if (!fold) continue;
      await act(async () => fold.querySelector<HTMLElement>(":scope > summary")?.click());
      expect(fold.open, field).toBe(true);
      await act(async () => fold.querySelector<HTMLElement>(":scope > summary")?.click());
    }
    const event = fields
      .find(({ field }) => field.startsWith("lane refresh event"))
      ?.find(view.page);
    if (!(event instanceof HTMLButtonElement))
      throw new Error("Recorded refresh event is a button");
    await act(async () => event.click());
    expect(view.inspector.getState().row?.kind).toBe("environment");
    expect(view.container.querySelector(".detail-title")?.textContent).toBe("v0.35.3");
  } finally {
    await view.done();
  }
});

it("selects an environment reading item into Detail and keeps it on the environment route", async () => {
  const view = await renderRecorded(mixedSnapshot(mixed));
  const reading = view.body.readings.find(({ anchor }) => anchor.kind === "environment");
  const items = reading?.content?.items ?? [];
  const [item] = items;
  if (!item) throw new Error("Mixed snapshot needs an environment reading item");
  try {
    const button = view.page.querySelector<HTMLButtonElement>(
      `.place-item[data-item-id='${item.id}'] button.place-item-content`,
    );
    expect(view.page.querySelector(`[data-selection-id='${item.id}']`)).not.toBe(button);
    if (!button) throw new Error("Missing selectable reading item");
    await act(async () => view.inspector.getState().setTab("evidence"));
    await act(async () => button.click());
    expect(view.inspector.getState().selected).toBe(item.id);
    expect(view.inspector.getState().row?.kind).toBe("queue");
    expect(view.inspector.getState().tab).toBe("detail");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(routeSelectionIds(view.body, { kind: "environment" })).toEqual(
      expect.arrayContaining(items.map(({ id }) => id)),
    );
  } finally {
    await view.done();
  }
});
