// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import {
  navigate,
  openSelection,
  PLACES,
  routeLabel,
  setOpenSelection,
} from "../app/navigation.js";
import { Shell } from "../app/Shell.js";
import { serviceMark } from "../components/sidebar/service-mark.js";
import { selectionStore } from "../panels/selection.js";
import { PINS_STORAGE_KEY, readPins } from "../store/pins.js";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, installSpi } from "../test-utils/harness.js";
import { WATCH_SNAPSHOTS } from "../test-utils/watch-fixtures.test-helper.js";
import snapshot1116 from "../views/today/snapshot-1116.json?raw";
import { openTodayLine } from "../views/today/Table.js";
import { buildPaletteGroups, filterPaletteGroups } from "./palette.logic.js";

const loadFixture = fixtureLoader(readFixture);

const body = loadFixture("snapshot-59d6895.json");
const previous = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  window.location.hash = "";
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(serviceIds));
  harness = installSpi();
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Shell />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  selectionStore.getState().clear();
  setOpenSelection(null);
  watchStore.setState(previous);
  harness.restore();
  window.location.hash = "";
  localStorage.removeItem(PINS_STORAGE_KEY);
  vi.restoreAllMocks();
});

const palettes = () => document.querySelectorAll('[role="dialog"][aria-label="Find or ask"]');
const palette = () =>
  document.querySelector<HTMLElement>('[role="dialog"][aria-label="Find or ask"]');
const input = () => palette()?.querySelector<HTMLInputElement>("input") ?? null;
const findField = () => container.querySelector<HTMLButtonElement>("button.find-or-ask");
const labels = () =>
  [...(palette()?.querySelectorAll(".palette-group") ?? [])].map((label) => label.textContent);
const rows = (group: string) =>
  [...(palette()?.querySelectorAll(`[data-group="${group}"] .palette-row`) ?? [])].map(
    (row) => row.textContent,
  );
const highlighted = () => palette()?.querySelector("[data-highlighted]")?.textContent;
const serviceIds = ["partition", "entitlements", "legal", "schema", "file"];
const serviceAttention = (id: string) => {
  const row = [...(palette()?.querySelectorAll('[data-group="services"] .palette-row') ?? [])].find(
    (element) => element.querySelector(".palette-label")?.textContent === id,
  );
  expect(row, `palette service ${id}`).toBeTruthy();
  return {
    mark: row?.querySelector(".sidebar-mark")?.getAttribute("aria-label") ?? null,
    word: row?.querySelector(".palette-kind")?.textContent ?? null,
    name: row?.getAttribute("aria-label") ?? null,
  };
};
async function receive(body: ViewSnapshot) {
  await act(async () =>
    watchStore.getState().receive({
      version: PROTOCOL_VERSION,
      id: `palette-snapshot-${body.cursor}`,
      kind: "event",
      type: "view.snapshot",
      payload: body,
    }),
  );
}

const shortcut = (init: KeyboardEventInit) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, ...init }));
  });
const key = (name: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    input()?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }));
  });
const hint = () => palette()?.querySelector(".palette-hint")?.textContent;
async function type(text: string) {
  const field = input();
  if (!field) throw new Error("palette is closed");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, text);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
}

it("opens one palette from Ctrl+K, ⌘K on a Mac and the sidebar's Find or ask field", async () => {
  expect(palettes()).toHaveLength(0);
  await shortcut({ ctrlKey: true });
  expect(palettes()).toHaveLength(1);
  expect(document.activeElement).toBe(input());
  await shortcut({ ctrlKey: true });
  expect(palettes()).toHaveLength(0);

  await act(async () => findField()?.click());
  expect(palettes()).toHaveLength(1);
  await shortcut({ ctrlKey: true });
  expect(palettes()).toHaveLength(0);

  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  );
  await shortcut({ ctrlKey: true });
  expect(palettes()).toHaveLength(0);
  await shortcut({ metaKey: true });
  expect(palettes()).toHaveLength(1);
  await act(async () => findField()?.click());
  await shortcut({ metaKey: true, shiftKey: true });
  expect(palettes()).toHaveLength(1);
});

