// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture, watchFixtures } from "../../../../../scripts/watch-generated.mjs";
import {
  closeSheet,
  navigate,
  openSelection,
  openSheet,
  type Route,
  routeHash,
} from "../../app/navigation.js";
import { DEFAULT_REGISTRY } from "../../app/routes.js";
import { Shell } from "../../app/Shell.js";
import { placeMembers } from "../../components/place/members.js";
import memberFixture from "../../components/place/members-1116.json?raw";
import { selectionStore } from "../../panels/selection.js";
import { PINS_STORAGE_KEY, readPins, SEED_PINS } from "../../store/pins.js";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { memberStations } from "./cells.js";

const loadFixture = fixtureLoader(readFixture);
const recording = () => loadFixture("snapshot-59d6895.json");
const previousWatch = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
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
const main = () => container.querySelector<HTMLElement>(".centre-body");
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
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Mac OS X)");
  closeSheet();
  localStorage.removeItem(PINNED_KEY);
  window.location.hash = "#today";
  harness = installSpi();
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
  harness.restore();
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
    { kind: "evidence" },
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

it("docks beside a live centre without replacing its surface or selection", async () => {
  await mount();
  await act(async () => navigate({ kind: "service", id: "legal" }));
  await act(async () => selectionStore.getState().select("station:legal:sync"));
  const surface = main()?.firstElementChild;
  await open();
  const toolbar = () =>
    [...(sheet()?.querySelectorAll(".line-toolbar button") ?? [])].map(
      (item) =>
        `${item.getAttribute("aria-label") ?? ""} ${item.textContent} ${item.getAttribute("title") ?? ""}`,
    );
  expect(toolbar().some((text) => /\b(Pin|Unpin)\b/.test(text))).toBe(false);
  await click(button("Dock"));
  expect(toolbar().some((text) => /\b(Pin|Unpin)\b/.test(text))).toBe(false);
  expect(readPins()).toEqual(SEED_PINS);
  expect(sheet()?.dataset.presentation).toBe("pinned");
  expect(main()?.hasAttribute("inert")).toBe(false);
  expect(main()?.firstElementChild).toBe(surface);
  expect(window.location.hash).toBe("#service/legal");
  expect(selectionStore.getState().selected).toBe("station:legal:sync");
  const station = main()?.querySelector<HTMLElement>('[data-station="cascade"]');
  if (!station) throw new Error("Missing centre station");
  await click(station);
  expect(openSelection()).toEqual({ kind: "cell", id: "legal:cascade" });
  await press("Escape");
  expect(openSelection()).toBeNull();
  expect(sheet()?.dataset.presentation).toBe("pinned");
});

it("Undock closes the sheet and removes its saved dock without changing the centre", async () => {
  await mount();
  const surface = main()?.firstElementChild;
  await open();
  await click(button("Dock"));
  await click(button("Undock"));
  expect(sheet()).toBeNull();
  expect(localStorage.getItem(PINNED_KEY)).toBeNull();
  expect(main()?.firstElementChild).toBe(surface);
});

