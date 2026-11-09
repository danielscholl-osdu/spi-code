// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  type Station,
  type StationSubstate,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import november6 from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { closeSheet } from "../../app/navigation.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { PINS_STORAGE_KEY, readPins } from "../../store/pins.js";
import { selectStrip } from "../../store/strip.js";
import { watchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import { after, midSweep } from "../sweep/test-helper.js";

const FLEET = [
  "partition",
  "entitlements",
  "legal",
  "schema",
  "file",
  "storage",
  "indexer",
  "search",
  "workflow",
  "indexer-queue",
  "unit",
  "crs-catalog",
  "crs-conversion",
];
const fixture = () => ViewSnapshotSchema.parse(JSON.parse(november6));
const previousWatch = watchStore.getState();
const previousSpi = window.spi;
let container: HTMLDivElement;
let unmount: (() => Promise<void>) | undefined;

function show(body: ViewSnapshot) {
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
}

async function mount() {
  const style = document.createElement("style");
  style.textContent = [
    readFileSync("apps/window/src/style.css", "utf8"),
    readFileSync("apps/window/src/components/strip/strip.css", "utf8"),
  ].join("\n");
  document.head.append(style);
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
    style.remove();
  };
}

const strip = () => container.querySelector<HTMLElement>(".window-strip [data-strip]");
const field = (name: string) => strip()?.querySelector<HTMLElement>(`[data-field="${name}"]`);
const pips = () => [...(strip()?.querySelectorAll<HTMLElement>("[data-pip]") ?? [])];
const sheet = () => container.querySelector(".line-sheet");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Mac OS X) Electron/44.10.0",
  );
  closeSheet();
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
  show(fixture());
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  closeSheet();
  watchStore.setState(previousWatch, true);
  window.spi = previousSpi;
  localStorage.removeItem(PINS_STORAGE_KEY);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("draws one pip per service in fleet order, partition first", async () => {
  await mount();
  const services = pips().map((pip) => pip.dataset.service);
  expect(services).toEqual(FLEET);
  expect(services[0]).toBe("partition");
});

it("draws and names the four pip shapes, the worst line station winning", async () => {
  const body = fixture();
  const set = (service: string, substate: (id: Station["id"]) => StationSubstate) => {
    const row = body.stations.find((entry) => entry.service === service);
    if (!row) throw new Error(`fixture has no ${service}`);
    row.stations = row.stations.map((station) => ({
      ...station,
      substate: substate(station.id),
    })) as typeof row.stations;
  };
  set("schema", (id) => (id === "lane" ? "stopped" : "ready"));
  set("file", (id) => (id === "upstream" ? "in-progress" : "waiting-on-clock"));
  set("legal", () => "waiting-on-clock");
  show(body);
  await mount();
  const names = Object.fromEntries(
    pips().map((pip) => [
      pip.dataset.service,
      [pip.title, pip.querySelector(".strip-pip-mark")?.getAttribute("data-shape")],
    ]),
  );
  expect(names).toMatchObject({
    partition: ["partition: needs a person", "filled"],
    entitlements: ["entitlements: stopped", "diamond"],
    legal: ["legal: nothing due", "hollow"],
    schema: ["schema: nothing due", "hollow"],
    file: ["file: in progress", "half"],
  });
  const mark = pips()[1]?.querySelector(".strip-pip-mark");
  if (!mark) throw new Error("Missing stopped pip mark");
  expect(getComputedStyle(mark).transform).toBe("rotate(45deg)");
});

it("holds pips, fields and panel controls beside the native window controls in one 44 px row", async () => {
  await mount();
  const row = container.querySelector<HTMLElement>(".title-bar");
  const status = strip();
  if (!row || !status) throw new Error("Missing top row");
  expect(row?.contains(strip() ?? null)).toBe(true);
  expect(row?.querySelectorAll(".panel-controls")).toHaveLength(1);
  expect(row?.querySelector("[data-sweep-line]")).not.toBeNull();
  expect(row?.querySelector("[data-place]")).toBeNull();
  expect(container.querySelector("main .place-header [data-place]")?.textContent).toBe("Today");
  expect(document.title).toBe("SPI Code · Today");
  expect(getComputedStyle(row).height).toBe("44px");
  const rowStyle = getComputedStyle(row);
  const contentHeight =
    Number.parseFloat(rowStyle.height) -
    Number.parseFloat(rowStyle.borderTopWidth || "0") -
    Number.parseFloat(rowStyle.borderBottomWidth || "0");
  expect(getComputedStyle(status).height).toBe(`${contentHeight}px`);
  for (const target of status.querySelectorAll<HTMLElement>("button, .strip-pip-target")) {
    expect(getComputedStyle(target).height).toBe(`${contentHeight}px`);
  }
  expect(container.querySelector(".shell")?.getAttribute("data-window-controls")).toBe("inset");
  expect(getComputedStyle(row).paddingLeft).toBe("84px");
  expect(row?.querySelector(".strip-line")).toBeNull();
  expect(getComputedStyle(status).flexWrap).toBe("nowrap");
});