it("ignores Ctrl+K while an IME is composing", async () => {
  await shortcut({ ctrlKey: true, isComposing: true });
  expect(palettes()).toHaveLength(0);
  await shortcut({ ctrlKey: true });
  await shortcut({ ctrlKey: true, isComposing: true });
  expect(palettes()).toHaveLength(1);
});

it("ignores Ctrl+K with the legacy IME keyCode 229", async () => {
  await shortcut({ ctrlKey: true, keyCode: 229 });
  expect(palettes()).toHaveLength(0);
  await shortcut({ ctrlKey: true });
  await shortcut({ ctrlKey: true, keyCode: 229 });
  expect(palettes()).toHaveLength(1);
});

it("lists Go to, Services and Today's rows from the routes and the snapshot, without lenses or Actions", async () => {
  await act(async () => findField()?.click());
  expect(labels()).toEqual(["Go to", "Services", "Blocked", "Waiting on you", "Can wait"]);
  expect(palette()?.textContent).not.toMatch(/Actions/);
  expect(rows("go-to")).toEqual([
    "Todaypage",
    "Upstreampage",
    "Environmentpage",
    "Templatepage",
    "Releasespage",
    "Securitypage",
    "SettingsReadiness",
  ]);
  expect(rows("services")).toEqual(["partition", "1entitlements", "1legal", "schema", "file"]);
  expect(rows("lenses")).toEqual([]);
  expect(palette()?.querySelector('[data-group="lenses"]')).toBeNull();
  expect(rows("blocked")).toEqual([
    "entitlements · sync halted: no filter rule for schemathesis-tests",
  ]);
  expect(rows("waiting")).toEqual([
    "legal · sync PR has a failed check",
    "osdu-spi-stack · 1 outside PR waits for workflow approval",
    "2 forks · 3 upstream provider changes to port",
  ]);
  expect(rows("can-wait")).toEqual([
    "osdu-spi · Release PRs",
    "entitlements · Test External Contribution flow",
    "osdu-spi-stack · feat: onboard Seismic Store V3",
    "osdu-spi-stack · feat: add RAFS service",
    "5 forks · Alerts in shipped code",
  ]);
});

it.each(WATCH_SNAPSHOTS)(
  "lists Today's rows one for one, in Today's order and words: %s",
  async (name) => {
    const next = loadFixture(name);
    await act(async () => watchStore.setState({ snapshot: { cursor: next.cursor, body: next } }));
    await act(async () => navigate({ kind: "today" }));
    const drawn = (selector: string) =>
      [...container.querySelectorAll(selector)].map(
        (row) =>
          `${row.querySelector(".today-row-fork")?.textContent} · ${row.querySelector(".today-row-what button")?.textContent}`,
      );
    const lines = drawn(".today-table tbody[data-line] > tr.today-row:not(.today-row--sub)");
    const causes = drawn("tr.today-row--cause");
    await shortcut({ ctrlKey: true });
    const found = [...rows("blocked"), ...rows("waiting")];
    expect(found).toEqual(lines);
    expect(found).toHaveLength(next.briefing.lines?.length ?? 0);
    expect(rows("can-wait")).toEqual(causes);
    expect(rows("can-wait")).toHaveLength(next.briefing.today?.causes?.rows.length ?? 0);
    for (const label of [...found, ...rows("can-wait")]) expect(label).not.toMatch(/\bP[0-2]\b/);
    expect(labels()).not.toContain("Queue");
  },
);

it.each([
  ["no lines or causes", false],
  ["Can wait causes and no lines", true],
])(
  "lists no Today group from a briefing with %s, and still finds places and services",
  async (_, causes) => {
    const { lines: _lines, ...briefing } = body.briefing;
    const older = ViewSnapshotSchema.parse({
      ...body,
      cursor: body.cursor + 1,
      provenance: body.provenance.filter(({ path }) => !path.startsWith("/briefing/lines/")),
      briefing: {
        ...briefing,
        ...(briefing.today && !causes ? { today: { ...briefing.today, causes: undefined } } : {}),
      },
    });
    expect(older.briefing.today?.causes?.rows.length ?? 0).toBe(causes ? 5 : 0);
    await act(async () => watchStore.setState({ snapshot: { cursor: older.cursor, body: older } }));
    await act(async () => navigate({ kind: "today" }));
    expect(container.querySelectorAll("tr.today-row--cause")).toHaveLength(0);
    await shortcut({ ctrlKey: true });
    expect(palettes()).toHaveLength(1);
    expect(labels()).toEqual(["Go to", "Services"]);
    await type("legal");
    expect(rows("services")).toEqual(["1legal"]);
    await type("Releases");
    expect(rows("go-to")).toEqual(["Releasespage"]);
  },
);

