// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-59d6895.json?raw";
import november6 from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { closeSheet, navigate, openSheet, type Route, routeHash } from "../../app/navigation.js";
import { DEFAULT_REGISTRY } from "../../app/routes.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { PINS_STORAGE_KEY, readPins } from "../../store/pins.js";
import { watchStore } from "../../store/watch.js";

const recording = () => ViewSnapshotSchema.parse(JSON.parse(recorded));
const NOVEMBER_6_NEEDING = [
  "partition",
  "entitlements",
  "legal",
  "storage",
  "indexer",
  "indexer-queue",
];
const NOVEMBER_6_QUIET =
  "7 services need nothing: schema, file, search, workflow, unit, crs-catalog, crs-conversion";
const previousWatch = watchStore.getState();
const previousSpi = window.spi;
const PINNED_KEY = "spi-code.line-sheet.pinned";
let container: HTMLDivElement;
let unmount: (() => Promise<void>) | undefined;

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

const sheet = () => container.querySelector<HTMLElement>(".line-sheet");
const main = () => container.querySelector<HTMLElement>("main");
const button = (label: string) => {
  const found = [...(sheet()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (item) => (item.getAttribute("aria-label") ?? item.textContent) === label,
  );
  if (!found) throw new Error(`Missing sheet button: ${label}`);
  return found;
};
const click = (element: HTMLElement) => act(async () => element.click());
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
const open = () => press("l", { metaKey: true });
const services = () =>
  [...(sheet()?.querySelectorAll<HTMLTableRowElement>("tbody tr[data-service]") ?? [])].map(
    (row) => row.dataset.service,
  );

beforeEach(() => {
  type HappyWindow = {
    happyDOM: { setViewport(viewport: { width: number; height: number }): void };
  };
  (window as unknown as HappyWindow).happyDOM.setViewport({ width: 1440, height: 900 });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Mac OS X)");
  closeSheet();
  localStorage.removeItem(PINNED_KEY);
  window.location.hash = "#today";
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    setAppearance: vi.fn(async () => true),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
  selectionStore.getState().clear();
  selectionStore.getState().setOpen(false);
  const body = recording();
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  closeSheet();
  localStorage.removeItem(PINNED_KEY);
  localStorage.removeItem(PINS_STORAGE_KEY);
  watchStore.setState(previousWatch, true);
  window.spi = previousSpi;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens with Cmd-L over every registered surface and Escape restores its centre and selection", async () => {
  await mount();
  const routes: Route[] = [
    { kind: "today" },
    { kind: "upstream" },
    { kind: "environment" },
    { kind: "engineering-system" },
    { kind: "releases" },
    { kind: "security" },
    { kind: "release", month: "2026-11" },
    { kind: "service", id: "legal" },
  ];
  expect(new Set(routes.map(({ kind }) => kind))).toEqual(
    new Set(Object.keys(DEFAULT_REGISTRY.views)),
  );
  for (const route of routes) {
    await act(async () => navigate(route));
    await act(async () => selectionStore.getState().select("station:legal:sync"));
    const surface = main()?.firstElementChild;
    const opener = container.querySelector<HTMLElement>('[aria-label="Toggle sidebar"]');
    opener?.focus();
    await open();
    expect(sheet()?.querySelector("h1")?.textContent).toBe("Line");
    expect(main()?.hasAttribute("inert")).toBe(true);
    expect(main()?.firstElementChild).toBe(surface);
    expect(window.location.hash).toBe(routeHash(route));
    expect(selectionStore.getState().selected).toBe("station:legal:sync");
    await press("Escape");
    expect(sheet()).toBeNull();
    expect(main()?.hasAttribute("inert")).toBe(false);
    expect(main()?.firstElementChild).toBe(surface);
    expect(window.location.hash).toBe(routeHash(route));
    expect(selectionStore.getState().selected).toBe("station:legal:sync");
    expect(document.activeElement).toBe(opener);
  }
});

