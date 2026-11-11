// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import feed from "../../../../fixtures/watch/inspect-1106.json?raw";
import recorded from "../../../../fixtures/watch/snapshot-1106.json?raw";
import badRaw from "../../../../fixtures/watch/snapshot-bad.json?raw";
import busyRaw from "../../../../fixtures/watch/snapshot-busy.json?raw";
import calmRaw from "../../../../fixtures/watch/snapshot-calm.json?raw";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { moving } from "../views/today/in-motion.test-helper.js";
import { closeSheet, navigate, relaunch, routeHash } from "./navigation.js";
import { placeReachCases } from "./place-reachability.test-helper.js";
import { treeServices } from "./queue.js";
import {
  AT_PLACE,
  bandCases,
  coverage,
  detailFeed,
  EXEMPTIONS,
  HOLD_GAP,
  type Home,
  leaves,
  motionCases,
  type Reach,
  reachCases,
  type Selector,
  STARTS,
  uncoveredRoutes,
} from "./reachability.test-helper.js";
import { DEFAULT_REGISTRY } from "./routes.js";
import { Shell } from "./Shell.js";

const fixture = () => ViewSnapshotSchema.parse(JSON.parse(recorded));
const cases = reachCases(fixture(), detailFeed(feed));
const drawn = cases.filter(({ exempt }) => !exempt);
const homes = [...new Map(drawn.map(({ home }) => [home.name, home])).values()];
const previous = watchStore.getState();
const previousSpi = window.spi;
let container: HTMLDivElement;
let root: Root;

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

async function start(home: Home, body = fixture()) {
  await act(async () => root.render(null));
  selectionStore.getState().clear();
  await act(async () => {
    watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
    navigate(home.start.route);
    root.render(<Shell />);
  });
}

/** One click on a target a person can see; an open disclosure's summary needs none. */
async function click(selector: Selector, where: string) {
  const target = visible(find(selector), `${where}: click ${String(selector)}`);
  if (target.tagName === "SUMMARY" && target.closest("details")?.open) return 0;
  await act(async () => (target as HTMLElement).click());
  if (target.tagName === "SUMMARY") expect(target.closest("details")?.open, where).toBe(true);
  return 1;
}