it("marks every recorded service from its home alone, with no attention word", async () => {
  await shortcut({ ctrlKey: true });
  const marks = serviceIds.map((id) => serviceAttention(id));
  expect(marks).toEqual([
    {
      mark: "Nothing waiting on you",
      word: null,
      name: "partition, Nothing waiting on you, pinned",
    },
    {
      mark: "1 blocked or waiting on you",
      word: null,
      name: "entitlements, 1 blocked or waiting on you, pinned",
    },
    { mark: "1 waiting on you", word: null, name: "legal, 1 waiting on you, pinned" },
    { mark: "Nothing waiting on you", word: null, name: "schema, Nothing waiting on you, pinned" },
    { mark: "Nothing waiting on you", word: null, name: "file, Nothing waiting on you, pinned" },
  ]);
  expect(palette()?.querySelector('[data-group="services"] .sidebar-pip')).toBeNull();
});

it("draws each service's mark as the sidebar does, from its home", async () => {
  const homes = ViewSnapshotSchema.parse(JSON.parse(snapshot1116));
  await receive({ ...homes, cursor: body.cursor + 1 });
  await shortcut({ ctrlKey: true });
  const ids = (homes.services ?? []).map(({ service }) => service);
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids)
    expect(serviceAttention(id).mark, id).toBe(serviceMark(homes, id)?.label ?? null);
});

it("omits unshipped Threads and Ask groups", async () => {
  await act(async () => findField()?.click());
  await type("legal");
  for (const group of ["threads", "ask"]) {
    const row = palette()?.querySelector(`[data-group="${group}"] .palette-row`);
    expect(row).toBeNull();
  }
  for (let step = 0; step < 6; step += 1) {
    await key("ArrowDown");
    expect(highlighted()).not.toMatch(/not available/);
  }
});

it("moves with the arrows, opens with Enter, and filters as the operator types", async () => {
  await shortcut({ ctrlKey: true });
  expect(highlighted()).toBe("Todaypage");
  await key("ArrowDown");
  await key("ArrowDown");
  await key("ArrowUp");
  expect(highlighted()).toBe("Upstreampage");

  await type("legal");
  expect(labels()).toEqual(["Services", "On legal", "Waiting on you", "Can wait"]);
  expect(rows("services")).toEqual(["1legal"]);
  expect(rows("waiting")).toEqual(["legal · sync PR has a failed check"]);
  expect(highlighted()).toBe("1legal");
  await key("Enter");
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#service/legal");
});

it("opens a service result and pins it on Ctrl+Enter, and keeps it pinned when pinned", async () => {
  localStorage.setItem(PINS_STORAGE_KEY, "[]");
  await shortcut({ ctrlKey: true });
  await type("legal");
  expect(highlighted()).toBe("1legal");
  expect(hint()).toContain("Ctrl+Enter open and pin");
  await key("Enter", { ctrlKey: true });
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#service/legal");
  expect(readPins()).toEqual(["legal"]);
  expect(container.querySelector('[data-sidebar-row="service/legal"]')).not.toBeNull();

  await shortcut({ ctrlKey: true });
  await type("Today");
  await key("Enter", { ctrlKey: true });
  expect(window.location.hash).toBe("#today");
  expect(readPins()).toEqual(["legal"]);

  await shortcut({ ctrlKey: true });
  await type("legal");
  expect(hint()).toContain("Ctrl+Enter open and pin");
  await key("Enter", { ctrlKey: true });
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#service/legal");
  expect(readPins()).toEqual(["legal"]);
  expect(container.querySelector('[data-sidebar-row="service/legal"]')).not.toBeNull();

  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  );
  await shortcut({ metaKey: true });
  await type("schema");
  expect(hint()).toContain("⌘↩ open and pin");
  await key("Enter", { ctrlKey: true });
  expect(readPins()).toEqual(["legal"]);
  expect(palettes()).toHaveLength(1);
  await key("Enter", { metaKey: true });
  expect(window.location.hash).toBe("#service/schema");
  expect(readPins()).toEqual(["legal", "schema"]);
});

