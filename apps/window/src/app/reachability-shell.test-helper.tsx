// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import type { Read } from "../test-utils/watch-fixtures.test-helper.js";
import { moving } from "../views/today/in-motion.test-helper.js";
import { closeSheet, navigate, relaunch, routeHash } from "./navigation.js";
import { placeReachCases } from "./place-reachability.test-helper.js";
import {
  AT_PLACE,
  bandCases,
  briefingItems,
  coverage,
  detailFeed,
  EXEMPTIONS,
  type Home,
  horizonCases,
  motionCases,
  openerCases,
  type Reach,
  reachCases,
  type Selector,
} from "./reachability.test-helper.js";
import { Shell } from "./Shell.js";

let recordedSnapshot: ViewSnapshot;
export let calmSnapshot: ViewSnapshot;
export let busySnapshot: ViewSnapshot;
export let badSnapshot: ViewSnapshot;
export const fixture = () => structuredClone(recordedSnapshot);
export let cases: Reach[];
export let drawn: Reach[];
let homes: Home[];
export const pairs = new Map<string, { first: Reach; row: Reach; group: Reach[] }[]>();

/** The recorded mornings and their cases, read through the calling test file's reader. */
function load(read: Read) {
  const watch = (name: string) => read(`fixtures/watch/${name}`);
  const recorded = watch("snapshot-1106.json");
  const feed = watch("inspect-1106.json");
  const calmRaw = watch("snapshot-calm.json");
  const busyRaw = watch("snapshot-busy.json");
  const badRaw = watch("snapshot-bad.json");
  recordedSnapshot = ViewSnapshotSchema.parse(JSON.parse(recorded));
  calmSnapshot = ViewSnapshotSchema.parse(JSON.parse(calmRaw));
  busySnapshot = ViewSnapshotSchema.parse(JSON.parse(busyRaw));
  badSnapshot = ViewSnapshotSchema.parse(JSON.parse(badRaw));
  cases = reachCases(fixture(), detailFeed(feed));
  drawn = cases.filter(({ exempt }) => !exempt);
  homes = [...new Map(drawn.map(({ home }) => [home.name, home])).values()];
  const groups = new Map<string, Reach[]>();
  for (const row of drawn) groups.set(row.pointer, [...(groups.get(row.pointer) ?? []), row]);
  const shared = [...groups.values()].filter((group) => group.length > 1);
  for (const group of shared) {
    const [first, ...rest] = group;
    if (!first) continue;
    for (const row of rest) {
      const name = `${first.home.name} and ${row.home.name}`;
      pairs.set(name, [...(pairs.get(name) ?? []), { first, row, group }]);
    }
  }
}

const previous = watchStore.getState();
const previousSpi = window.spi;
export let container: HTMLDivElement;
let root: Root;

export function shellHooks(read: Read) {
  load(read);
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    closeSheet();
    relaunch();
    localStorage.clear();
    window.location.hash = "#today";
    window.spi = {
      proof: false,
      postMessage: vi.fn(),
      openExternal: vi.fn(),
      onMessage: () => () => {},
    };
    selectionStore.getState().clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    selectionStore.getState().clear();
    watchStore.setState(previous, true);
    window.spi = previousSpi;
    closeSheet();
    relaunch();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
}

const find = (selector: Selector) =>
  (typeof selector === "string" ? container.querySelector(selector) : selector(container)) ?? null;

/** Fails unless a person could see the element: no closed details, hidden or undisplayed ancestor. */
function visible(element: Element | null, where: string) {
  expect(element, where).not.toBeNull();
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    if (
      ancestor instanceof HTMLDetailsElement &&
      !ancestor.querySelector(":scope > summary")?.contains(element)
    )
      expect(ancestor.open, where).toBe(true);
    expect(ancestor.hasAttribute("hidden"), where).toBe(false);
    expect(getComputedStyle(ancestor).display, where).not.toBe("none");
    expect(getComputedStyle(ancestor).visibility, where).not.toBe("hidden");
  }
  return element as Element;
}

export async function start(home: Home, body = fixture()) {
  await act(async () => root.render(null));
  selectionStore.getState().clear();
  await act(async () => {
    watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
    navigate(home.start.route);
    root.render(<Shell />);
  });
}

/** One click on a target a person can see; an open disclosure's summary needs none. */
export async function click(selector: Selector, where: string) {
  const target = visible(find(selector), `${where}: click ${String(selector)}`);
  if (target.tagName === "SUMMARY" && target.closest("details")?.open) return 0;
  await act(async () => (target as HTMLElement).click());
  if (target.tagName === "SUMMARY") expect(target.closest("details")?.open, where).toBe(true);
  return 1;
}