it("pins beside a live centre without replacing its surface or selection", async () => {
  await mount();
  await act(async () => navigate({ kind: "service", id: "legal" }));
  await act(async () => selectionStore.getState().select("station:legal:sync"));
  const surface = main()?.firstElementChild;
  await open();
  await click(button("Pin"));
  expect(sheet()?.dataset.presentation).toBe("pinned");
  expect(main()?.hasAttribute("inert")).toBe(false);
  expect(main()?.firstElementChild).toBe(surface);
  expect(window.location.hash).toBe("#service/legal");
  expect(selectionStore.getState().selected).toBe("station:legal:sync");
  const station = main()?.querySelector<HTMLElement>('[data-station="cascade"]');
  if (!station) throw new Error("Missing centre station");
  await click(station);
  expect(selectionStore.getState().selected).toBe("station:legal:cascade");
  await press("Escape");
  expect(sheet()?.dataset.presentation).toBe("pinned");
});

it("unpin closes the sheet and removes its saved pin without changing the centre", async () => {
  await mount();
  const surface = main()?.firstElementChild;
  await open();
  await click(button("Pin"));
  await click(button("Unpin"));
  expect(sheet()).toBeNull();
  expect(localStorage.getItem(PINNED_KEY)).toBeNull();
  expect(main()?.firstElementChild).toBe(surface);
});

it("restores a pinned sheet on reload from the persisted pin", async () => {
  await mount();
  await act(async () => navigate({ kind: "service", id: "legal" }));
  await open();
  await click(button("Pin"));
  const saved = localStorage.getItem(PINNED_KEY);
  expect(saved).toBe("1");
  if (saved === null) throw new Error("Missing saved pin");
  await unmount?.();
  // Clear the module state, then start with only the saved browser state.
  closeSheet();
  localStorage.setItem(PINNED_KEY, saved);
  await mount();
  expect(sheet()?.dataset.presentation).toBe("pinned");
  expect(sheet()?.querySelector("h1")?.textContent).toBe("Line");
  expect(main()?.hasAttribute("inert")).toBe(false);
  expect(window.location.hash).toBe("#service/legal");
});

it("pins and unpins a row's service from its context menu, by pointer and keyboard, keeping the sheet open", async () => {
  await mount();
  await open();
  const row = () => sheet()?.querySelector<HTMLElement>('tbody tr[data-service="legal"]');
  const menu = () => document.querySelector<HTMLElement>('[data-pin-menu="legal"]');
  const item = () => menu()?.querySelector<HTMLElement>("[role='menuitem']");
  const pinned = () =>
    [...container.querySelectorAll('ul[aria-label="Pinned"] [data-sidebar-row]')].map((pin) =>
      pin.getAttribute("data-sidebar-row"),
    );
  await act(async () => {
    row()
      ?.querySelector("td")
      ?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
      );
  });
  expect(item()?.textContent).toBe("Pin legal");
  await act(async () => item()?.click());
  expect(readPins()).toEqual(["legal"]);
  expect(pinned()).toEqual(["service/legal"]);
  expect(sheet()).not.toBeNull();
  expect(window.location.hash).toBe("#today");

  const name = row()?.querySelector<HTMLButtonElement>("th button");
  await act(async () => name?.focus());
  await press("F10", { shiftKey: true });
  expect(item()?.textContent).toBe("Unpin legal");
  await press("Escape");
  expect(menu()).toBeNull();
  expect(sheet()).not.toBeNull();
  await act(async () => name?.focus());
  await press("ContextMenu");
  await act(async () => item()?.click());
  expect(readPins()).toEqual([]);
  expect(pinned()).toEqual([]);
  expect(sheet()).not.toBeNull();
});

it("folds quiet rows into one named line and expands them in fleet order", async () => {
  const body = recording();
  for (const row of body.stations.slice(1, 3))
    for (const station of row.stations) station.substate = "ready";
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  expect(services()).not.toContain("entitlements");
  expect(services()).not.toContain("legal");
  const folded = button("2 services need nothing: entitlements, legal");
  expect(folded.getAttribute("aria-expanded")).toBe("false");
  await click(folded);
  expect(services()).toEqual(body.stations.map(({ service }) => service));
  expect(button("2 services need nothing: entitlements, legal").getAttribute("aria-expanded")).toBe(
    "true",
  );
  await click(button("2 services need nothing: entitlements, legal"));
  expect(services()).not.toContain("legal");
});