it("opens each place on Ctrl+Enter, pinning only those outside the fixed block, in the order pinned", async () => {
  localStorage.setItem(PINS_STORAGE_KEY, "[]");
  const pinned = () =>
    [...container.querySelectorAll('ul[aria-label="Pinned"] .sidebar-row-label')].map(
      (label) => label.textContent,
    );
  for (const name of ["Releases", ...PLACES.map(routeLabel)]) {
    await shortcut({ ctrlKey: true });
    await type(name);
    expect(highlighted()).toBe(`${name}page`);
    await key("Enter", { ctrlKey: true });
    expect(palettes()).toHaveLength(0);
    expect(container.querySelector("main h1")?.textContent).toBe(name);
  }
  expect(readPins()).toEqual(["place:releases", "place:upstream", "place:security"]);
  expect(JSON.parse(localStorage.getItem(PINS_STORAGE_KEY) ?? "null")).toEqual(readPins());
  expect(pinned()).toEqual(["Releases", "Upstream", "Security"]);
});

it("offers no Line result in Find", async () => {
  await shortcut({ ctrlKey: true });
  await type("Line");
  expect(option("Linepage")).toBeUndefined();
});

const option = (text: string) =>
  [...(palette()?.querySelectorAll<HTMLElement>(".palette-row") ?? [])].find(
    (row) => row.textContent === text,
  );
const pinControl = (text: string) => option(text)?.querySelector<HTMLButtonElement>(".pin-control");

it("pins and unpins a result in place from its pin control, leaving Find as it was", async () => {
  await shortcut({ ctrlKey: true });
  await type("Releases");
  expect(highlighted()).toBe("Releasespage");
  expect(option("Releasespage")?.getAttribute("aria-label")).toBe("Releases, page, not pinned");
  const control = pinControl("Releasespage");
  expect(control?.tabIndex).toBe(-1);
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  control?.dispatchEvent(press);
  expect(press.defaultPrevented).toBe(true);
  expect(control?.getAttribute("aria-label")).toBe("Pin Releases to sidebar (Ctrl+Shift+P)");
  await act(async () => control?.click());
  expect(readPins()).toContain("place:releases");
  expect(container.querySelector('[data-sidebar-row="releases"]')).not.toBeNull();
  expect(palettes()).toHaveLength(1);
  expect(input()?.value).toBe("Releases");
  expect(highlighted()).toBe("Releasespage");
  expect(document.activeElement).toBe(input());
  expect(window.location.hash).toBe("");
  expect(option("Releasespage")?.getAttribute("aria-label")).toBe("Releases, page, pinned");

  await act(async () => pinControl("Releasespage")?.click());
  expect(readPins()).not.toContain("place:releases");
  expect(option("Releasespage")?.getAttribute("aria-label")).toBe("Releases, page, not pinned");
  await act(async () => pinControl("Releasespage")?.click());
  await key("Enter", { ctrlKey: true });
  expect(window.location.hash).toBe("#releases");
  expect(readPins().filter((id) => id === "place:releases")).toHaveLength(1);

  await shortcut({ ctrlKey: true });
  await type("legal");
  expect(option("1legal")?.getAttribute("aria-label")).toBe("legal, 1 waiting on you, pinned");
  await act(async () => pinControl("1legal")?.click());
  expect(readPins()).not.toContain("legal");
  expect(container.querySelector('[data-sidebar-row="service/legal"]')).toBeNull();
  expect(option("1legal")?.getAttribute("aria-label")).toBe("legal, 1 waiting on you, not pinned");
  expect(palettes()).toHaveLength(1);
  expect(window.location.hash).toBe("#releases");
});