it("renders the fields from the November 6 sweep", async () => {
  const body = fixture();
  await mount();
  const nextSync = body.briefing.nextSyncAt as string;
  expect(field("stopped")?.textContent).toBe("entitlements stopped");
  expect(field("environment")?.textContent).toBe("env v0.35.3 deployable");
  expect(field("template")?.textContent).toBe("template 0/13");
  expect(field("template")?.title).toBe("0 of 13 forks on template 7d269b5");
  expect(field("due")?.textContent).toBe(`10 due before ${clockTime(nextSync)}`);
  expect(field("next-sync")?.textContent).toBe(`next sync ${clockTime(nextSync)}`);
  expect(
    [...(strip()?.querySelectorAll<HTMLElement>("[data-field]") ?? [])].map(
      (node) => node.dataset.field,
    ),
  ).toEqual(["stopped", "environment", "template", "due", "next-sync", "freshness"]);
});

it("raises the due count when an item falls due before the next sync, and not after it", async () => {
  const body = fixture();
  const nextSync = body.briefing.nextSyncAt as string;
  const [first] = body.briefing.rest;
  if (!first) throw new Error("fixture has no rest items");
  const { due: _due, ...undated } = first;
  const before = { ...undated, id: "strip:due-before", due: { at: nextSync, before: "next sync" } };
  const later = {
    ...undated,
    id: "strip:due-later",
    due: { at: new Date(Date.parse(nextSync) + 60_000).toISOString(), before: "next sync" },
  };
  await mount();
  expect(field("due")?.textContent).toBe(`10 due before ${clockTime(nextSync)}`);
  await act(async () =>
    show({ ...body, briefing: { ...body.briefing, rest: [...body.briefing.rest, before] } }),
  );
  expect(field("due")?.textContent).toBe(`11 due before ${clockTime(nextSync)}`);
  await act(async () =>
    show({ ...body, briefing: { ...body.briefing, rest: [...body.briefing.rest, before, later] } }),
  );
  expect(field("due")?.textContent).toBe(`11 due before ${clockTime(nextSync)}`);
});

it("gives a field with no data no space", async () => {
  const body = fixture();
  for (const row of body.stations) {
    row.stations = row.stations.map((station) => ({
      ...station,
      substate: "ready",
    })) as typeof row.stations;
  }
  const undated = (items: typeof body.briefing.focus) =>
    items.map(({ due: _due, ...item }) => item);
  body.briefing = {
    ...body.briefing,
    focus: undated(body.briefing.focus),
    rest: undated(body.briefing.rest),
    facts: body.briefing.facts
      .map((fact) => (fact.label === "Environment" ? { ...fact, figure: "?" } : fact))
      .filter(({ label }) => !label.startsWith("Template")),
  };
  body.readings = body.readings.map((reading) =>
    reading.anchor.kind === "engineering" ? { ...reading, content: null } : reading,
  );
  delete body.briefing.nextSyncAt;
  expect(selectStrip(body)).toEqual({
    pips: FLEET.map((service) => ({ service, state: "nothing-due" })),
    stopped: [],
  });
  show(body);
  await mount();
  expect(strip()?.querySelectorAll("[data-field]")).toHaveLength(1);
  expect(field("freshness")).not.toBeNull();
  expect(strip()?.querySelector(".strip-line")).toBeNull();
});

function adoption(
  body: ViewSnapshot,
  marker: string,
  verifiedTemplate: NonNullable<ViewSnapshot["readings"][number]["content"]>["verifiedTemplate"],
  rollout: string,
) {
  body.briefing.facts = body.briefing.facts.map((fact) =>
    fact.label.startsWith("Template") ? { ...fact, figure: marker } : fact,
  );
  for (const reading of body.readings) {
    if (reading.anchor.kind !== "engineering" || !reading.content) continue;
    const [system, prs, state] = reading.content.tiles;
    if (verifiedTemplate) reading.content.verifiedTemplate = verifiedTemplate;
    else delete reading.content.verifiedTemplate;
    reading.content.tiles = [
      {
        ...system,
        value: verifiedTemplate
          ? `${verifiedTemplate.verified} of ${verifiedTemplate.total}`
          : "not read yet",
        counts: "forks on the target template",
      },
      prs,
      { ...state, value: rollout },
    ];
  }
  return body;
}