it("folds November 6 rows whose release PRs only wait for review, marking those cells scheduled", async () => {
  const body = ViewSnapshotSchema.parse(JSON.parse(november6));
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  expect(services()).toEqual(NOVEMBER_6_NEEDING);
  const folded = button(NOVEMBER_6_QUIET);
  expect(folded.getAttribute("aria-expanded")).toBe("false");
  const release = (service: string) =>
    sheet()?.querySelector<HTMLElement>(
      `tr[data-service="${service}"] button[data-station="release"]`,
    );
  expect(release("partition")?.textContent).toContain("◷ #198 waiting on review");
  expect(release("partition")?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
    "Scheduled",
  );
  await click(folded);
  expect(services()).toEqual(body.stations.map(({ service }) => service));
  const marks = [
    ...(sheet()?.querySelectorAll('button[data-station="release"] .line-glyph') ?? []),
  ];
  expect(marks.map((mark) => mark.textContent)).toEqual([
    "◷",
    "✕",
    ...Array.from({ length: 11 }, () => "◷"),
  ]);
});

it("filters the recorded log-injection campaign to exactly its three forks, then clears on a second click", async () => {
  await mount();
  await open();
  const chip = button("CodeQL: java/log-injection · 3 forks");
  expect(chip.getAttribute("aria-pressed")).toBe("false");
  await click(chip);
  expect(chip.getAttribute("aria-pressed")).toBe("true");
  expect(services()).toEqual(["partition", "schema", "file"]);
  expect([...(sheet()?.querySelectorAll("th") ?? [])].map((cell) => cell.textContent)).toContain(
    "Campaign",
  );
  expect(sheet()?.querySelectorAll("td[data-campaign]")).toHaveLength(3);
  expect(sheet()?.textContent?.match(/CodeQL: java\/log-injection/g)).toHaveLength(1);
  await click(chip);
  expect(chip.getAttribute("aria-pressed")).toBe("false");
  expect(services()).toContain("legal");
  expect(sheet()?.querySelectorAll("td[data-campaign]")).toHaveLength(0);
});

it("filters the November 6 recorded 8.5.0 campaign to exactly its eight forks with the fact shown once", async () => {
  const body = ViewSnapshotSchema.parse(JSON.parse(november6));
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  const chip = button("os-core-common 8.5.0 · 8 forks");
  expect(chip.getAttribute("aria-pressed")).toBe("false");
  await click(chip);
  expect(chip.getAttribute("aria-pressed")).toBe("true");
  expect(services()).toEqual([
    "schema",
    "file",
    "storage",
    "indexer",
    "search",
    "workflow",
    "unit",
    "crs-conversion",
  ]);
  expect([...(sheet()?.querySelectorAll("th") ?? [])].map((cell) => cell.textContent)).toContain(
    "Campaign",
  );
  expect(sheet()?.querySelectorAll("td[data-campaign]")).toHaveLength(8);
  expect(sheet()?.textContent?.match(/os-core-common 8\.5\.0/g)).toHaveLength(1);
  await click(chip);
  expect(chip.getAttribute("aria-pressed")).toBe("false");
  expect(services()).toContain("legal");
  expect(sheet()?.querySelectorAll("td[data-campaign]")).toHaveLength(0);
});

