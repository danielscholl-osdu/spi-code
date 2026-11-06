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
import mixed from "../../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
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
import Environment from "./index.js";
import { eventWhen, hourTicks, place } from "./timeline.js";

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

it("uses the rib's unknown timestamp marker for malformed dates", () => {
  const now = new Date(to);
  expect(eventWhen({ ...first, start: "invalid", end: undefined }, now)).toBe("? to now");
  expect(eventWhen({ ...first, start: "invalid", end: "invalid" }, now)).toBe("? to ?");
  expect(eventWhen({ ...first, end: "invalid" }, now)).toMatch(/ to \?$/);
});

it("keeps timeline affordances without an in-page detail pane", async () => {
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
    expect(getComputedStyle(empty).position).toBe("absolute");
    expect(getComputedStyle(empty).left).toBe("6px");
    expect(getComputedStyle(empty).top).toBe("7px");
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

it("orders recorded lane events, stack lines, Threads and Live cluster; the right panel owns detail", async () => {
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
      [...page.querySelectorAll(":scope > section")].map((section) =>
        section.getAttribute("aria-label"),
      ),
    ).toEqual(["Lane events", "Repository", "Threads", "Live cluster"]);
    expect(page.querySelector("[aria-label='Threads']")?.textContent).toContain(
      "Threads are not available yet.",
    );
    expect(page.querySelector("[aria-label='Live cluster']")?.textContent).toContain(
      "Live reads are not available yet.",
    );
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
    expect(container.querySelector(".env-facts")).toBeNull();
    expect(container.querySelector("[aria-label='Lane events']")).toBeNull();
    expect(container.querySelector("[aria-label='Repository']")).toBeNull();
    expect(container.querySelector(".env-note")).toBeNull();
    expect(container.textContent).not.toContain(repo.note);
    expect(container.querySelector("[aria-label='Threads']")).not.toBeNull();
    expect(container.querySelector("[aria-label='Live cluster']")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