export async function answerDetail(home: Home) {
  if (!home.detail) return;
  const { request, row, selected } = selectionStore.getState();
  expect(row?.inspectId ?? selected, home.name).toBe(home.detail.id);
  await act(async () =>
    selectionStore.getState().receive({
      version: PROTOCOL_VERSION,
      id: request,
      kind: "response",
      type: "inspect.result",
      payload: home.detail,
    }),
  );
}

/** The home's start, then at most its one click, then the host's Detail answer if it has one. */
export async function openHome(home: Home, body = fixture()) {
  await start(home, body);
  const clicks = home.step ? await click(home.step, home.name) : 0;
  expect(clicks, home.name).toBeLessThanOrEqual(1);
  await answerDetail(home);
}

const shown = (row: Reach) => visible(find(row.selector), `${row.pointer} at ${row.home.name}`);

const raw = (row: Reach, element: Element) =>
  row.read?.(element) ??
  (row.attribute ? element.getAttribute(row.attribute) : element.textContent) ??
  "";

export function assertReach(row: Reach) {
  const value = raw(row, shown(row));
  const where = `${row.pointer} at ${row.home.name}`;
  if (row.contains) expect(value, where).toContain(row.value);
  else expect(value, where).toBe(row.blank ? "" : row.value);
}

export const ITEM_HOME = /^\/briefing\/(focus|rest)\/\d+\/(scope|origin)$/;
export const itemHomeCases = (body: ViewSnapshot) =>
  [
    ...bandCases(body),
    ...motionCases(body),
    ...horizonCases(body),
    ...placeReachCases(body),
  ].filter(({ pointer }) => ITEM_HOME.test(pointer));

/** Each Today home that holds an item (ruling R1), as [item id, the home's container]. */
function itemHomes({ briefing }: ViewSnapshot): [string, string][] {
  const q = JSON.stringify;
  const held = (itemIds: readonly string[], container: string) =>
    itemIds.map((id) => [id, container] as [string, string]);
  return [
    ...briefingItems(briefing)
      .filter(([, item]) => item.attention === "interrupt")
      .map(
        ([, { id }]) =>
          [id, `.today-band li.today-need[data-item-id=${q(id)}]`] as [string, string],
      ),
    ...(briefing.decisions?.groups ?? []).flatMap(({ id, itemIds }) =>
      held(itemIds, `.today-band li.today-decision[data-decision-id=${q(id)}]`),
    ),
    ...(briefing.ambient?.failing?.lines ?? []).flatMap(({ id, itemIds }) =>
      held(itemIds, `.today-band li.today-item-row[data-line-id=${q(id)}]`),
    ),
    ...(briefing.ambient?.inProgress?.lines ?? []).flatMap(({ id, itemIds }) =>
      held(itemIds, `.today-motion-line[data-line-id=${q(id)}]`),
    ),
    ...(briefing.horizon.cards ?? []).flatMap(({ id, itemIds }) =>
      held(itemIds, `.today-horizon .horizon-card[data-card-id=${q(id)}]`),
    ),
    ...held(briefing.horizon.owed?.itemIds ?? [], ".today-horizon .horizon-owed"),
  ];
}

export const inside = (row: Reach, container: string) =>
  [row.selector, row.opens?.click].some(
    (selector) => typeof selector === "string" && selector.startsWith(container),
  );

/** Homes that hold an item yet register none of its scope or origin cases. */
export function missingHomes(body: ViewSnapshot, rows: readonly Reach[]) {
  const ids = new Map<string, string>(
    briefingItems(body.briefing).map(([pointer, { id }]) => [pointer, id]),
  );
  const itemOf = (pointer: string) => ids.get(pointer.replace(/\/(scope|origin)$/, ""));
  return itemHomes(body)
    .filter(
      ([id, container]) =>
        !rows.some((row) => itemOf(row.pointer) === id && inside(row, container)),
    )
    .map(([id, container]) => `${id} at ${container}`);
}

/**
 * Busy with an In progress run core could send (core/brief/ambient.ts): each line's items are
 * Ambient briefing items that no horizon card, owed row, decision or Failing line holds.
 */