it("names every typed glyph in words and selects a cell's own Detail reading", async () => {
  const body = recording();
  const substates = [
    "stopped",
    "waiting-on-person",
    "in-progress",
    "waiting-on-clock",
    "ready",
  ] as const;
  for (const [index, substate] of substates.entries()) {
    const station = body.stations[0]?.stations[index];
    if (!station) throw new Error("Missing fixture station");
    station.substate = substate;
    station.text = `Recorded cell ${index}`;
  }
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  const glyphs = [...(sheet()?.querySelectorAll<HTMLElement>(".line-glyph") ?? [])];
  expect(glyphs.length).toBeGreaterThan(6);
  const names: Record<string, string> = {
    "✕": "Stopped",
    "!": "Needs a person",
    "◐": "In progress",
    "◷": "Scheduled",
    "·": "Nothing to do",
  };
  expect(new Set(glyphs.map((glyph) => glyph.textContent))).toEqual(new Set(Object.keys(names)));
  for (const glyph of glyphs) {
    expect(glyph.getAttribute("role")).toBe("img");
    expect(glyph.getAttribute("aria-label")).toBe(names[glyph.textContent ?? ""]);
  }
  const cell = sheet()?.querySelector<HTMLButtonElement>(
    'tr[data-service="partition"] button[data-station="sync"]',
  );
  if (!cell) throw new Error("Missing sheet station");
  await click(cell);
  expect(selectionStore.getState().selected).toBe("station:partition:sync");
  expect(cell.getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("#app-right-panel")?.textContent).toContain("Recorded cell 1");
  expect(window.spi.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "inspect.request", payload: { id: "station:partition:sync" } }),
  );
});

it("draws no empty cells, campaign controls, tables or repeated freshness", async () => {
  const body = recording();
  body.campaigns = [];
  const station = body.stations[0]?.stations[0];
  if (!station) throw new Error("Missing fixture station");
  station.text = "";
  for (const row of body.stations) {
    const release = row.stations.find(({ id }) => id === "release");
    if (release) release.text = "";
  }
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  expect(
    sheet()?.querySelector('tr[data-service="partition"] td[data-station="upstream"]')?.textContent,
  ).toBe("");
  expect(sheet()?.querySelector(".line-campaigns")).toBeNull();
  expect(
    [...(sheet()?.querySelectorAll("th") ?? [])].map((cell) => cell.textContent),
  ).not.toContain("Release PR");
  expect(sheet()?.querySelector("[data-evidence], .section-evidence, .sweep-line")).toBeNull();
  expect(sheet()?.textContent).not.toMatch(/—|n\/a|not available|not read yet/i);
  await act(async () => watchStore.setState({ snapshot: null }));
  expect(sheet()?.querySelector("table")).toBeNull();
  expect(sheet()?.querySelector(".line-campaigns")).toBeNull();
  await click(button("Close Line"));
  expect(sheet()).toBeNull();
});

it.each(["recorded", "blank stations"] as const)(
  "opens the November 6 sheet with exactly the services with upstream text (%s)",
  async (variant) => {
    const body = ViewSnapshotSchema.parse(JSON.parse(november6));
    if (variant === "blank stations") {
      for (const [service, text] of [
        ["partition", ""],
        ["legal", " \t "],
      ]) {
        const station = body.stations
          .find((row) => row.service === service)
          ?.stations.find(({ id }) => id === "upstream");
        if (!station || text === undefined) throw new Error("Missing fixture station");
        station.text = text;
      }
      const quiet = body.stations.find(({ service }) => service === "entitlements");
      if (!quiet) throw new Error("Missing fixture service");
      for (const station of quiet.stations) station.substate = "ready";
    }
    const expected = body.stations
      .filter(({ stations }) => stations.some(({ id, text }) => id === "upstream" && text.trim()))
      .map(({ service }) => service);
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    await mount();
    await act(async () => navigate({ kind: "line", column: "upstream" }));
    expect(services()).toEqual(expected);
    expect(button("Clear Upstream filter").getAttribute("aria-pressed")).toBe("true");
    expect(sheet()?.textContent).toContain(`${expected.length} services`);
  },
);

