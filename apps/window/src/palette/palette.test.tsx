// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-59d6895.json?raw";
import { Shell } from "../app/Shell.js";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { buildPaletteGroups, filterPaletteGroups } from "./palette.logic.js";

const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
const previous = watchStore.getState();
const previousSpi = window.spi;
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  window.location.hash = "";
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

const shortcut = (init: KeyboardEventInit) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, ...init }));
  });
const key = (name: string) =>
  act(async () => {
    input()?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
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

it("lists Go to, Services, Lenses and Queue from the routes and the snapshot, with no Actions group", async () => {
  await act(async () => findField()?.click());
  expect(labels()).toEqual(["Go to", "Services", "Lenses", "Queue", "Threads", "Ask"]);
  expect(palette()?.textContent).not.toMatch(/Actions/);
  expect(rows("go-to")).toEqual([
    "Inboxpage",
    "Templatepage",
    "Environmentpage",
    "Releasespage",
    "Setuppage",
  ]);
  expect(rows("services")).toEqual(
    ["partition", "entitlements", "legal", "schema", "file"].map((id) => `${id}service`),
  );
  expect(rows("lenses")).toEqual(["Flowlens", "Repositorieslens", "Horizonlens"]);
  expect(rows("queue")).toEqual([
    "P0Environment · Maintenance modeP0",
    "P0entitlements · Sync halted on schemathesis-testsP0",
    "P1fleet · Rollout to template bb49a03P1",
    "P1legal · Sync PR #31 fails Java BuildP1",
    "P1osdu-spi-stack · 1 outside PR waits for workflow approvalP1",
    "P12 forks · 3 upstream provider changes not portedP1",
  ]);
});

it("keeps Threads and Ask in view but disabled, saying threads are not available yet", async () => {
  await act(async () => findField()?.click());
  await type("legal");
  for (const group of ["threads", "ask"]) {
    const row = palette()?.querySelector(`[data-group="${group}"] .palette-row`);
    expect(row?.getAttribute("aria-disabled")).toBe("true");
    expect(row?.getAttribute("role")).not.toBe("option");
    expect(row?.textContent).toMatch(/threads.*not available yet/i);
  }
  for (let step = 0; step < 6; step += 1) {
    await key("ArrowDown");
    expect(highlighted()).not.toMatch(/not available/);
  }
});

it("moves with the arrows, opens with Enter, and filters as the operator types", async () => {
  await shortcut({ ctrlKey: true });
  expect(highlighted()).toBe("Inboxpage");
  await key("ArrowDown");
  expect(highlighted()).toBe("Templatepage");
  await key("ArrowDown");
  await key("ArrowUp");
  expect(highlighted()).toBe("Templatepage");

  await type("legal");
  expect(labels()).toEqual(["Services", "Queue", "Threads", "Ask"]);
  expect(rows("services")).toEqual(["legalservice"]);
  expect(rows("queue")).toEqual(["P1legal · Sync PR #31 fails Java BuildP1"]);
  expect(highlighted()).toBe("legalservice");
  await key("Enter");
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#service/legal");
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

it("selects a Queue row's item on the Inbox", async () => {
  await shortcut({ ctrlKey: true });
  await type("schemathesis");
  expect(highlighted()).toBe("P0entitlements · Sync halted on schemathesis-testsP0");
  await key("Enter");
  expect(palettes()).toHaveLength(0);
  expect(window.location.hash).toBe("#inbox");
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
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(selectionStore.getState().open).toBe(false);
  await act(async () => selectionStore.getState().setOpen(true));
});

it("ranks the best match class first and keeps group order on ties", () => {
  const groups = buildPaletteGroups(body);
  expect(filterPaletteGroups(groups, "").map(({ value }) => value)).toEqual([
    "go-to",
    "services",
    "lenses",
    "queue",
  ]);
  expect(filterPaletteGroups(groups, "ENTITLE").map(({ value }) => value)).toEqual([
    "services",
    "queue",
  ]);
  expect(
    filterPaletteGroups(groups, "flow").flatMap(({ items }) => items.map((i) => i.label)),
  ).toEqual(["Flow", "osdu-spi-stack · 1 outside PR waits for workflow approval"]);
  expect(filterPaletteGroups(groups, "nothing like this")).toEqual([]);
});
