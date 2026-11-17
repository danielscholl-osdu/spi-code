// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { installSpi } from "../test-utils/harness.js";
import snapshot1116 from "../views/today/snapshot-1116.json?raw";
import { openDestination, parseDestination } from "./destination.js";
import { navigate, openSelection, parseRoute, setOpenSelection } from "./navigation.js";
import { Shell } from "./Shell.js";

it("accepts only the closed set of window destinations", () => {
  expect(parseDestination({ to: "evidence" })).toEqual({ to: "evidence" });
  expect(parseDestination({ to: "readiness" })).toEqual({ to: "readiness" });
  expect(parseDestination({ to: "today", item: "halt:partition" })).toEqual({
    to: "today",
    item: "halt:partition",
  });
  for (const input of [
    { to: "settings" },
    { to: "evidence", item: "x" },
    { to: "readiness", section: "sweep" },
    { to: "constructor" },
    { to: ["evidence"] },
    ["evidence"],
    "evidence",
    null,
    undefined,
    { to: "today" },
    { to: "today", item: "halt:partition", extra: true },
    ...[
      "",
      "/tmp/file",
      "../file",
      "C:\\file",
      "C:/file",
      "private/file",
      "file:private",
      "data:payload",
      "javascript:alert(1)",
      "vbscript:msgbox",
      "a".repeat(257),
      "a".repeat(1024 * 1024),
      "__proto__",
      "constructor",
      "prototype",
      "a:../../etc/passwd",
      "a:repo/../file",
      "a:repo/..",
      "a:..",
      "%2e%2e",
      "a:%2E%2E/x",
      "a:x/%2e%2e",
      "a:..%2fetc",
      "a:x%2F..",
      "a:x..%2Fetc",
      "a:x/..suffix",
      "a:x../suffix",
      " javascript:",
      "halt:partition ",
      "\thalt:partition",
      "halt:partition\u00a0",
      "a:\u0000",
      "a:\n",
      "a:\u007f",
      "a:\u0085",
      "a:\u2028",
      "a:\u2029",
      "https://example.com",
      " ",
      3,
      null,
    ].map((item) => ({ to: "today", item })),
  ])
    expect(parseDestination(input)).toBeUndefined();
  for (const item of [
    "access:owner/repository#12",
    "security:code:unsafe workflow",
    "a".repeat(256),
    "branch:v1..2",
    "campaign:toolchain:os-core-common%2010.0.0",
  ])
    expect(parseDestination({ to: "today", item })).toEqual({ to: "today", item });
});

const nov16 = ViewSnapshotSchema.parse(JSON.parse(snapshot1116));
const previous = watchStore.getState();
let shell: { root: Root; container: HTMLDivElement; restore(): void } | undefined;

async function mount(snapshot: typeof nov16 | null, from: string) {
  window.location.hash = from;
  const harness = installSpi();
  watchStore.setState({ snapshot: snapshot && { cursor: snapshot.cursor, body: snapshot } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  shell = { root, container, restore: harness.restore };
  return container;
}

afterEach(async () => {
  if (shell) {
    const { root, container, restore } = shell;
    await act(async () => root.unmount());
    container.remove();
    restore();
    shell = undefined;
  }
  setOpenSelection(null);
  selectionStore.getState().clear();
  watchStore.setState(previous, true);
  window.location.hash = "";
  vi.restoreAllMocks();
});

const openRows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>("tr.today-row[data-open]"),
];

it.each([
  ["halt:crs-conversion", "blocked:halt:crs-conversion", "halt:crs-conversion"],
  ["gate2:legal", "waiting:blocker:stack:lanes:gate2", "gate2:legal"],
  ["port:legal", "waiting:port:entitlements", "port:entitlements"],
])("opens a tray item's Today row in place: %s", async (item, line, member) => {
  const container = await mount(nov16, "#upstream");
  const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  await act(async () => openDestination({ to: "today", item }));
  expect(window.location.hash).toBe("#today");
  const open = openRows(container);
  expect(open).toHaveLength(1);
  expect(open[0]?.dataset.lineId).toBe(line);
  expect(open[0]?.dataset.itemId).toBe(member);
  expect(scrolled.mock.contexts).toContain(open[0]);
  expect(selectionStore.getState().selected).toBeNull();
});

it("goes to Today with nothing open for an item no row holds", async () => {
  const container = await mount(nov16, "#today");
  await act(async () => openDestination({ to: "today", item: "halt:crs-conversion" }));
  expect(openRows(container)).toHaveLength(1);
  await act(async () => openDestination({ to: "today", item: "halt:not-on-today" }));
  expect(window.location.hash).toBe("#today");
  expect(openRows(container)).toHaveLength(0);
  expect(openSelection()).toBeNull();
  expect(selectionStore.getState().selected).toBeNull();
});

it("opens the whole sweep's Evidence page from the tray, keeping the way back to the open row", async () => {
  const container = await mount(nov16, "#today");
  await act(async () => openDestination({ to: "today", item: "gate2:legal" }));
  await act(async () => openDestination({ to: "evidence" }));
  expect(parseRoute(window.location.hash)).toEqual({
    kind: "evidence",
    from: { kind: "today" },
    open: { kind: "item", id: "gate2:legal" },
  });
  const page = container.querySelector(".evidence-page");
  expect(page).not.toBeNull();
  expect(page?.querySelector("[data-evidence-whole]")).toBeNull();
  expect(page?.querySelector('[aria-label="Sources"] .sweep-row')).not.toBeNull();
  expect(selectionStore.getState().selected).toBeNull();
});

it("reveals the first sweep from the tray's Evidence before any snapshot", async () => {
  await mount(null, "#upstream");
  await act(async () => openDestination({ to: "evidence" }));
  expect(window.location.hash).toBe("#today");
  expect(selectionStore.getState().selected).toBeNull();
});
