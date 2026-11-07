// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
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
import { clock } from "../evidence/words.js";

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
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

const strip = () => container.querySelector<HTMLElement>(".window-strip [data-strip]");
const field = (name: string) => strip()?.querySelector<HTMLElement>(`[data-field="${name}"]`);
const pips = () => [...(strip()?.querySelectorAll<HTMLElement>("[data-pip]") ?? [])];
const sheet = () => container.querySelector(".line-sheet");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Mac OS X)");
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("draws one pip per service in fleet order, partition first", async () => {
  await mount();
  const services = pips().map((pip) => pip.dataset.service);
  expect(services).toEqual(FLEET);
  expect(services[0]).toBe("partition");
});

it("names each pip by its service and its state in words, the worst line station winning", async () => {
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
    pips().map((pip) => [pip.dataset.service, [pip.getAttribute("aria-label"), pip.textContent]]),
  );
  expect(names).toMatchObject({
    partition: ["partition: needs a person", "!"],
    entitlements: ["entitlements: stopped", "✕"],
    legal: ["legal: nothing due", "○"],
    schema: ["schema: nothing due", "○"],
    file: ["file: in progress", "◐"],
  });
  expect(strip()?.querySelector('[aria-label="Services"]')).not.toBeNull();
});

it("renders the fields from the November 6 sweep", async () => {
  const body = fixture();
  await mount();
  const nextSync = body.briefing.nextSyncAt as string;
  expect(field("stopped")?.textContent).toBe("entitlements stopped");
  expect(field("environment")?.textContent).toBe("env v0.35.3 deployable");
  expect(field("template")?.textContent).toBe("template 0/13");
  expect(field("template")?.title).toBe("0 of 13 forks on template 7d269b5");
  expect(field("due")?.textContent).toBe(`10 due before ${clock(nextSync)}`);
  expect(field("next-sync")?.textContent).toBe(`next sync ${clock(nextSync)}`);
  expect(
    [...(strip()?.querySelectorAll<HTMLElement>("[data-field]") ?? [])].map(
      (node) => node.dataset.field,
    ),
  ).toEqual(["stopped", "environment", "template", "due", "next-sync"]);
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
  expect(field("due")?.textContent).toBe(`10 due before ${clock(nextSync)}`);
  await act(async () =>
    show({ ...body, briefing: { ...body.briefing, rest: [...body.briefing.rest, before] } }),
  );
  expect(field("due")?.textContent).toBe(`11 due before ${clock(nextSync)}`);
  await act(async () =>
    show({ ...body, briefing: { ...body.briefing, rest: [...body.briefing.rest, before, later] } }),
  );
  expect(field("due")?.textContent).toBe(`11 due before ${clock(nextSync)}`);
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
  expect(strip()?.querySelectorAll("[data-field]")).toHaveLength(0);
  expect(strip()?.textContent).toBe(`${"○".repeat(13)}Line ⌘L`);
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

it("opens the Line sheet from the strip and from its Line button", async () => {
  await mount();
  expect(sheet()).toBeNull();
  await act(async () => field("environment")?.click());
  expect(sheet()).not.toBeNull();
  closeSheet();
  await act(async () => {});
  expect(sheet()).toBeNull();
  const line = strip()?.querySelector<HTMLButtonElement>("button");
  expect(line?.textContent).toBe("Line ⌘L");
  await act(async () => line?.click());
  expect(sheet()).not.toBeNull();
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

it("pins and unpins a service from its pip's context menu without opening the Line sheet", async () => {
  await mount();
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

it("moves between pips with the arrows and opens a pip's menu from the keyboard, Escape closing it", async () => {
  await mount();
  expect(pips().map((item) => item.tabIndex)).toEqual(FLEET.map((_, index) => (index ? -1 : 0)));
  await act(async () => pips()[0]?.focus());
  await keydown(pips()[0], { key: "ArrowRight" });
  await keydown(document.activeElement, { key: "ArrowRight" });
  expect(document.activeElement).toBe(pip("legal"));
  expect(pip("legal")?.tabIndex).toBe(0);
  expect(pip("partition")?.tabIndex).toBe(-1);
  await keydown(document.activeElement, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(pip("entitlements"));
  await keydown(pip("entitlements"), { key: "F10", shiftKey: true });
  expect(menu("entitlements")).not.toBeNull();
  await keydown(document.activeElement, { key: "Escape" });
  expect(menu("entitlements")).toBeNull();
  await keydown(pip("entitlements"), { key: "F10" });
  expect(menu("entitlements")).toBeNull();
  await keydown(pip("entitlements"), { key: "ContextMenu" });
  expect(menu("entitlements")?.textContent).toBe("Pin entitlements");
  await keydown(document.activeElement, { key: "Escape" });
  expect(menu("entitlements")).toBeNull();
  expect(sheet()).toBeNull();
});

it("shows the freshness glyph in the title bar and opens the sweep Evidence from it", async () => {
  const body = fixture();
  await mount();
  const glyph = container.querySelector<HTMLButtonElement>("header [data-sweep-line]");
  expect(glyph?.textContent).toBe(`swept ${clock(body.sweptAt)} · ⌀ 1 source failed`);
  expect(glyph?.getAttribute("data-tone")).toBe("bad");
  expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).toBeNull();
  await act(async () => glyph?.click());
  expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).not.toBeNull();
});