it("draws no pin control on Environment or Template, and none on Today's rows", async () => {
  await shortcut({ ctrlKey: true });
  for (const [query, text, name] of [
    ["Environment", "Environmentpage", "Environment"],
    ["Template", "Templatepage", "Template"],
  ] as const) {
    await type(query);
    expect(option(text)?.getAttribute("aria-label")).toBe(`${name}, page, always in the sidebar`);
    expect(pinControl(text)).toBeNull();
  }
  await type("Releases");
  expect(pinControl("Releasespage")).not.toBeNull();
  await type("schemathesis");
  const line = palette()?.querySelector<HTMLElement>('[data-group="blocked"] .palette-row');
  expect(line).toBeTruthy();
  expect(line?.querySelector(".pin-control")).toBeNull();
  expect(line?.hasAttribute("aria-label")).toBe(false);
});

it("pins and unpins the highlighted result in place on Ctrl+Shift+P, and nothing on a fixed one", async () => {
  await shortcut({ ctrlKey: true });
  await type("Releases");
  expect(hint()).toContain("Ctrl+Shift+P pin");
  await key("P", { ctrlKey: true, shiftKey: true });
  expect(readPins()).toContain("place:releases");
  expect(option("Releasespage")?.getAttribute("aria-label")).toBe("Releases, page, pinned");
  expect(palettes()).toHaveLength(1);
  expect(input()?.value).toBe("Releases");
  expect(highlighted()).toBe("Releasespage");
  expect(document.activeElement).toBe(input());
  expect(window.location.hash).toBe("");
  await key("P", { ctrlKey: true, shiftKey: true });
  expect(readPins()).not.toContain("place:releases");
  await type("Environment");
  const before = localStorage.getItem(PINS_STORAGE_KEY);
  await key("P", { ctrlKey: true, shiftKey: true });
  expect(localStorage.getItem(PINS_STORAGE_KEY)).toBe(before);
  expect(window.location.hash).toBe("");

  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  );
  await type("legal");
  expect(hint()).toContain("⌘⇧P pin");
  await key("p", { metaKey: true, shiftKey: true });
  expect(readPins()).not.toContain("legal");
  expect(palettes()).toHaveLength(1);
});

it("finds every place and every service of the Nov 6 fleet", async () => {
  const next = loadFixture("snapshot-1106.json");
  await act(async () => watchStore.setState({ snapshot: { cursor: next.cursor, body: next } }));
  await shortcut({ ctrlKey: true });
  const found = (group: string) =>
    [...(palette()?.querySelectorAll(`[data-group="${group}"] .palette-label`) ?? [])].map(
      (row) => row.textContent,
    );
  expect(found("go-to")).toEqual(expect.arrayContaining(PLACES.map(routeLabel)));
  expect(found("services")).toEqual(next.stations.map(({ service }) => service));
  expect(found("services")).toHaveLength(13);
});

it("lets Enter confirm an IME composition without choosing a row", async () => {
  await shortcut({ ctrlKey: true });
  await type("legal");
  const field = input();
  const enter = (init: KeyboardEventInit) =>
    act(async () => {
      field?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init }));
    });
  await act(async () => {
    field?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  await enter({ isComposing: true, keyCode: 13 });
  expect(palettes()).toHaveLength(1);
  await enter({ keyCode: 229 });
  expect(palettes()).toHaveLength(1);
  expect(window.location.hash).toBe("");

  await act(async () => {
    field?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
  });
  await enter({ keyCode: 13 });
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#service/legal");
});