it("clears the column chip to restore every November 6 service", async () => {
  const body = ViewSnapshotSchema.parse(JSON.parse(november6));
  const station = body.stations[0]?.stations.find(({ id }) => id === "upstream");
  if (!station) throw new Error("Missing fixture station");
  station.text = "";
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await act(async () => openSheet({ column: "upstream" }));
  expect(services()).not.toContain("partition");
  await click(button("Clear Upstream filter"));
  expect(services()).toEqual(NOVEMBER_6_NEEDING);
  await click(button(NOVEMBER_6_QUIET));
  expect(services()).toEqual(body.stations.map(({ service }) => service));
  expect(sheet()?.querySelector('[aria-label="Station filter"]')).toBeNull();
});

it.each([
  ["sync", "Sync PR"],
  ["cascade", "Cascade"],
  ["main", "Main"],
  ["release", "Release PR"],
] as const)("opens with the %s station filter", async (column, label) => {
  const body = ViewSnapshotSchema.parse(JSON.parse(november6));
  const station = body.stations[0]?.stations.find(({ id }) => id === column);
  if (!station) throw new Error("Missing fixture station");
  station.text = "";
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await act(async () => openSheet({ column }));
  expect(services()).toEqual(
    body.stations
      .filter(({ stations }) => stations.some(({ id, text }) => id === column && text.trim()))
      .map(({ service }) => service),
  );
  expect(button(`Clear ${label} filter`).getAttribute("aria-pressed")).toBe("true");
});

it("reopens unfiltered with Cmd-L after a November 6 column filter", async () => {
  const body = ViewSnapshotSchema.parse(JSON.parse(november6));
  const station = body.stations[0]?.stations.find(({ id }) => id === "upstream");
  if (!station) throw new Error("Missing fixture station");
  station.text = "";
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await act(async () => openSheet({ column: "upstream" }));
  expect(services()).not.toContain("partition");
  await open();
  expect(sheet()).toBeNull();
  await open();
  expect(services()).toEqual(NOVEMBER_6_NEEDING);
  expect(sheet()?.querySelector('[aria-label="Station filter"]')).toBeNull();
});

it("intersects a station filter with a campaign and clears either independently", async () => {
  const body = ViewSnapshotSchema.parse(JSON.parse(november6));
  const station = body.stations
    .find(({ service }) => service === "schema")
    ?.stations.find(({ id }) => id === "upstream");
  if (!station) throw new Error("Missing fixture station");
  station.text = "";
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await act(async () => openSheet({ column: "upstream" }));
  await click(button("os-core-common 8.5.0 · 8 forks"));
  expect(services()).toEqual([
    "file",
    "storage",
    "indexer",
    "search",
    "workflow",
    "unit",
    "crs-conversion",
  ]);
  await click(button("os-core-common 8.5.0 · 8 forks"));
  expect(services()).toEqual(
    body.stations.filter(({ service }) => service !== "schema").map(({ service }) => service),
  );
  await click(button("os-core-common 8.5.0 · 8 forks"));
  await click(button("Clear Upstream filter"));
  const forks = body.campaigns.find(({ forks }) => forks.length === 8)?.forks;
  expect(services()).toEqual(
    body.stations.filter(({ service }) => forks?.includes(service)).map(({ service }) => service),
  );
});

it("opens a new column or an unfiltered sheet over a pinned sheet without keeping its campaign", async () => {
  const body = ViewSnapshotSchema.parse(JSON.parse(november6));
  const station = body.stations[0]?.stations.find(({ id }) => id === "upstream");
  if (!station) throw new Error("Missing fixture station");
  station.text = "";
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  await click(button("Pin"));
  await click(button("os-core-common 8.5.0 · 8 forks"));
  await act(async () => navigate({ kind: "line", column: "upstream" }));
  expect(sheet()?.dataset.presentation).toBe("pinned");
  expect(services()).toEqual(body.stations.slice(1).map(({ service }) => service));
  expect(button("os-core-common 8.5.0 · 8 forks").getAttribute("aria-pressed")).toBe("false");
  await act(async () => openSheet());
  expect(sheet()?.dataset.presentation).toBe("pinned");
  expect(services()).toEqual(NOVEMBER_6_NEEDING);
  expect(sheet()?.querySelector('[aria-label="Station filter"]')).toBeNull();
});