it.each([
  [
    "merged, main validation pending",
    "1 of 13",
    { verified: 0, total: 13, unread: 0, target: "7d269b5" },
    "In progress",
    "0/13",
  ],
  [
    "merged, main validation failed",
    "1 of 13",
    { verified: 0, total: 13, unread: 0, target: "7d269b5" },
    "Stopped",
    "0/13",
  ],
  [
    "merged and verified, another fork's marker unread",
    "1 of 12",
    { verified: 1, total: 13, unread: 1, target: "7d269b5" },
    "In progress",
    "1/13",
  ],
  [
    "one fork's marker unread",
    "0 of 12",
    { verified: 0, total: 13, unread: 1, target: "7d269b5" },
    "In progress",
    "0/13",
  ],
] as const)(
  "counts verified forks over the fleet for the template: %s",
  async (_case, marker, verifiedTemplate, rollout, shown) => {
    show(adoption(fixture(), marker, verifiedTemplate, rollout));
    await mount();
    expect(pips()).toHaveLength(13);
    expect(field("template")?.textContent).toBe(`template ${shown}`);
    expect(field("template")?.title).toBe(
      `${shown.replace("/", " of ")} forks on template 7d269b5`,
    );
  },
);

it("gives the template no space when the engineering reading is absent or not read", async () => {
  const body = fixture();
  const absent = {
    ...body,
    readings: body.readings.filter(({ anchor }) => anchor.kind !== "engineering"),
  };
  expect(selectStrip(absent).template).toBeUndefined();
  const unread = adoption(fixture(), "0 of 0", undefined, "not read yet");
  expect(selectStrip(unread).template).toBeUndefined();
  expect(
    selectStrip(
      adoption(
        fixture(),
        "0 of 0",
        {
          verified: 0,
          total: 13,
          unread: 13,
          target: "7d269b5",
        },
        "not read yet",
      ),
    ).template,
  ).toBeUndefined();
  show(absent);
  await mount();
  expect(field("template")).toBeNull();
  expect(field("environment")).not.toBeNull();
});

it("keeps typed adoption unchanged when every engineering tile's wording changes", () => {
  const body = adoption(
    fixture(),
    "9 of 12",
    {
      verified: 1,
      total: 13,
      unread: 1,
      target: `7d269b5${"a".repeat(33)}`,
    },
    "In progress",
  );
  expect(selectStrip(body).template).toEqual({ verified: 1, total: 13, target: "7d269b5" });
  const reading = body.readings.find(({ anchor }) => anchor.kind === "engineering");
  if (!reading?.content) throw new Error("Missing engineering reading");
  reading.content.tiles = reading.content.tiles.map(() => ({
    label: "Adoption",
    value: "Editorial words",
    counts: "A different description",
  })) as typeof reading.content.tiles;
  expect(selectStrip(body).template).toEqual({ verified: 1, total: 13, target: "7d269b5" });
});

it.each(["stopped", "environment", "template", "due", "next-sync"])(
  "opens the Line sheet from the %s field button",
  async (name) => {
    await mount();
    const button = field(name);
    expect(button?.tagName).toBe("BUTTON");
    expect(sheet()).toBeNull();
    await act(async () => button?.click());
    expect(sheet()).not.toBeNull();
  },
);

it("aggregates pip states into one Line button without roving tab stops", async () => {
  const body = fixture();
  for (const row of body.stations) {
    if (row.service !== "file" && row.service !== "legal") continue;
    row.stations = row.stations.map((station) => ({
      ...station,
      substate: row.service === "file" ? "in-progress" : "ready",
    })) as typeof row.stations;
  }
  show(body);
  await mount();
  const line = strip()?.querySelector<HTMLButtonElement>(".strip-pips");
  expect(line?.getAttribute("aria-label")).toBe(
    "Line: 1 stopped, 10 need a person, 1 in progress, 1 nothing due",
  );
  expect(line?.getAttribute("aria-keyshortcuts")).toBe("Meta+L");
  expect(pips().map((item) => item.tabIndex)).toEqual(FLEET.map(() => -1));
  expect(pips().every((item) => !item.hasAttribute("tabindex"))).toBe(true);
  await act(async () => line?.focus());
  expect(sheet()).toBeNull();
  await act(async () => pips()[0]?.click());
  expect(sheet()).not.toBeNull();
  await keydown(document.activeElement, { key: "Escape" });
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(line);
});