it.each([
  ["schemathesis", "blocked", "blocked:halt:crs-conversion", "halt:crs-conversion"],
  ["Integration PR red", "waiting", "waiting:blocker:stack:lanes:gate2", undefined],
  ["os-core-common upgraded", "waiting", "waiting:upgrade:os-core-common", undefined],
  ["indexer-queue", "waiting", "waiting:blocker:stack:lanes:gate2", undefined],
])("opens a line's own row in place on Today: %s", async (query, group, line, member) => {
  const nov16 = ViewSnapshotSchema.parse(JSON.parse(snapshot1116));
  await act(async () => watchStore.setState({ snapshot: { cursor: nov16.cursor, body: nov16 } }));
  await act(async () => navigate({ kind: "upstream" }));
  const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  await shortcut({ ctrlKey: true });
  await type(query);
  const option = palette()?.querySelector<HTMLElement>(`[data-group="${group}"] .palette-row`);
  expect(option).toBeTruthy();
  await act(async () => option?.click());
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#today");
  const open = [...container.querySelectorAll<HTMLElement>("tr.today-row[data-open]")];
  expect(open).toHaveLength(1);
  expect(open[0]?.dataset.lineId).toBe(line);
  expect(open[0]?.dataset.itemId).toBe(member);
  expect(open[0]?.classList.contains("today-row--sub")).toBe(false);
  expect(scrolled.mock.contexts).toContain(open[0]);
  expect(selectionStore.getState().selected).toBeNull();
});

it("opens a rollout line of one fork on its group row, as Today draws it", async () => {
  const next = loadFixture("snapshot-1106.json");
  const lines = (next.briefing.lines ?? []).map((line) =>
    line.rollout ? { ...line, members: line.members.slice(0, 1) } : line,
  );
  const rollout = lines.find((line) => line.rollout);
  expect(rollout?.members).toHaveLength(1);
  const one = { ...next, briefing: { ...next.briefing, lines } };
  await act(async () => watchStore.setState({ snapshot: { cursor: one.cursor, body: one } }));
  await shortcut({ ctrlKey: true });
  await type("not synced yet");
  await key("Enter");
  const open = [...container.querySelectorAll<HTMLElement>("tr.today-row[data-open]")];
  expect(open).toHaveLength(1);
  expect(open[0]?.dataset.lineId).toBe(rollout?.id);
  expect(open[0]?.dataset.itemId).toBeUndefined();
  expect(open[0]?.classList.contains("today-row--sub")).toBe(false);
});

it("opens a Can wait row in place on Today", async () => {
  await act(async () => navigate({ kind: "today", tab: "forks" }));
  await shortcut({ ctrlKey: true });
  await type("RAFS");
  expect(rows("can-wait")).toEqual(["osdu-spi-stack · feat: add RAFS service"]);
  await key("Enter");
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#today");
  const open = [...container.querySelectorAll<HTMLElement>("tr.today-row[data-open]")];
  expect(open).toHaveLength(1);
  expect(open[0]?.dataset.row).toBe("other:feat%3A%20add%20rafs%20service");
});

it("lands on Today with nothing open when the chosen line or cause has gone", async () => {
  await act(async () => navigate({ kind: "upstream" }));
  await act(async () => openTodayLine(body.briefing.lines, "waiting:gone"));
  expect(window.location.hash).toBe("#today");
  expect(openSelection()).toBeNull();
  expect(container.querySelector("tr.today-row[data-open]")).toBeNull();

  await shortcut({ ctrlKey: true });
  await type("RAFS");
  const gone = {
    ...body,
    cursor: body.cursor + 1,
    briefing: {
      ...body.briefing,
      today: body.briefing.today && {
        ...body.briefing.today,
        causes: body.briefing.today.causes && { ...body.briefing.today.causes, rows: [] },
      },
    },
  };
  const option = palette()?.querySelector<HTMLElement>('[data-group="can-wait"] .palette-row');
  await act(async () => watchStore.setState({ snapshot: { cursor: gone.cursor, body: gone } }));
  await act(async () => option?.click());
  expect(window.location.hash).toBe("#today");
  expect(openSelection()).toBeNull();
});

it("closes on Escape and returns focus to the control that opened it", async () => {
  const field = findField();
  await act(async () => {
    field?.focus();
    field?.click();
  });
  expect(document.activeElement).toBe(input());
  await key("Escape");
  expect(palettes()).toHaveLength(0);
  expect(document.activeElement).toBe(field);
});

