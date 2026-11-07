// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-59d6895.json?raw";
import fleet from "../../../../fixtures/watch/snapshot-1106.json?raw";
import { PLACES, routeLabel } from "../app/navigation.js";
import { Shell } from "../app/Shell.js";
import { selectionStore } from "../panels/selection.js";
import { PINS_STORAGE_KEY, readPins } from "../store/pins.js";
import { watchStore } from "../store/watch.js";
import { buildPaletteGroups, filterPaletteGroups } from "./palette.logic.js";

const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
const previous = watchStore.getState();
const previousSpi = window.spi;
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  window.location.hash = "";
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(serviceIds));
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
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
  watchStore.setState(previous);
  window.spi = previousSpi;
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
const serviceAttention = (id: string, surface: "palette" | "sidebar" = "palette") => {
  const row =
    surface === "palette"
      ? [...(palette()?.querySelectorAll('[data-group="services"] .palette-row') ?? [])].find(
          (element) => element.querySelector(".palette-label")?.textContent === id,
        )
      : container.querySelector(`[data-sidebar-row="service/${id}"]`);
  expect(row, `${surface} service ${id}`).toBeTruthy();
  const dot = row?.querySelector(".sidebar-attention-dot");
  return {
    dot: dot?.getAttribute("data-attention") ?? null,
    priority: dot?.getAttribute("aria-label") ?? null,
    word:
      row?.querySelector(surface === "palette" ? ".palette-kind" : ".sidebar-row-note")
        ?.textContent ?? null,
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
    "Upstreampage",
    "Environmentpage",
    "Engineering systempage",
    "Releasespage",
    "Securitypage",
    "Setuppage",
  ]);
  expect(rows("services")).toEqual([
    "partitionunread",
    "entitlementshalt",
    "legaltoolchain",
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

it("mirrors every recorded service's sidebar attention dot and word, not counts", async () => {
  await shortcut({ ctrlKey: true });
  const marks = serviceIds.map((id) => serviceAttention(id));
  expect(marks).toEqual([
    { dot: "unread", priority: "Unread", word: "unread" },
    { dot: "p0", priority: "P0", word: "halt" },
    { dot: "p1", priority: "P1", word: "toolchain" },
    { dot: "unread", priority: "Unread", word: "unread" },
    { dot: "unread", priority: "Unread", word: "unread" },
  ]);
  expect(marks).toEqual(serviceIds.map((id) => serviceAttention(id, "sidebar")));
  expect(palette()?.querySelector('[data-group="services"] .sidebar-pip')).toBeNull();
});

it("uses hollow for empty unread scopes and no dot for empty read scopes", async () => {
  const next = structuredClone(body);
  next.cursor += 1;
  next.tree = next.tree.map((node) =>
    node.id === "service:file" ? { ...node, status: "fresh" } : node,
  );
  await receive(next);
  await shortcut({ ctrlKey: true });
  expect(serviceAttention("partition")).toEqual({
    dot: "unread",
    priority: "Unread",
    word: "unread",
  });
  expect(serviceAttention("file")).toEqual({ dot: null, priority: null, word: null });
  for (const id of serviceIds) {
    expect(serviceAttention(id)).toEqual(serviceAttention(id, "sidebar"));
  }
});

it.each([false, true])(
  "retains sidebar attention across failed reads while the palette is open: %s",
  async (open) => {
    const read = structuredClone(body);
    read.cursor += 1;
    read.tree = read.tree.map((node) =>
      node.id === "service:file" ? { ...node, status: "fresh" } : node,
    );
    await receive(read);
    if (open) await shortcut({ ctrlKey: true });
    const before = serviceIds.map((id) => serviceAttention(id, "sidebar"));
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
    expect(serviceIds.map((id) => serviceAttention(id, "sidebar"))).toEqual(before);
    await key("Escape");
    await shortcut({ ctrlKey: true });
    expect(serviceIds.map((id) => serviceAttention(id))).toEqual(before);

    await receive({
      ...read,
      cursor: failed.cursor + 1,
      tree: read.tree.map((node) => ({ ...node, status: "fresh" })),
    });
    expect(serviceAttention("partition")).toEqual({ dot: null, priority: null, word: null });
    expect(serviceAttention("entitlements")).toEqual({ dot: "p0", priority: "P0", word: "halt" });
    for (const id of serviceIds) {
      expect(serviceAttention(id)).toEqual(serviceAttention(id, "sidebar"));
    }
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
  expect(highlighted()).toBe("Upstreampage");
  await key("ArrowDown");
  await key("ArrowUp");
  expect(highlighted()).toBe("Upstreampage");

  await type("legal");
  expect(labels()).toEqual(["Services", "Queue"]);
  expect(rows("services")).toEqual(["legaltoolchain"]);
  expect(rows("queue")).toEqual(["P1legal · Sync PR #31 fails Java BuildP1"]);
  expect(highlighted()).toBe("legaltoolchain");
  await key("Enter");
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#service/legal");
});

it("opens a service result and pins it on Ctrl+Enter, and keeps it pinned when pinned", async () => {
  localStorage.setItem(PINS_STORAGE_KEY, "[]");
  await shortcut({ ctrlKey: true });
  await type("legal");
  expect(highlighted()).toBe("legaltoolchain");
  expect(hint()).toContain("Ctrl+Enter open and pin");
  await key("Enter", { ctrlKey: true });
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#service/legal");
  expect(readPins()).toEqual(["legal"]);
  expect(container.querySelector('[data-sidebar-row="service/legal"]')).not.toBeNull();

  await shortcut({ ctrlKey: true });
  await type("Releases");
  await key("Enter", { ctrlKey: true });
  expect(window.location.hash).toBe("#releases");
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

it("finds every place and every service of the Nov 6 fleet", async () => {
  const next = ViewSnapshotSchema.parse(JSON.parse(fleet));
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

it("selects a Queue row's item on Today", async () => {
  await shortcut({ ctrlKey: true });
  await type("schemathesis");
  expect(highlighted()).toBe("P0entitlements · Sync halted on schemathesis-testsP0");
  await key("Enter");
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#today");
  expect(watchStore.getState().selection?.id).toBe("halt:entitlements");
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

it("closes only the palette on Escape while the right panel is open", async () => {
  await act(async () => selectionStore.getState().setOpen(true));
  await shortcut({ ctrlKey: true });
  expect(palettes()).toHaveLength(1);
  await key("Escape");
  expect(palettes()).toHaveLength(0);
  expect(selectionStore.getState().open).toBe(true);
  expect(container.querySelector("#app-right-panel")).not.toBeNull();
  container.querySelector<HTMLButtonElement>('#app-right-panel [role="tab"]')?.focus();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(selectionStore.getState().open).toBe(false);
  await act(async () => selectionStore.getState().setOpen(true));
});

it("closes only the palette on Escape when opened from inside the right panel", async () => {
  await act(async () => selectionStore.getState().setOpen(true));
  const detail = container.querySelector<HTMLButtonElement>('#app-right-panel [role="tab"]');
  if (!detail) throw new Error("Missing Detail tab");
  detail.focus();
  await shortcut({ ctrlKey: true });
  expect(palettes()).toHaveLength(1);
  expect(document.activeElement).toBe(input());
  await key("Escape");
  expect(palettes()).toHaveLength(0);
  expect(selectionStore.getState().open).toBe(true);
  expect(container.querySelector("#app-right-panel")).not.toBeNull();
  expect(document.activeElement).toBe(detail);
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