async function answerDetail(home: Home) {
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
async function openHome(home: Home, body = fixture()) {
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

function assertReach(row: Reach) {
  const value = raw(row, shown(row));
  const where = `${row.pointer} at ${row.home.name}`;
  if (row.contains) expect(value, where).toContain(row.value);
  else expect(value, where).toBe(row.blank ? "" : row.value);
}

describe("every Briefing and Releases field the 6 Nov sweep carries", () => {
  it.each(homes.map((home) => [home.name, home] as const))(
    "is reachable at %s within one click",
    async (_name, home) => {
      await openHome(home);
      for (const row of drawn.filter((row) => row.home.name === home.name)) assertReach(row);
    },
  );

  it("has a case or a named exemption for every leaf, and every exemption still applies", () => {
    expect(coverage(fixture(), cases)).toEqual({
      uncovered: [],
      stray: [],
      stale: [],
      partial: [],
    });
  });

  it("starts every home at a signed-off place, and one name means one home", () => {
    const body = fixture();
    const starts = [
      ...Object.values(STARTS).filter((entry) => typeof entry !== "function"),
      ...treeServices(body.tree).map(STARTS.service),
      ...body.releases.lines.map(({ month }) => STARTS.release(month)),
    ];
    const byName = new Map<string, string>();
    for (const { home } of cases) {
      expect(starts, home.name).toContainEqual(home.start);
      const shape = JSON.stringify([home.start, String(home.step), home.detail?.id]);
      expect(byName.get(home.name) ?? shape, home.name).toBe(shape);
      byName.set(home.name, shape);
    }
  });

  it("has a case or a named exemption for every route, the sheet and the strip", () => {
    expect(uncoveredRoutes(DEFAULT_REGISTRY, cases)).toEqual([]);
  });

  it("shows the same value wherever two surfaces draw one field", async () => {
    const groups = new Map<string, Reach[]>();
    for (const row of drawn) groups.set(row.pointer, [...(groups.get(row.pointer) ?? []), row]);
    const shared = [...groups.values()].filter(
      (group) => new Set(group.map(({ home }) => home.start.surface)).size > 1 || group.length > 1,
    );
    expect(shared.length).toBeGreaterThan(0);
    const readings = new Map<Reach, string>();
    for (const home of homes) {
      const rows = shared.flat().filter((row) => row.home.name === home.name);
      if (rows.length === 0) continue;
      await openHome(home);
      for (const row of rows) {
        const value = raw(row, shown(row));
        readings.set(
          row,
          row.contains && !row.read && value.includes(row.value) ? row.value : value,
        );
      }
    }
    for (const group of shared) {
      const canon = (value: string) =>
        group.reduce((folded, { canon }) => (canon ? canon(folded) : folded), value);
      const [first, ...rest] = group;
      if (!first) continue;
      for (const row of rest) {
        const a = canon(readings.get(first) ?? "");
        const b = canon(readings.get(row) ?? "");
        expect(
          b,
          `${first.pointer}: ${first.home.name} shows ${a} but ${row.home.name} shows ${b}`,
        ).toBe(a);
      }
    }
  });
});

describe("In motion and Can wait, on mornings that carry them", () => {
  const MORNINGS = {
    calm: () => ViewSnapshotSchema.parse(JSON.parse(calmRaw)),
    "busy with motion": () => moving(ViewSnapshotSchema.parse(JSON.parse(busyRaw))),
  };
  it.each(Object.entries(MORNINGS))(
    "has a case for every In progress and Can wait leaf on the %s morning, each within one click",
    async (_name, morning) => {
      const body = morning();
      const motion = motionCases(body);
      const pointers = new Set(motion.map(({ pointer }) => pointer));
      const mine = leaves(body)
        .map(({ pointer }) => pointer)
        .filter((pointer) => /^\/briefing\/(ambient\/inProgress|canWait)\//.test(pointer));
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.filter((pointer) => !pointers.has(pointer))).toEqual([]);
      const reached = [...new Map(motion.map(({ home }) => [home.name, home])).values()];
      for (const home of reached) {
        await openHome(home, body);
        for (const row of motion.filter((row) => row.home.name === home.name)) assertReach(row);
      }
    },
  );
});

const ITEM_HOME = /^\/briefing\/(focus|rest)\/\d+\/(scope|origin)$/;
const itemHomeCases = (body: ViewSnapshot) =>
  [...bandCases(body), ...motionCases(body), ...placeReachCases(body)].filter(({ pointer }) =>
    ITEM_HOME.test(pointer),
  );

/** One click on the case's opener, then the Detail id or the place it opened. */
async function assertOpens(row: Reach, body: ViewSnapshot) {
  const where = `${row.pointer} at ${row.home.name}`;
  expect(row.opens, where).toBeDefined();
  if (!row.opens) return;
  await openHome(row.home, body);
  assertReach(row);
  expect(await click(row.opens.click, where)).toBe(1);
  if ("detail" in row.opens) {
    const { row: selected, selected: id } = selectionStore.getState();
    expect(selected?.inspectId ?? id, where).toBe(row.opens.detail);
  } else expect(window.location.hash, where).toBe(routeHash(row.opens.place));
}

describe("every focus and rest item's scope and origin, at its home on Today", () => {
  const MORNINGS = {
    "6 Nov": fixture,
    busy: () => ViewSnapshotSchema.parse(JSON.parse(busyRaw)),
    bad: () => ViewSnapshotSchema.parse(JSON.parse(badRaw)),
    "busy with motion": () => moving(ViewSnapshotSchema.parse(JSON.parse(busyRaw))),
  };
  it.each(Object.entries(MORNINGS))(
    "has a case for each on the %s morning, and each one's click opens its Detail or place",
    async (_name, morning) => {
      const body = morning();
      const rows = itemHomeCases(body);
      const { uncovered } = coverage(body, rows, { ...EXEMPTIONS, ...AT_PLACE });
      expect(uncovered.filter((pointer) => ITEM_HOME.test(pointer))).toEqual([]);
      const patterns = (pointers: Iterable<string>) =>
        new Set([...pointers].map((pointer) => pointer.replace(/\/\d+\//, "/#/")));
      expect(patterns(rows.map(({ pointer }) => pointer))).toEqual(
        patterns(
          leaves(body)
            .map(({ pointer }) => pointer)
            .filter((pointer) => ITEM_HOME.test(pointer)),
        ),
      );
      for (const row of rows) await assertOpens(row, body);
    },
  );
});

describe("the suite's own guards", () => {
  it("reports a leaf no surface draws", () => {
    const body = fixture();
    (body.briefing as unknown as Record<string, unknown>).added = "a field no surface draws";
    expect(coverage(body, cases).uncovered).toEqual(["/briefing/added"]);
  });

  it("reports an exemption pattern no leaf uses", () => {
    const unused = { ...EXEMPTIONS, unused: { patterns: ["/nowhere"], reason: "test" } };
    expect(coverage(fixture(), cases, unused).stale).toEqual(["unused /nowhere"]);
  });

  it("keeps a pending contract field out of stale until core fills it, and exempts it once it does", () => {
    const later = { patterns: ["/briefing/later"], reason: "test", pending: true as const };
    const exemptions = { ...EXEMPTIONS, later };
    expect(coverage(fixture(), cases, exemptions).stale).toEqual([]);
    const body = fixture();
    (body.briefing as unknown as Record<string, unknown>).later = "a field core fills later";
    expect(coverage(body, cases, exemptions).uncovered).toEqual([]);
  });

  it("exempts only the exact leaf patterns it names, never a same-named leaf elsewhere", () => {
    const body = fixture();
    Object.assign(body.briefing.flow, {
      evidence: [{ label: "a new label", url: "https://example.com" }],
      id: "a new id",
    });
    expect(coverage(body, cases).uncovered).toEqual([
      "/briefing/flow/evidence/0/label",
      "/briefing/flow/evidence/0/url",
      "/briefing/flow/id",
    ]);
  });

  it("reports a partial case whose shown prefix and missing tail do not make up its leaf", () => {
    const misfit = cases.map((row) =>
      row.partial ? { ...row, partial: { ...row.partial, tail: "not the tail" } } : row,
    );
    expect(coverage(fixture(), misfit).partial.every((entry) => "misfit" in entry)).toBe(true);
  });

  it("rejects a click on a target hidden inside a closed details", async () => {
    const hold = cases.find(({ exempt }) => exempt === HOLD_GAP)?.home;
    expect(hold?.step).toBeDefined();
    if (!hold) return;
    await expect(openHome(hold)).rejects.toThrow(/click/);
  });

  it("reports a route with no case", () => {
    const registry = {
      ...DEFAULT_REGISTRY,
      views: { ...DEFAULT_REGISTRY.views, added: () => null },
    };
    expect(uncoveredRoutes(registry, cases)).toEqual(["added"]);
  });

  it("fails a field whose value no surface shows", async () => {
    const row = drawn.find(({ pointer }) => pointer === "/briefing/environment/headline");
    expect(row).toBeDefined();
    if (!row) return;
    const body = fixture();
    body.briefing.environment.headline = "";
    await openHome(row.home, body);
    expect(() => assertReach(row)).toThrow();
  });
});

describe("named gaps the suite tracks until their beads close", () => {
  it("spicode-t1k.226: a hold's Detail draws the host's answer two clicks from Environment, not one", async () => {
    const rows = cases.filter(({ exempt }) => exempt === HOLD_GAP);
    const hold = rows[0]?.home;
    expect(hold?.step).toBeDefined();
    expect(rows.some(({ selector }) => String(selector).includes("inspector-related"))).toBe(true);
    if (!hold?.step) return;
    // The Detail reads its times against the wall clock; pin it to the track's clock the expected
    // text reads against, so the day prefix agrees in every zone.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(fixture().briefing.environment.to) });
    await start(hold);
    expect(await click('[data-part="runs"] > summary', hold.name)).toBe(1);
    expect(container.querySelector(".inspector")).toBeNull();
    expect(await click(hold.step, hold.name)).toBe(1);
    await answerDetail(hold);
    for (const row of rows) assertReach(row);
  });
});