const pip = (service: string) => strip()?.querySelector<HTMLElement>(`[data-service="${service}"]`);
const menu = (service: string) =>
  document.querySelector<HTMLElement>(`[data-pin-menu="${service}"]`);
const pinned = () =>
  [...container.querySelectorAll('ul[aria-label="Pinned"] [data-sidebar-row]')].map((row) =>
    row.getAttribute("data-sidebar-row"),
  );
const keydown = (target: Element | null | undefined, init: KeyboardEventInit) =>
  act(async () => {
    target?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });

it("opens a pip's menu from its full-height hit area and pins without opening the Line sheet", async () => {
  await mount();
  const target = pip("legal");
  if (!target) throw new Error("Missing legal pip");
  expect(target?.classList.contains("strip-pip-target")).toBe(true);
  expect(getComputedStyle(target).height).toBe("44px");
  expect(getComputedStyle(target).width).toBe("12px");
  expect(target?.querySelector(".strip-pip-mark")).not.toBeNull();
  const rightClick = () =>
    act(async () => {
      pip("legal")?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }),
      );
    });
  await rightClick();
  expect(menu("legal")?.textContent).toBe("Pin legal");
  await act(async () => menu("legal")?.querySelector<HTMLElement>("[role='menuitem']")?.click());
  expect(readPins()).toEqual(["legal"]);
  expect(pinned()).toEqual(["service/legal"]);
  expect(sheet()).toBeNull();
  await rightClick();
  expect(menu("legal")?.textContent).toBe("Unpin legal");
  await act(async () => menu("legal")?.querySelector<HTMLElement>("[role='menuitem']")?.click());
  expect(readPins()).toEqual([]);
  expect(pinned()).toEqual([]);
  expect(sheet()).toBeNull();
});

it("keeps each pip menu action on its service row in the Line sheet for the keyboard path", async () => {
  await mount();
  await keydown(document.body, { key: "l", metaKey: true });
  const service = sheet()?.querySelector<HTMLButtonElement>(
    '[data-service="entitlements"] th button',
  );
  expect(service).not.toBeNull();
  await act(async () => service?.focus());
  await keydown(service, { key: "F10", shiftKey: true });
  expect(menu("entitlements")).not.toBeNull();
  expect(menu("entitlements")?.textContent).toBe("Pin entitlements");
  await act(async () =>
    menu("entitlements")?.querySelector<HTMLElement>("[role='menuitem']")?.click(),
  );
  expect(readPins()).toEqual(["entitlements"]);
  await keydown(service, { key: "ContextMenu" });
  expect(menu("entitlements")?.textContent).toBe("Unpin entitlements");
  await keydown(document.activeElement, { key: "Escape" });
  expect(menu("entitlements")).toBeNull();
  expect(sheet()).not.toBeNull();
});

it("shows the freshness glyph in the title bar and opens the sweep Evidence from it", async () => {
  const body = fixture();
  await mount();
  const glyph = container.querySelector<HTMLButtonElement>("header [data-sweep-line]");
  expect(glyph?.querySelector("[data-sweep-display]")?.textContent).toBe(
    `${clockTime(body.sweptAt)} · 1`,
  );
  expect(document.getElementById(glyph?.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
    `Swept ${clockTime(body.sweptAt)} · 1 failed, 3 not read yet`,
  );
  expect(glyph?.getAttribute("data-tone")).toBe("bad");
  expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).toBeNull();
  await act(async () => glyph?.click());
  expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).not.toBeNull();
});

const glyph = () => container.querySelector<HTMLButtonElement>("header [data-sweep-line]");
const display = () => glyph()?.querySelector("[data-sweep-display]")?.textContent;
const glyphName = () =>
  document.getElementById(glyph()?.getAttribute("aria-labelledby") ?? "")?.textContent;
const receive = (type: string, payload: unknown) =>
  act(async () =>
    watchStore
      .getState()
      .receive({ version: PROTOCOL_VERSION, id: "host", kind: "event", type, payload }),
  );

