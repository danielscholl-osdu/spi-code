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
import snapshot1116 from "../views/today/snapshot-1116.json?raw";
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

it("lists Go to, Services and Queue from the routes and the snapshot, without lenses or Actions", async () => {
  await act(async () => findField()?.click());
  expect(labels()).toEqual(["Go to", "Services", "Queue"]);
  expect(palette()?.textContent).not.toMatch(/Actions/);
  expect(rows("go-to")).toEqual([
    "Todaypage",
    "Linepage",
    "Upstreampage",
    "Environmentpage",
    "Templatepage",
    "Releasespage",
    "Securitypage",
    "SettingsReadiness",
  ]);
  expect(rows("services")).toEqual([
    "partitionunread",
    "1entitlementshalt",
    "1legaltoolchain",
    "schemaunread",
    "fileunread",
  ]);
  expect(rows("lenses")).toEqual([]);
  expect(palette()?.querySelector('[data-group="lenses"]')).toBeNull();
  expect(rows("queue")).toEqual([
    "P0Environment · Maintenance modeP0",
    "P0entitlements · Sync halted on schemathesis-testsP0",
    "P1fleet · Rollout to template bb49a03P1",
    "P1legal · Sync PR #31 fails Java BuildP1",
    "P1osdu-spi-stack · 1 outside PR waits for workflow approvalP1",
    "P12 forks · 3 upstream provider changes not portedP1",
  ]);
});