export function inMotion() {
  const body = structuredClone(busySnapshot);
  const { briefing } = body;
  const find = (id: string) => {
    const found = briefingItems(briefing).find(([, item]) => item.id === id)?.[1];
    if (!found) throw new Error(`busy carries no ${id}`);
    return found;
  };
  find("rollout").attention = "ambient";
  const decisions = briefing.decisions;
  if (decisions) {
    decisions.groups = decisions.groups.filter(({ itemIds }) => !itemIds.includes("rollout"));
    decisions.items = decisions.groups.length;
  }
  for (const card of briefing.horizon.cards ?? [])
    card.itemIds = card.itemIds.filter((id) => id !== "gate1:workflow");
  const queue = find("gate2:indexer-queue");
  briefing.rest.push({
    ...queue,
    id: "gate2:search",
    ids: ["gate2:search"],
    scope: "search",
    title: "Release/upstream PR #76 waits for approval",
    evidence: [{ label: "PR #76", url: "https://github.com/Azure/osdu-spi-search/pull/76" }],
  });
  return moving(body);
}

/** One click on a shared opener, after checking every field it draws. */
export async function assertOpens(rows: readonly Reach[], body: ViewSnapshot) {
  const row = rows[0];
  expect(row).toBeDefined();
  if (!row) return;
  const where = `${row.pointer} at ${row.home.name}`;
  expect(row.opens, where).toBeDefined();
  if (!row.opens) return;
  await openHome(row.home, body);
  for (const row of rows) assertReach(row);
  expect(await click(row.opens.click, where)).toBe(1);
  if ("detail" in row.opens) {
    const { row: selected, selected: id } = selectionStore.getState();
    expect(selected?.inspectId ?? id, where).toBe(row.opens.detail);
  } else if (row.opens.place.kind === "line") {
    expect(container.querySelector(".line-sheet"), where).not.toBeNull();
  } else expect(window.location.hash, where).toBe(routeHash(row.opens.place));
}

/** Every `of`th entry from `part`, so a block split over files runs each case in exactly one. */
export const dealt =
  (part: number, of: number) =>
  <T,>(items: readonly T[]) =>
    items.filter((_, index) => index % of === part);

export function sweepFields(deal: ReturnType<typeof dealt>, read: Read) {
  shellHooks(read);
  describe("every Briefing and Releases field the 6 Nov sweep carries", () => {
    it.each(deal(homes).map((home) => [home.name, home] as const))(
      "is reachable at %s within one click",
      async (_name, home) => {
        await openHome(home);
        for (const row of drawn.filter((row) => row.home.name === home.name)) assertReach(row);
      },
    );

    it.each(deal([...pairs]))("shows the same shared values at %s", async (_name, pairs) => {
      const readings = new Map<Reach, string>();
      const rows = [...new Set(pairs.flatMap(({ first, row }) => [first, row]))];
      const reached = [...new Map(rows.map(({ home }) => [home.name, home])).values()];
      for (const home of reached) {
        await openHome(home);
        for (const row of rows.filter((row) => row.home.name === home.name)) {
          const value = raw(row, shown(row));
          readings.set(
            row,
            row.contains && !row.read && value.includes(row.value) ? row.value : value,
          );
        }
      }
      for (const { first, row, group } of pairs) {
        const canon = (value: string) =>
          group.reduce((folded, { canon }) => (canon ? canon(folded) : folded), value);
        const a = canon(readings.get(first) ?? "");
        const b = canon(readings.get(row) ?? "");
        expect(
          b,
          `${first.pointer}: ${first.home.name} shows ${a} but ${row.home.name} shows ${b}`,
        ).toBe(a);
      }
    });
  });
}

export const bad = () => structuredClone(badSnapshot);
export const ITEM_MORNINGS = {
  "6 Nov": fixture,
  calm: () => structuredClone(calmSnapshot),
  busy: () => structuredClone(busySnapshot),
  bad,
  "busy with motion": inMotion,
};

export function itemHomesOn(deal: ReturnType<typeof dealt>, read: Read) {
  shellHooks(read);
  describe("every focus and rest item's scope and origin, at its home on Today", () => {
    describe.each(deal(Object.entries(ITEM_MORNINGS)))("%s morning", (_name, morning) => {
      const body = morning();
      const rows = itemHomeCases(body);
      it("has a scope and origin case at every item home", () => {
        const { uncovered } = coverage(body, rows, { ...EXEMPTIONS, ...AT_PLACE });
        expect(uncovered.filter((pointer) => ITEM_HOME.test(pointer))).toEqual([]);
        expect(missingHomes(body, rows)).toEqual([]);
      });
      it.each(openerCases(rows).map(({ name, rows }) => [name, rows] as const))(
        "opens %s within one click",
        async (_name, rows) => {
          await assertOpens(rows, body);
        },
      );
    });
  });
}