it("ranks the best match class first and keeps group order on ties", () => {
  const groups = buildPaletteGroups(body);
  expect(filterPaletteGroups(groups, "").map(({ value }) => value)).toEqual([
    "go-to",
    "services",
    "blocked",
    "waiting",
    "can-wait",
  ]);
  expect(filterPaletteGroups(groups, "ENTITLE").map(({ value }) => value)).toEqual([
    "services",
    "on:entitlements",
    "blocked",
    "can-wait",
  ]);
  expect(
    filterPaletteGroups(groups, "flow").flatMap(({ items }) => items.map((i) => i.label)),
  ).toEqual([
    "PR #49 · Test External Contribution flow",
    "entitlements · Test External Contribution flow",
    "osdu-spi-stack · 1 outside PR waits for workflow approval",
  ]);
  expect(filterPaletteGroups(groups, "nothing like this")).toEqual([]);
});

it("Escape closes only the palette above a place popover and returns focus inside it", async () => {
  await act(async () => navigate({ kind: "upstream" }));
  await act(async () => container.querySelector<HTMLButtonElement>(".place-item-content")?.click());
  const popover = container.querySelector<HTMLElement>(".popover");
  const control = popover?.querySelector<HTMLButtonElement>("button");
  expect(control).toBeTruthy();
  control?.focus();
  const selection = openSelection();
  await shortcut({ ctrlKey: true });
  expect(document.activeElement).toBe(input());
  await key("Escape");
  expect(palettes()).toHaveLength(0);
  expect(openSelection()).toEqual(selection);
  expect(container.querySelector(".popover")).toBe(popover);
  expect(document.activeElement).toBe(control);
});

it.each([
  ["#77", "pulls", "77"],
  ["missing or unresolvable owners", "issues", "65"],
])("finds service work under Search and opens the row in place: %s", async (query, tab, number) => {
  const nov16 = ViewSnapshotSchema.parse(JSON.parse(snapshot1116));
  await act(async () => watchStore.setState({ snapshot: { cursor: nov16.cursor, body: nov16 } }));
  await shortcut({ ctrlKey: true });
  await type(query);
  const result = [
    ...(palette()?.querySelectorAll<HTMLElement>('[data-group="on:search"] .palette-row') ?? []),
  ].find((option) => option.textContent?.includes(`#${number}`));
  expect(result).toBeDefined();
  await act(async () => result?.click());
  expect(window.location.hash).toBe(`#service/search/${tab}/${number}`);
  expect(
    container.querySelector(
      `[role="tabpanel"] [data-row="${number}"] button[aria-expanded="true"]`,
    ),
  ).not.toBeNull();
});

it("offers the built tabs with their tab counts and keeps the companion out of Find", async () => {
  const nov16 = ViewSnapshotSchema.parse(JSON.parse(snapshot1116));
  await act(async () => watchStore.setState({ snapshot: { cursor: nov16.cursor, body: nov16 } }));
  await act(async () => navigate({ kind: "service", id: "search" }));
  await shortcut({ ctrlKey: true });
  await type("search");
  const group = palette()?.querySelector('[data-group="on:search"]');
  expect(group?.textContent).toContain("PR #77");
  expect(group?.textContent).not.toContain("Issue #78");
  const countedTabs = ["upstream", "pulls", "issues", "runs", "security"];
  expect(
    [...(group?.querySelectorAll(".palette-row") ?? [])]
      .slice(-countedTabs.length)
      .map((row) => row.textContent),
  ).toEqual(
    countedTabs.map(
      (tab) => container.querySelector(`[role="tab"][data-tab="${tab}"]`)?.textContent,
    ),
  );
});

it("opens the highlighted PR on GitHub with Command+Enter", async () => {
  const nov16 = ViewSnapshotSchema.parse(JSON.parse(snapshot1116));
  await act(async () => watchStore.setState({ snapshot: { cursor: nov16.cursor, body: nov16 } }));
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  );
  await shortcut({ metaKey: true });
  await type("#77");
  for (const _ of palette()?.querySelectorAll(".palette-row") ?? []) {
    if (highlighted()?.includes("PR #77")) break;
    await key("ArrowDown");
  }
  expect(highlighted()).toContain("PR #77");
  await key("Enter", { metaKey: true });
  expect(window.spi?.openExternal).toHaveBeenCalledWith(
    "https://github.com/Azure/osdu-spi-search/pull/77",
  );
  expect(window.location.hash).not.toContain("/pulls/");
});