it("carries the first sweep's count and scrolls the list into view", async () => {
  const scrolled: Element[] = [];
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  vi.stubGlobal("requestAnimationFrame", (step: FrameRequestCallback) =>
    setTimeout(() => step(0), 0),
  );
  try {
    window.location.hash = "#security";
    watchStore.setState({ snapshot: null, setup: null });
    await mount();
    expect(display()).toBe("waiting for the first sweep");
    await receive("sweep.progress", midSweep());
    expect(display()).toBe("sweeping · 9 of 12");
    expect(glyphName()).toBe("First sweep · 9 of 12 sources done");
    expect(glyph()?.title).toBe("First sweep · 9 of 12 sources done");
    expect(glyph()?.dataset.tone).toBe("run");
    expect(glyph()?.querySelector(".evidence-dot")?.getAttribute("data-tone")).toBe("run");
    await act(async () => glyph()?.click());
    await act(() => new Promise((done) => setTimeout(done, 20)));
    expect(window.location.hash).toBe("#today");
    expect(scrolled).toEqual([container.querySelector(".today-first .sweep-sources")]);
    expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).toBeNull();
    await receive("sweep.progress", { ...midSweep(), outcome: "cancelled" });
    expect(display()).toBe("first sweep stopped");
  } finally {
    Element.prototype.scrollIntoView = scrollIntoView;
  }
});

it.each(["failed", "cancelled"] as const)(
  "names a %s first sweep as stopped, reveals its panel, and resumes on retry",
  async (outcome) => {
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    vi.stubGlobal("requestAnimationFrame", (step: FrameRequestCallback) =>
      setTimeout(() => step(0), 0),
    );
    window.location.hash = "#security";
    watchStore.setState({ snapshot: null, setup: null });
    await mount();
    await receive(
      "sweep.progress",
      outcome === "cancelled"
        ? {
            ...midSweep(),
            outcome,
          }
        : {
            ...midSweep(),
            outcome: "failed",
            code: "timeout",
            failure: "GitHub did not answer in time.",
            source: "radar",
            nextAttemptAt: null,
          },
    );
    expect(display()).toBe("first sweep stopped");
    expect(glyphName()).toBe("first sweep stopped");
    expect(glyph()?.title).toBe("first sweep stopped");
    expect(glyph()?.dataset.tone).toBe("bad");
    expect(glyph()?.querySelector(".evidence-dot")?.getAttribute("data-tone")).toBe("bad");
    await act(async () => glyph()?.click());
    await act(() => new Promise((done) => setTimeout(done, 20)));
    expect(window.location.hash).toBe("#today");
    expect(scrolled).toEqual([container.querySelector(".today-first")]);
    expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).toBeNull();
    const retry = container.querySelector<HTMLButtonElement>(".today-first-actions button");
    expect(retry?.textContent).toBe("Try again");
    await act(async () => retry?.click());
    expect(window.spi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sweep.request", payload: {} }),
    );
    await receive("sweep.progress", midSweep({ sweep: "sweep-2" }));
    expect(display()).toBe("sweeping · 9 of 12");
    expect(glyph()?.dataset.tone).toBe("run");
  },
);

it("keeps the sweep time over an older snapshot while a later sweep runs and opens its live list", async () => {
  const body = fixture();
  await mount();
  const later = midSweep({ first: false, sweep: "sweep-2" });
  await receive("sweep.progress", later);
  expect(display()).toBe(`${clockTime(body.sweptAt)} · sweeping 9 of 12`);
  expect(glyphName()).toBe(`Swept ${clockTime(body.sweptAt)} · sweeping, 9 of 12 sources done`);
  expect(glyph()?.dataset.tone).toBe("run");
  await act(async () => glyph()?.click());
  const evidence = () => container.querySelector('#app-right-panel [data-evidence="sweep"]');
  expect(evidence()?.querySelector("[data-sweep-list]")?.getAttribute("data-sweep-list")).toBe(
    "live",
  );
  expect(evidence()?.querySelectorAll(".sweep-row")).toHaveLength(12);
  expect(evidence()?.querySelector(".sweep-row .evidence-fact")?.textContent).toMatch(/last read/);
  await receive("sweep.progress", {
    ...later,
    outcome: "committed",
    sources: later.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? { source: source.source, state: "read", startedAt: after(120), endedAt: after(128) }
        : source,
    ),
  });
  expect(display()).toBe(`${clockTime(body.sweptAt)} · 1`);
  expect(evidence()?.querySelector("[data-sweep-list]")?.getAttribute("data-sweep-list")).toBe(
    "completed",
  );
  expect(evidence()?.querySelectorAll(".sweep-row")).toHaveLength(12);
  expect(evidence()?.querySelector(".sweep-meta")).toBeNull();
});