it("restores a docked sheet on reload from the persisted dock", async () => {
  await mount();
  await act(async () => navigate({ kind: "service", id: "legal" }));
  await open();
  await click(button("Dock"));
  const saved = localStorage.getItem(PINNED_KEY);
  expect(saved).toBe("1");
  if (saved === null) throw new Error("Missing saved dock");
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

it("pins and unpins a service from the control after its name, keeping the sheet open", async () => {
  await mount();
  await open();
  const name = sheet()?.querySelector<HTMLButtonElement>('tr[data-service="legal"] th button');
  const control = () => name?.nextElementSibling;
  expect(control()?.className).toBe("pin-control");
  expect(control()?.getAttribute("aria-label")).toBe("Pin legal to sidebar");
  expect(control()?.getAttribute("title")).toBe("Pin legal to sidebar");
  await click(control() as HTMLElement);
  expect(readPins()).toEqual([...SEED_PINS, "legal"]);
  expect(control()?.getAttribute("aria-label")).toBe("Unpin legal from sidebar");
  expect(control()?.getAttribute("data-pinned")).toBe("true");
  await click(control() as HTMLElement);
  expect(readPins()).toEqual(SEED_PINS);
  expect(sheet()).not.toBeNull();
  expect(window.location.hash).toBe("#today");
});

it("opens, pins and unpins a row's service from its context menu, by pointer and keyboard, keeping the sheet open", async () => {
  await mount();
  await open();
  const row = () => sheet()?.querySelector<HTMLElement>('tbody tr[data-service="legal"]');
  const menu = () => document.querySelector<HTMLElement>('[data-pin-menu="legal"]');
  const items = () => [...(menu()?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
  const item = () => items()[1];
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
  expect(items().map((entry) => entry.textContent)).toEqual(["Open", "Pin to sidebar"]);
  await act(async () => item()?.click());
  expect(readPins()).toEqual([...SEED_PINS, "legal"]);
  expect(pinned().at(-1)).toBe("service/legal");
  expect(sheet()).not.toBeNull();
  expect(window.location.hash).toBe("#today");

  const name = row()?.querySelector<HTMLButtonElement>("th button");
  await act(async () => name?.focus());
  await press("F10", { shiftKey: true });
  expect(item()?.textContent).toBe("Unpin from sidebar");
  await press("Escape");
  expect(menu()).toBeNull();
  expect(sheet()).not.toBeNull();
  await act(async () => name?.focus());
  await press("ContextMenu");
  await act(async () => item()?.click());
  expect(readPins()).toEqual(SEED_PINS);
  expect(pinned()).not.toContain("service/legal");
  expect(sheet()).not.toBeNull();
  await act(async () => name?.focus());
  await press("ContextMenu");
  await act(async () => items()[0]?.click());
  expect(window.location.hash).toBe("#service/legal");
  expect(readPins()).toEqual(SEED_PINS);
});

function november16() {
  const fixture = JSON.parse(
    readFileSync(`${process.cwd()}/apps/window/src/views/line/fixtures/sweep-1116.json`, "utf8"),
  );
  const body = loadFixture("snapshot-1106.json");
  return ViewSnapshotSchema.parse({
    ...body,
    provenance: [],
    stations: fixture.stations,
    campaigns: fixture.campaigns,
    briefing: {
      ...body.briefing,
      focus: fixture.focus,
      rest: fixture.rest,
      lines: JSON.parse(memberFixture).lines,
      flow: { ...body.briefing.flow, plan: fixture.plan },
    },
  });
}

it("dots exactly the Line-home members' stations over every watch fixture and 16 Nov", async () => {
  const snapshots = watchFixtures()
    .filter(({ name }) => name.startsWith("snapshot-"))
    .map(({ name, path }) => ({
      name,
      body: ViewSnapshotSchema.parse(JSON.parse(readFixture(path))),
    }));
  const unproven = loadFixture("snapshot-1106.json");
  delete unproven.briefing.lines;
  snapshots.push({ name: "16 Nov", body: november16() }, { name: "no members", body: unproven });
  await mount();
  for (const { name, body } of snapshots) {
    await act(async () => watchStore.setState({ snapshot: { cursor: body.cursor, body } }));
    await act(async () => openSheet());
    const fold = sheet()?.querySelector<HTMLButtonElement>('.line-fold[aria-expanded="false"]');
    if (fold) await click(fold);
    const expected = new Set(
      placeMembers(body, "line").flatMap(({ member }) =>
        memberStations(member).map((station) => `${member.fork}:${station}`),
      ),
    );
    const dotted = [...(sheet()?.querySelectorAll<HTMLButtonElement>("[data-on-today]") ?? [])];
    expect(new Set(dotted.map((cell) => cell.dataset.cell)), name).toEqual(expected);
    await act(async () => closeSheet());
  }
});

it("folds only file on 16 Nov and expands in fleet order", async () => {
  const body = november16();
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  expect(services()).toEqual(
    body.stations.filter(({ service }) => service !== "file").map(({ service }) => service),
  );
  await click(button("▸ 1 moving normally: file"));
  expect(services()).toEqual(body.stations.map(({ service }) => service));
  await click(button("▾ 1 moving normally: file"));
  expect(services()).not.toContain("file");
});

it("leaves every fork visible on a calm morning", async () => {
  const body = november16();
  body.briefing.focus = [];
  body.briefing.rest = [];
  body.briefing.lines = [];
  for (const row of body.stations)
    for (const station of row.stations) {
      station.state = "idle";
      station.substate = station.id === "upstream" ? "waiting-on-clock" : "ready";
    }
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  expect(services()).toEqual(body.stations.map(({ service }) => service));
  expect(sheet()?.querySelector(".line-fold")).toBeNull();
});

it("keeps running, unread and Today-held forks visible even when their other cells are fine", async () => {
  const body = november16();
  for (const row of body.stations)
    for (const station of row.stations) {
      station.state = "idle";
      station.substate = "ready";
    }
  const running = body.stations[0]?.stations[0];
  const unread = body.stations[1]?.stations[0];
  if (!running || !unread) throw new Error("Missing fixture stations");
  running.substate = "in-progress";
  unread.state = "unknown";
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  expect(services()).toContain("partition");
  expect(services()).toContain("entitlements");
  expect(services()).toContain("crs-conversion");
  expect(services()).not.toContain("file");
});

it("shows the held fork's explanation without a core code, and marks its member", async () => {
  const body = november16();
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  const cell = sheet()?.querySelector(
    '[data-service="crs-conversion"] button[data-station="sync"]',
  );
  expect(cell?.textContent).toContain("halted: no filter rule for schemathesis-tests");
  expect(cell?.hasAttribute("data-on-today")).toBe(true);
  expect(sheet()?.textContent).not.toContain("UNKNOWN_TOP_LEVEL");
});

it("highlights a campaign without removing other forks or adding a station", async () => {
  const body = november16();
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  const before = services();
  const campaign = body.campaigns.find(({ kind }) => kind === "toolchain");
  if (!campaign) throw new Error("Missing fixture campaign");
  const chip = button(`${campaign.fact} · ${campaign.forks.length} forks`);
  await click(chip);
  expect(services()).toEqual(before);
  expect(
    [...(sheet()?.querySelectorAll('tr[data-highlighted="true"]') ?? [])].map((row) =>
      row.getAttribute("data-service"),
    ),
  ).toEqual(before.filter((service) => campaign.forks.includes(service ?? "")));
  expect(sheet()?.querySelectorAll("thead th")).toHaveLength(6);
  await click(chip);
  expect(sheet()?.querySelector("[data-highlighted]")).toBeNull();
});

it("names every typed glyph in words and opens a cell's popover", async () => {
  const body = recording();
  const substates = [
    "stopped",
    "waiting-on-person",
    "in-progress",
    "waiting-on-clock",
    "ready",
  ] as const;
  for (const [index, substate] of substates.entries()) {
    const station = body.stations[0]?.stations.filter(({ id }) => id !== "release")[index];
    if (!station) throw new Error("Missing fixture station");
    station.state = "idle";
    station.substate = substate;
    station.text = `Recorded cell ${index}`;
  }
  const unread = body.stations[1]?.stations[0];
  if (!unread) throw new Error("Missing unread fixture station");
  unread.state = "unknown";
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  expect(
    [...(sheet()?.querySelectorAll("thead th") ?? [])].map((cell) => cell.textContent),
  ).toEqual(["Fork", "Upstream", "Sync PR", "Cascade", "Main", "Lane"]);
  const glyphs = [...(sheet()?.querySelectorAll<HTMLElement>(".line-cell .line-glyph") ?? [])];
  expect(glyphs.length).toBeGreaterThan(6);
  const names: Record<string, string> = {
    "✕": "stopped",
    "!": "waits on you",
    "◐": "running",
    "◷": "waits on time",
    "·": "fine",
    "⌀": "not read",
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
  expect(cell.getAttribute("aria-expanded")).toBe("true");
  expect(sheet()?.querySelector(".popover")?.getAttribute("role")).toBe("dialog");
  expect(selectionStore.getState().selected).toBeNull();
});

it("keeps a blank reading honest and draws no table before a sweep", async () => {
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
  ).toContain("⌀ not read");
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
    const body = loadFixture("snapshot-1106.json");
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
    expect(sheet()?.textContent).toContain(`${expected.length} forks`);
  },
);

it("clears the column chip to restore every November 6 service", async () => {
  const body = loadFixture("snapshot-1106.json");
  const station = body.stations[0]?.stations.find(({ id }) => id === "upstream");
  if (!station) throw new Error("Missing fixture station");
  station.text = "";
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await act(async () => openSheet({ column: "upstream" }));
  expect(services()).not.toContain("partition");
  await click(button("Clear Upstream filter"));
  expect(services()).toEqual(
    body.stations.filter(({ service }) => service !== "crs-catalog").map(({ service }) => service),
  );
  const fold = sheet()?.querySelector<HTMLButtonElement>(".line-fold");
  if (!fold) throw new Error("Missing quiet fold");
  await click(fold);
  expect(services()).toEqual(body.stations.map(({ service }) => service));
  expect(sheet()?.querySelector('[aria-label="Station filter"]')).toBeNull();
});

it.each([
  ["sync", "Sync PR"],
  ["cascade", "Cascade"],
  ["main", "Main"],
] as const)("opens with the %s station filter", async (column, label) => {
  const body = loadFixture("snapshot-1106.json");
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
  const body = loadFixture("snapshot-1106.json");
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
  expect(services()).toEqual(
    body.stations.filter(({ service }) => service !== "crs-catalog").map(({ service }) => service),
  );
  expect(sheet()?.querySelector('[aria-label="Station filter"]')).toBeNull();
});

it("opens a new column or an unfiltered sheet over a pinned sheet without keeping its campaign", async () => {
  const body = loadFixture("snapshot-1106.json");
  const station = body.stations[0]?.stations.find(({ id }) => id === "upstream");
  if (!station) throw new Error("Missing fixture station");
  station.text = "";
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await mount();
  await open();
  await click(button("Dock"));
  await click(button("os-core-common 8.5.0 · 10 forks"));
  await act(async () => navigate({ kind: "line", column: "upstream" }));
  expect(sheet()?.dataset.presentation).toBe("pinned");
  expect(services()).toEqual(body.stations.slice(1).map(({ service }) => service));
  expect(button("os-core-common 8.5.0 · 10 forks").getAttribute("aria-pressed")).toBe("false");
  await act(async () => openSheet());
  expect(sheet()?.dataset.presentation).toBe("pinned");
  expect(services()).toEqual(
    body.stations.filter(({ service }) => service !== "crs-catalog").map(({ service }) => service),
  );
  expect(sheet()?.querySelector('[aria-label="Station filter"]')).toBeNull();
});

it.each([
  ["UNKNOWN_TOP_LEVEL", undefined],
  ["MERGE_CONFLICT", "pom.xml"],
  ["HALT", "an entry"],
  ["UNKNOWN_TOP_LEVEL", "an entry"],
  ["UNKNOWN_TESTING_ENTRY", "an entry"],
])(
  "reports no Today membership or halt cause when the briefing cannot prove it (%s, %s)",
  async (code, subject) => {
    const body = november16();
    body.briefing.focus = body.briefing.focus.filter((item) => {
      if (!subject || item.id !== "halt:crs-conversion") return false;
      item.title = `Sync halted on ${subject}`;
      return true;
    });
    body.briefing.rest = [];
    body.briefing.lines = [];
    const station = body.stations
      .find(({ service }) => service === "crs-conversion")
      ?.stations.find(({ id }) => id === "sync");
    if (!station) throw new Error("Missing fixture station");
    station.text = `halted: ${code}`;
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    await mount();
    await open();
    if (!subject) expect(sheet()?.querySelector("button[data-on-today]")).toBeNull();
    const halt = sheet()?.querySelector(
      '[data-service="crs-conversion"] button[data-station="sync"]',
    );
    expect(halt?.textContent).toContain("sync halted");
    expect(halt?.textContent).not.toMatch(
      /halted:|no filter rule|schemathesis-tests|pom.xml|an entry/,
    );
  },
);

it("keeps every removed release PR reachable on Releases with its own source", async () => {
  const body = loadFixture("snapshot-1106.json");
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  harness.spi.openExternal.mockResolvedValue(true);
  await mount();
  await open();
  expect(sheet()?.querySelector('[data-station="release"]')).toBeNull();
  await click(button("Close Line"));
  await act(async () => navigate({ kind: "releases" }));
  for (const { service, stations } of body.stations) {
    const release = stations.find(({ id }) => id === "release");
    const number = /#(\d+)/.exec(release?.text ?? "")?.[1];
    if (!number) continue;
    const source = body.releases.forming?.prs.find(
      (pr) => pr.kind === "service" && pr.service === service && String(pr.pr.number) === number,
    );
    expect(source, service).toBeTruthy();
    const row = [...container.querySelectorAll<HTMLElement>(".forming-release")].find(
      (row) => row.querySelector(".kit-chip--service")?.textContent === service,
    );
    const link = row?.querySelector<HTMLButtonElement>(".release-pr button");
    expect(link, service).toBeTruthy();
    expect(row?.querySelector(".release-pr")?.getAttribute("data-pr-url"), service).toBe(
      source?.pr.url,
    );
    await click(link as HTMLButtonElement);
    expect(harness.spi.openExternal).toHaveBeenLastCalledWith(source?.pr.url);
  }
});
