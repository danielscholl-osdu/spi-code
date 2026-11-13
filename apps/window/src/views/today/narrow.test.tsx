// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { closeSheet, navigate, relaunch } from "../../app/navigation.js";
import { moreCases, PENDING } from "../../app/reachability.test-helper.js";
import { Shell } from "../../app/Shell.js";
import { RightPanel } from "../../panels/RightPanel.js";
import { selectionStore } from "../../panels/selection.js";
import { createWatchStore, watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import Today from "./index.js";

const loadFixture = fixtureLoader(readFixture);

const css = readFileSync(resolve("apps/window/src/views/today/today.css"), "utf8");

const cleanup: (() => Promise<void>)[] = [];
let measure: () => void;
let harness: ReturnType<typeof installSpi>;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("innerWidth", 1440);
  selectionStore.getState().clear();
  localStorage.clear();
  closeSheet();
  relaunch();
  harness = installSpi();
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  selectionStore.getState().clear();
  harness.restore();
  vi.unstubAllGlobals();
});
const resize = async (width: number) => {
  vi.stubGlobal("innerWidth", width);
  await act(async () => window.dispatchEvent(new Event("resize")));
};
function populated(ids = [0, 1, 2, 3, 4]): ViewSnapshot {
  const body = loadFixture("snapshot-busy.json");
  const seed = body.briefing.focus[0];
  if (!seed) throw new Error("Missing item");
  body.briefing.focus = Array.from({ length: 4 }, (_, at) => ({
    ...seed,
    id: `need:${at}`,
    ids: [`need:${at}`],
    attention: "interrupt",
  }));
  const lines = ids.map((at) => ({
    id: `line:${at}`,
    itemIds: [`item:${at}:a`, `item:${at}:b`],
    count: 2,
    origin: "system" as const,
    text: `Work ${at}`,
  }));
  body.briefing.ambient = {
    failing: { items: 10, text: "10 in 5", lines },
    inProgress: { items: 10, text: "10 in 5", lines },
  };
  body.briefing.decisions = {
    items: 10,
    text: "10 in 5",
    groups: lines.map((line) => ({ ...line, theme: line.id, scope: [] })),
  };
  body.briefing.horizon.cards = lines.map((line) => ({
    ...line,
    kind: "sync",
    token: line.text,
    services: [],
    needsYou: false,
  }));
  return body;
}
async function mount(body = populated(), store = createWatchStore(vi.fn(), selectionStore)) {
  store.setState({ snapshot: { cursor: body.cursor, body } });
  const container = document.createElement("div");
  container.className = "middle-frame";
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <Today store={store} />
        <RightPanel store={selectionStore} snapshot={body} />
      </>,
    ),
  );
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}
const rows = (root: Element, selector: string) => [...root.querySelectorAll(selector)];

it("keeps every populated group at 1440 with Detail open and preserves the selected offset on the column change", async () => {
  const root = await mount();
  const target = root.querySelector<HTMLElement>('.today-decision[data-decision-id="line:4"]');
  if (!target) throw new Error("Missing row");
  let top = 200;
  vi.spyOn(target, "getBoundingClientRect").mockImplementation(() => ({ top }) as DOMRect);
  await act(async () => selectionStore.getState().select("item:4:a"));
  const scroller = root.querySelector<HTMLElement>(".today");
  if (!scroller) throw new Error("Missing scroll body");
  scroller.scrollTop = 100;
  scroller.dispatchEvent(new Event("scroll"));
  top = 320;
  await act(async () => measure());
  expect(scroller.scrollTop).toBe(220);
  expect(rows(root, ".today-motion-line")).toHaveLength(5);
  expect(root.querySelector(".today-more")).toBeNull();
});