it("shows a newer sweep that stopped over the last completed list, with its reason and retry", async () => {
  vi.useFakeTimers({ now: Date.parse(after(130)), toFake: ["Date"] });
  await mount();
  const done = midSweep({ first: false, sweep: "sweep-2" });
  await receive("sweep.progress", {
    ...done,
    outcome: "committed",
    sources: done.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? { source: source.source, state: "read", startedAt: after(120), endedAt: after(128) }
        : source,
    ),
  });
  await act(async () => glyph()?.click());
  const list = () =>
    container.querySelector<HTMLElement>(
      '#app-right-panel [data-evidence="sweep"] [data-sweep-list]',
    );
  expect(list()?.dataset.sweepList).toBe("completed");
  const later = midSweep({ first: false, sweep: "sweep-3" });
  await receive("sweep.progress", later);
  expect(list()?.dataset.sweepList).toBe("live");
  await receive("sweep.progress", {
    ...later,
    outcome: "failed",
    code: "timeout",
    failure: "GitLab did not answer in time.",
    source: "radar",
    nextAttemptAt: "2026-11-09T08:07:00Z",
  });
  expect(list()?.dataset.sweepList).toBe("stopped");
  const outcome = list()?.querySelector('[data-sweep-outcome="failed"]');
  expect(outcome?.textContent).toMatch(
    /^This sweep stopped\. It stopped while reading .+: GitLab did not answer in time\. SPI Code tries again at /,
  );
  expect(outcome?.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-09T08:07:00Z");
  expect(list()?.querySelector<HTMLElement>('.sweep-row[data-source="radar"]')?.dataset.tone).toBe(
    "bad",
  );
  expect(list()?.querySelectorAll(".sweep-row")).toHaveLength(12);
});

it("opens each place and the Line with one line before the first snapshot, its sidebar row muted", async () => {
  window.location.hash = "#upstream";
  watchStore.setState({ snapshot: null, setup: null, progress: midSweep() });
  await mount();
  const main = () => container.querySelector("[data-before-sweep] .place-before-sweep");
  expect(container.querySelector("[data-before-sweep] h1")?.textContent).toBe("Upstream");
  expect(main()?.textContent).toBe("Upstream opens after the first sweep. It is read 9th of 12.");
  const row = (key: string) =>
    container.querySelector<HTMLElement>(`.app-sidebar [data-sidebar-row="${key}"]`);
  expect(row("upstream")?.hasAttribute("data-before-sweep")).toBe(true);
  expect(row("today")?.hasAttribute("data-before-sweep")).toBe(false);
  await act(async () => {
    window.location.hash = "#security";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(main()?.textContent).toBe("Security opens after the first sweep. It is read 11th of 12.");
  await act(async () => container.querySelector<HTMLElement>('[data-sidebar-row="line"]')?.click());
  expect(sheet()?.querySelector(".line-before-sweep")?.textContent).toBe(
    "Service rows appear after the first sweep.",
  );
  await act(async () => show(fixture()));
  expect(container.querySelector("[data-before-sweep]")).toBeNull();
  expect(sheet()?.querySelector(".line-before-sweep")).toBeNull();
  expect(row("upstream")?.hasAttribute("data-before-sweep")).toBe(false);
});

it("opens the first sweep's retained list in Evidence after hand-over", async () => {
  const body = fixture();
  watchStore.setState({ snapshot: null, setup: null });
  await mount();
  const first = midSweep();
  await receive("sweep.progress", first);
  await receive("sweep.progress", {
    ...first,
    outcome: "committed",
    sources: first.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? { source: source.source, state: "read", startedAt: after(120), endedAt: after(128) }
        : source,
    ),
  });
  await receive("view.snapshot", body);
  expect(display()).toBe(`${clockTime(body.sweptAt)} · 1`);
  await act(async () => glyph()?.click());
  const list = container.querySelector(
    '#app-right-panel [data-evidence="sweep"] [data-sweep-list]',
  );
  expect(list?.getAttribute("data-sweep-list")).toBe("completed");
  expect(list?.querySelectorAll(".sweep-row")).toHaveLength(12);
  expect(list?.querySelector('.sweep-row[data-source="upstream"]')?.textContent).toMatch(/failed/i);
});