it("marks every recorded service from its home, beside its queue attention word", async () => {
  await shortcut({ ctrlKey: true });
  const marks = serviceIds.map((id) => serviceAttention(id));
  expect(marks).toEqual([
    { mark: "Nothing waiting on you", word: "unread" },
    { mark: "1 blocked or waiting on you", word: "halt" },
    { mark: "1 waiting on you", word: "toolchain" },
    { mark: "Nothing waiting on you", word: "unread" },
    { mark: "Nothing waiting on you", word: "unread" },
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

it("words empty unread scopes and leaves empty read scopes unworded", async () => {
  const next = structuredClone(body);
  next.cursor += 1;
  next.tree = next.tree.map((node) =>
    node.id === "service:file" ? { ...node, status: "fresh" } : node,
  );
  await receive(next);
  await shortcut({ ctrlKey: true });
  expect(serviceAttention("partition").word).toBe("unread");
  expect(serviceAttention("file").word).toBeNull();
});

it.each([false, true])(
  "retains service attention across failed reads while the palette is open: %s",
  async (open) => {
    const read = structuredClone(body);
    read.cursor += 1;
    read.tree = read.tree.map((node) =>
      node.id === "service:file" ? { ...node, status: "fresh" } : node,
    );
    await receive(read);
    await shortcut({ ctrlKey: true });
    const before = serviceIds.map((id) => serviceAttention(id));
    if (!open) await key("Escape");
    const failed = structuredClone(read);
    failed.cursor += 1;
    failed.tree = failed.tree.map((node) => ({ ...node, status: "failed" }));
    failed.areas = failed.areas.map((area) => ({
      ...area,
      envelope: {
        ...area.envelope,
        state: "failed",
        completeness: area.envelope.completeness ?? { kind: "complete" },
      },
    }));
    failed.briefing.focus = failed.briefing.focus.map((item) => ({
      ...item,
      scope: "Environment",
      cls: "READY",
    }));
    failed.briefing.rest = failed.briefing.rest.map((item) => ({
      ...item,
      scope: "Environment",
      cls: "READY",
    }));
    await receive(failed);
    if (!open) await shortcut({ ctrlKey: true });
    expect(serviceIds.map((id) => serviceAttention(id))).toEqual(before);
    await key("Escape");
    await shortcut({ ctrlKey: true });
    expect(serviceIds.map((id) => serviceAttention(id))).toEqual(before);

    await receive({
      ...read,
      cursor: failed.cursor + 1,
      tree: read.tree.map((node) => ({ ...node, status: "fresh" })),
    });
    expect(serviceAttention("partition").word).toBeNull();
    expect(serviceAttention("entitlements").word).toBe("halt");
  },
);

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
  expect(highlighted()).toBe("Linepage");
  await key("ArrowDown");
  await key("ArrowDown");
  await key("ArrowUp");
  expect(highlighted()).toBe("Upstreampage");

  await type("legal");
  expect(labels()).toEqual(["Services", "Queue"]);
  expect(rows("services")).toEqual(["1legaltoolchain"]);
  expect(rows("queue")).toEqual(["P1legal · Sync PR #31 fails Java BuildP1"]);
  expect(highlighted()).toBe("1legaltoolchain");
  await key("Enter");
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#service/legal");
});

it("opens a service result and pins it on Ctrl+Enter, and keeps it pinned when pinned", async () => {
  localStorage.setItem(PINS_STORAGE_KEY, "[]");
  await shortcut({ ctrlKey: true });
  await type("legal");
  expect(highlighted()).toBe("1legaltoolchain");
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

it("opens Line and each place on Ctrl+Enter, pinning only those outside the fixed block, in the order pinned", async () => {
  localStorage.setItem(PINS_STORAGE_KEY, "[]");
  const pinned = () =>
    [...container.querySelectorAll('ul[aria-label="Pinned"] .sidebar-row-label')].map(
      (label) => label.textContent,
    );
  for (const name of ["Releases", "Line", ...PLACES.map(routeLabel)]) {
    await shortcut({ ctrlKey: true });
    await type(name);
    expect(highlighted()).toBe(`${name}page`);
    await key("Enter", { ctrlKey: true });
    expect(palettes()).toHaveLength(0);
    if (name === "Line")
      expect(container.querySelector("#app-line-sheet h1")?.textContent).toBe("Line");
    else expect(container.querySelector("main h1")?.textContent).toBe(name);
  }
  expect(readPins()).toEqual(["place:releases", "place:upstream", "place:security"]);
  expect(JSON.parse(localStorage.getItem(PINS_STORAGE_KEY) ?? "null")).toEqual(readPins());
  expect(pinned()).toEqual(["Releases", "Upstream", "Security"]);
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
  expect(option("1legaltoolchain")?.getAttribute("aria-label")).toBe(
    "legal, 1 waiting on you, toolchain, pinned",
  );
  await act(async () => pinControl("1legaltoolchain")?.click());
  expect(readPins()).not.toContain("legal");
  expect(container.querySelector('[data-sidebar-row="service/legal"]')).toBeNull();
  expect(option("1legaltoolchain")?.getAttribute("aria-label")).toBe(
    "legal, 1 waiting on you, toolchain, not pinned",
  );
  expect(palettes()).toHaveLength(1);
  expect(window.location.hash).toBe("#releases");
});

it("draws no pin control on Line, Environment or Template, and none on Queue results", async () => {
  await shortcut({ ctrlKey: true });
  for (const [query, text, name] of [
    ["Line", "Linepage", "Line"],
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
  const queue = palette()?.querySelector<HTMLElement>('[data-group="queue"] .palette-row');
  expect(queue).toBeTruthy();
  expect(queue?.querySelector(".pin-control")).toBeNull();
  expect(queue?.hasAttribute("aria-label")).toBe(false);
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
  ["schemathesis", "blocked:halt:crs-conversion", "halt:crs-conversion", false],
  ["PR #90 is red", "waiting:blocker:stack:lanes:gate2", "gate2:legal", true],
  ["PR #50 carries", "waiting:upgrade:os-core-common", "gate1:unit", true],
  ["Re-run 5 checks", "waiting:blocker:stack:lanes:gate2", undefined, false],
])("opens a Queue result's row in place on Today: %s", async (query, line, member, sub) => {
  const nov16 = ViewSnapshotSchema.parse(JSON.parse(snapshot1116));
  await act(async () => watchStore.setState({ snapshot: { cursor: nov16.cursor, body: nov16 } }));
  await act(async () => navigate({ kind: "upstream" }));
  const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  await shortcut({ ctrlKey: true });
  await type(query);
  await key("Enter");
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#today");
  const open = [...container.querySelectorAll<HTMLElement>("tr.today-row[data-open]")];
  expect(open).toHaveLength(1);
  expect(open[0]?.dataset.lineId).toBe(line);
  expect(open[0]?.dataset.itemId).toBe(member);
  expect(open[0]?.classList.contains("today-row--sub")).toBe(sub);
  expect(scrolled.mock.contexts).toContain(open[0]);
  expect(selectionStore.getState().selected).toBeNull();
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
    "queue",
  ]);
  expect(filterPaletteGroups(groups, "ENTITLE").map(({ value }) => value)).toEqual([
    "services",
    "queue",
  ]);
  expect(
    filterPaletteGroups(groups, "flow").flatMap(({ items }) => items.map((i) => i.label)),
  ).toEqual(["osdu-spi-stack · 1 outside PR waits for workflow approval"]);
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