it.each([740, 850, 1440])(
  "uses the centre's container rule for populated Releases and In motion at %i",
  async (width) => {
    await resize(width);
    const root = await mount();
    const lower = root.querySelector(".today-lower");
    expect(
      rows(lower as Element, "[data-today-slot]").map((node) =>
        node.getAttribute("data-today-slot"),
      ),
    ).toEqual(["releases", "motion"]);
    expect(css).toMatch(
      /@container today\s*\(max-width: 1000px\)\s*\{\s*\.today-lower\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/,
    );
  },
);

it("at 740 keeps all four Interrupts, folds the other groups by items, and freezes rows on selection", async () => {
  const root = await mount();
  await act(async () => selectionStore.getState().select("item:4:b"));
  await resize(740);
  expect(rows(root, ".today-need")).toHaveLength(4);
  for (const selector of [
    ".today-decision",
    ".today-item-row",
    ".horizon-card",
    ".today-motion-line",
  ]) {
    const visible = rows(root, selector);
    expect(visible).toHaveLength(3);
    expect(visible[2]?.getAttribute("data-item-ids")).toContain("item:4:b");
  }
  expect(rows(root, ".today-more").map((node) => node.textContent)).toEqual(
    Array(4).fill("4 more ›"),
  );
  const before = rows(root, ".today-decision").map((node) => node.getAttribute("data-decision-id"));
  await act(async () => selectionStore.getState().select("item:3:a"));
  expect(
    rows(root, ".today-decision").map((node) => node.getAttribute("data-decision-id")),
  ).toEqual(before);
  await resize(850);
  expect(rows(root, ".today-decision")).toHaveLength(5);
  expect(root.querySelector(".today-more")).toBeNull();
});

const foldedGroups = [
  ["decisions", ".today-decision"],
  ["failing", ".today-item-row"],
  ["horizon", ".horizon-card"],
  ["motion", ".today-motion-line"],
] as const;

it.each([
  {
    name: "refills after the shown rows leave",
    initial: [0, 1, 2, 3, 4],
    next: [3, 4, 5, 6, 7],
    kept: [3, 4, 7],
    selected: 7,
  },
  {
    name: "keeps surviving shown rows ahead of new arrivals",
    initial: [0, 1, 2, 3, 4],
    next: [8, 9, 0, 1, 3],
    kept: [8, 0, 1],
    selected: null,
  },
  {
    name: "replaces the third visible row after a new leading row arrives",
    initial: [0, 1, 2, 3, 4],
    next: [8, 0, 1, 3, 4],
    kept: [8, 0, 4],
    selected: 4,
  },
  {
    name: "unfolds when shrinking to three rows",
    initial: [0, 1, 2, 3, 4],
    next: [2, 3, 4],
    kept: [2, 3, 4],
    selected: null,
  },
  {
    name: "unfolds when shrinking below three rows",
    initial: [0, 1, 2, 3, 4],
    next: [3, 4],
    kept: [3, 4],
    selected: null,
  },
  {
    name: "folds when growing past three rows",
    initial: [0, 1, 2],
    next: [0, 1, 2, 3, 4],
    kept: [0, 1, 4],
    selected: 4,
  },
])(
  "at 740 $name and selection never changes the refreshed fold",
  async ({ initial, next, kept, selected }) => {
    await resize(740);
    const store = createWatchStore(vi.fn(), selectionStore);
    const root = await mount(populated(initial), store);
    if (selected !== null) {
      await act(async () => selectionStore.getState().select(`item:${selected}:b`));
    }
    const body = populated(next);
    await act(async () => store.setState({ snapshot: { cursor: body.cursor, body } }));
    const expected = kept.map((id) => `item:${id}:a item:${id}:b`);
    for (const [group, selector] of foldedGroups) {
      expect(
        rows(root, selector).map((node) => node.getAttribute("data-item-ids")),
        group,
      ).toEqual(expected);
      expect(
        root.querySelector(`.today-more[data-group="${group}"]`)?.textContent ?? null,
        group,
      ).toBe(next.length > 3 ? "4 more ›" : null);
    }
    await act(async () => selectionStore.getState().select(`item:${next[3] ?? next[0]}:a`));
    const copy = structuredClone(body);
    await act(async () => store.setState({ snapshot: { cursor: copy.cursor, body: copy } }));
    for (const [group, selector] of foldedGroups) {
      expect(
        rows(root, selector).map((node) => node.getAttribute("data-item-ids")),
        group,
      ).toEqual(expected);
    }
  },
);

it("each n-more opener shows the group's full list in Detail without a host request", async () => {
  await resize(740);
  const body = populated();
  const root = await mount(body);
  const openers = rows(root, ".today-more");
  expect(openers).toHaveLength(4);
  for (const opener of openers) {
    await act(async () => (opener as HTMLButtonElement).click());
    expect(selectionStore.getState().row?.kind).toBe("today-more");
    expect(selectionStore.getState().request).toBeNull();
    expect(rows(root, ".detail-group-list > li")).toHaveLength(5);
    expect(root.querySelector(".detail-group-list")?.textContent).toContain("Work 4");
    expect(rows(root, ".today-motion-line")).toHaveLength(3);
  }
  for (const entry of moreCases(body)) {
    const step = entry.home.step;
    const selector = entry.selector;
    if (typeof step !== "string" || typeof selector !== "string")
      throw new Error("Expected selectors");
    await act(async () => root.querySelector<HTMLButtonElement>(step)?.click());
    expect(root.querySelector(selector)?.textContent).toBe(entry.value);
  }
});

it("has no pending Today reachability exemption", () => {
  expect(moreCases(populated())).toHaveLength(20);
  expect(PENDING).toEqual({});
  expect(JSON.stringify(PENDING)).not.toContain("spicode-f0s");
});

it("at 740 opens the full list as a Detail sheet over an unchanged Today", async () => {
  await resize(740);
  const body = populated();
  const previous = watchStore.getState();
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
    watchStore.setState(previous, true);
  });
  await act(async () => {
    navigate({ kind: "today" });
    root.render(<Shell />);
  });
  const today = container.querySelector(".today-frame");
  const before = today?.innerHTML;
  await act(async () =>
    container.querySelector<HTMLButtonElement>('.today-more[data-group="motion"]')?.click(),
  );
  expect(container.querySelector('.right-panel-frame[data-sheet="true"]')).not.toBeNull();
  expect(today?.innerHTML).toBe(before);
});

it("keeps quiet horizon cards reachable when core gives them no WatchItem ids", async () => {
  await resize(740);
  const body = populated();
  for (const card of body.briefing.horizon.cards ?? []) card.itemIds = [];
  const root = await mount(body);
  const opener = root.querySelector<HTMLButtonElement>('.today-more[data-group="horizon"]');
  expect(opener?.textContent).toBe("More ›");
  await act(async () => opener?.click());
  expect(rows(root, ".detail-group-list > li")).toHaveLength(5);
});
