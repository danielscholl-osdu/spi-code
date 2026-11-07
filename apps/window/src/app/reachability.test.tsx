// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-1106.json?raw";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { closeSheet, navigate, relaunch } from "./navigation.js";
import {
  coverage,
  EXEMPTIONS,
  type Home,
  type Reach,
  reachCases,
  type Selector,
  uncoveredRoutes,
} from "./reachability.test-helper.js";
import { DEFAULT_REGISTRY } from "./routes.js";
import { Shell } from "./Shell.js";

const fixture = () => ViewSnapshotSchema.parse(JSON.parse(recorded));
const cases = reachCases(fixture());
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
});

const find = (selector: Selector) =>
  (typeof selector === "string" ? container.querySelector(selector) : selector(container)) ?? null;

async function openHome(home: Home, body = fixture()) {
  await act(async () => root.render(null));
  selectionStore.getState().clear();
  await act(async () => {
    watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
    navigate(home.route);
    root.render(<Shell />);
  });
  for (const step of home.steps) {
    const target = find(step);
    expect(target, `${home.name}: ${String(step)}`).not.toBeNull();
    if (target?.tagName === "SUMMARY" && target.closest("details")?.open) continue;
    await act(async () => (target as HTMLElement).click());
    if (target?.tagName === "SUMMARY")
      expect(target.closest("details")?.open, home.name).toBe(true);
  }
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

function shown(row: Reach) {
  const element = find(row.selector);
  expect(element, `${row.pointer} at ${row.home.name}`).not.toBeNull();
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    const where = `${row.pointer} at ${row.home.name}`;
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
    expect(coverage(fixture(), cases)).toEqual({ uncovered: [], stray: [], stale: [] });
  });

  it("has a case or a named exemption for every route, the sheet and the strip", () => {
    expect(uncoveredRoutes(DEFAULT_REGISTRY, cases)).toEqual([]);
  });

  it("shows the same value wherever two surfaces draw one field", async () => {
    const groups = new Map<string, Reach[]>();
    for (const row of drawn) groups.set(row.pointer, [...(groups.get(row.pointer) ?? []), row]);
    const shared = [...groups.values()].filter(
      (group) => new Set(group.map(({ home }) => home.surface)).size > 1 || group.length > 1,
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

describe("the suite's own guards", () => {
  it("reports a leaf no surface draws", () => {
    const body = fixture();
    (body.briefing as unknown as Record<string, unknown>).added = "a field no surface draws";
    expect(coverage(body, cases).uncovered).toEqual(["/briefing/added"]);
  });

  it("reports an exemption no leaf uses", () => {
    const unused = { ...EXEMPTIONS, unused: { pattern: /^\/nowhere$/, reason: "test" } };
    expect(coverage(fixture(), cases, unused).stale).toEqual(["unused"]);
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
  it("spicode-t1k.225: Today still names the rollout's scope differently from Engineering system", async () => {
    const pointer = cases.find(
      ({ pointer, exempt }) => exempt?.startsWith("spicode-t1k.225") && pointer.endsWith("/scope"),
    )?.pointer;
    const engineering = drawn.find(
      (row) => row.pointer === pointer && row.home.name === "Engineering system · Details",
    );
    expect(engineering).toBeDefined();
    if (!engineering) return;
    await openHome({ name: "Today", surface: "today", route: { kind: "today" }, steps: [] });
    const today = container.querySelector(
      'section.place[aria-label="Today"] li.place-item[data-item-id="rollout"] .place-scope',
    )?.textContent;
    expect(today).toBeTruthy();
    expect(today).not.toBe(engineering.value);
  });
});
