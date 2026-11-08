// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  PROTOCOL_VERSION,
  type SetupState,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-59d6895.json?raw";
import current from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import type { Route } from "../../app/routes.js";
import { PINS_STORAGE_KEY, pin, unpin } from "../../store/pins.js";
import { createWatchStore } from "../../store/watch.js";
import { COLLAPSE_STORAGE_KEY, isCollapsed } from "./collapse.js";
import { ProgramSidebar } from "./ProgramSidebar.js";
import { SidebarProvider } from "./ui-sidebar.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
});

const recordedBody = ViewSnapshotSchema.parse(JSON.parse(recorded));
const currentBody = ViewSnapshotSchema.parse(JSON.parse(current));
const FLEET = ["partition", "entitlements", "legal", "schema", "file"];
const pinFleet = () => localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(FLEET));

async function render(
  route: Route = { kind: "today" },
  onNavigate = vi.fn(),
  body = recordedBody,
  onLine?: () => void,
  onSettings?: () => void,
) {
  const store = createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () =>
    root.render(
      <SidebarProvider>
        <ProgramSidebar
          store={store}
          route={route}
          onNavigate={onNavigate}
          {...(onLine ? { onLine } : {})}
          {...(onSettings ? { onSettings } : {})}
        />
      </SidebarProvider>,
    ),
  );
  return { store, onNavigate };
}

const header = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-slot="section-header"]')].find(
    (button) => button.textContent?.startsWith(label),
  );
const rows = (label: string) =>
  [...container.querySelectorAll(`ul[aria-label="${label}"] button`)].map(
    (button) => button.querySelector(".sidebar-row-label")?.textContent,
  );
const row = (key: string) => container.querySelector(`[data-sidebar-row="${key}"]`);
const attention = (key: string) => ({
  dot: row(key)?.querySelector(".sidebar-attention-dot")?.getAttribute("data-attention") ?? null,
  priority: row(key)?.querySelector(".sidebar-attention-dot")?.getAttribute("aria-label") ?? null,
  word: row(key)?.querySelector(".sidebar-row-note")?.textContent ?? null,
});

it("lists Find or ask, Today, Line and the places, no Setup place, and no service unpinned", async () => {
  const onLine = vi.fn();
  await render({ kind: "service", id: "legal" }, vi.fn(), recordedBody, onLine);
  const nav = container.querySelector('nav[aria-label="Sidebar"]');
  expect(nav?.querySelector("button")?.textContent).toContain("Find or ask");
  expect(rows("Today")).toEqual(["Today"]);
  expect(rows("Inbox")).toEqual([]);
  expect(container.querySelector('ul[aria-label="Today"] .sidebar-pip')?.textContent).toBe("2");
  expect(rows("Line")).toEqual(["Line"]);
  expect(rows("Places")).toEqual([
    "Upstream",
    "Environment",
    "Engineering system",
    "Releases",
    "Security",
  ]);
  expect(header("Settled")).toBeUndefined();
  expect(container.querySelector('[data-group="settled"]')).toBeNull();
  expect(container.textContent).not.toContain("Settled");
  expect(rows("Setup")).toEqual([]);
  expect(container.querySelector('[data-sidebar-row="setup"]')).toBeNull();
  expect(nav?.textContent).not.toContain("Setup");
  expect(
    [...container.querySelectorAll('[data-slot="section-header"]')].map((h) => h.textContent),
  ).toEqual(["Places"]);
  expect(container.querySelector('[data-sidebar-row^="service/"]')).toBeNull();
  expect(container.querySelector('[data-sidebar-row^="lens/"]')).toBeNull();
  expect(container.querySelector('[aria-current="page"]')).toBeNull();
  expect(container.querySelector("time")).toBeNull();
  const line = row("line");
  expect(line?.querySelector("kbd")?.textContent).toMatch(/^(⌘L|Ctrl\+L)$/);
  await act(async () => (line as HTMLButtonElement | null)?.click());
  expect(onLine).toHaveBeenCalledExactlyOnceWith();
  await render();
  expect(container.querySelector('ul[aria-label="Line"]')).toBeNull();
});

it("counts the recorded Interrupt, not the P0 and P1 total, including when folded", async () => {
  const { store } = await render(undefined, undefined, currentBody);
  const pip = () => row("today")?.querySelector(".sidebar-pip");
  expect(pip()?.textContent).toBe("1");
  expect(pip()?.getAttribute("title")).toBe("1 interruption");
  const body = structuredClone(currentBody);
  const item = body.briefing.focus.shift();
  if (!item) throw new Error("Recorded Interrupt missing");
  body.briefing.rest.push(item);
  await act(async () => store.setState({ snapshot: { cursor: body.cursor, body } }));
  expect(pip()?.textContent).toBe("1");
});

it.each(["ambient", "interrupt"] as const)(
  "counts a card, its %s waiting thread and its owned P0 once across focus and rest",
  async (attention) => {
    const body = structuredClone(currentBody);
    const item = body.briefing.focus[0];
    if (!item) throw new Error("Recorded Interrupt missing");
    item.owned = true;
    body.briefing.focus.push({
      ...item,
      id: "card:retry",
      ids: [item.id],
      title: "Retry waiting for your decision",
    });
    body.briefing.rest.push({
      ...item,
      id: "thread:diagnose",
      ids: ["card:retry"],
      attention,
      title: "Diagnose waiting for your decision",
    });
    const { store } = await render(undefined, undefined, body);
    expect(row("today")?.querySelector(".sidebar-pip")?.textContent).toBe("1");
    const independent = structuredClone(body);
    independent.briefing.rest.push({
      ...item,
      id: "card:other",
      ids: ["card:other"],
      title: "Another decision waiting",
    });
    await act(async () =>
      store.setState({ snapshot: { cursor: independent.cursor, body: independent } }),
    );
    expect(row("today")?.querySelector(".sidebar-pip")?.textContent).toBe("2");
    expect(row("today")?.querySelector(".sidebar-pip")?.getAttribute("title")).toBe(
      "2 interruptions",
    );
  },
);

it("draws Pinned only with a pin the sweep names, in pin order, with the strip's glyph", async () => {
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(["gone", "schema", "entitlements"]));
  const { onNavigate } = await render({ kind: "service", id: "schema" });
  expect(rows("Pinned")).toEqual(["schema", "entitlements"]);
  expect(
    [...container.querySelectorAll('[data-slot="section-header"]')].map((h) => h.textContent),
  ).toEqual(["Places", "Pinned"]);
  expect(container.querySelector('[aria-current="page"]')?.textContent).toContain("schema");
  expect(
    ["schema", "entitlements"].map((id) => {
      const glyph = row(`service/${id}`)?.querySelector(".sidebar-pin-glyph");
      return glyph && [glyph.textContent, glyph.getAttribute("aria-label")];
    }),
  ).toEqual([null, ["✕", "stopped"]]);
  await act(async () => (row("service/entitlements") as HTMLButtonElement | null)?.click());
  expect(onNavigate).toHaveBeenCalledWith({ kind: "service", id: "entitlements" });
  await act(async () => unpin("schema"));
  await act(async () => unpin("entitlements"));
  expect(header("Pinned")).toBeUndefined();
  expect(container.querySelector('ul[aria-label="Pinned"]')).toBeNull();
  expect(JSON.parse(localStorage.getItem(PINS_STORAGE_KEY) ?? "[]")).toEqual(["gone"]);
});

it("keeps pins across a reload, from local storage", async () => {
  await render();
  await act(async () => pin("schema"));
  await act(async () => pin("partition"));
  expect(rows("Pinned")).toEqual(["schema", "partition"]);
  await act(async () => root.unmount());
  vi.resetModules();
  const pins = await import("../../store/pins.js");
  const sidebar = await import("./ProgramSidebar.js");
  const ui = await import("./ui-sidebar.js");
  const watch = await import("../../store/watch.js");
  expect(pins.readPins()).toEqual(["schema", "partition"]);
  const store = watch.createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: recordedBody.cursor, body: recordedBody } });
  root = createRoot(container);
  await act(async () =>
    root.render(
      <ui.SidebarProvider>
        <sidebar.ProgramSidebar store={store} route={{ kind: "today" }} onNavigate={vi.fn()} />
      </ui.SidebarProvider>,
    ),
  );
  expect(rows("Pinned")).toEqual(["schema", "partition"]);
  await act(async () => pins.unpin("schema"));
  expect(rows("Pinned")).toEqual(["partition"]);
});

it("shows each recorded service's highest queue priority and class word, not a count", async () => {
  pinFleet();
  await render();
  expect(
    ["partition", "entitlements", "legal", "schema", "file"].map((id) =>
      attention(`service/${id}`),
    ),
  ).toEqual([
    { dot: "unread", priority: "Unread", word: "unread" },
    { dot: "p0", priority: "P0", word: "halt" },
    { dot: "p1", priority: "P1", word: "toolchain" },
    { dot: "unread", priority: "Unread", word: "unread" },
    { dot: "unread", priority: "Unread", word: "unread" },
  ]);
  expect(container.querySelectorAll(".sidebar-pip")).toHaveLength(1);
  expect(container.querySelector('ul[aria-label="Pinned"] .sidebar-pip')).toBeNull();
});

it("shows a read service's flow tag when it has no queue items", async () => {
  pinFleet();
  const body = structuredClone(recordedBody);
  body.briefing.focus = [];
  body.briefing.rest = [];
  body.tree = body.tree.map((node) =>
    node.id === "service:legal" ? { ...node, status: "fresh" } : node,
  );
  await render(undefined, undefined, body);
  expect(attention("service/legal")).toEqual({ dot: null, priority: null, word: "wave 1" });
});

it.each(["", "  ", "·", " · "])("skips flow tag %j before the unread fallback", async (tag) => {
  pinFleet();
  const body = structuredClone(recordedBody);
  body.briefing.focus = [];
  body.briefing.rest = [];
  body.briefing.flow.rows = body.briefing.flow.rows.map((row) =>
    row.fork === "legal" ? { ...row, tag } : row,
  );
  await render(undefined, undefined, body);
  expect(attention("service/legal")).toEqual({
    dot: "unread",
    priority: "Unread",
    word: "unread",
  });
});

it.each([
  ["TEST", "tests red"],
  ["ENV", "environment"],
  ["BUILD", "build red"],
] as const)("uses the sidebar class word for %s", async (cls, word) => {
  pinFleet();
  const first = recordedBody.briefing.focus[0];
  if (!first) throw new Error("Recorded queue required");
  const body = structuredClone(recordedBody);
  body.briefing.focus = [{ ...first, cls, scope: "legal" }];
  body.briefing.rest = [];
  await render(undefined, undefined, body);
  expect(attention("service/legal")).toEqual({ dot: "p0", priority: "P0", word });
});

it("takes the highest rung across focus and rest, including a folded port's services", async () => {
  pinFleet();
  const first = recordedBody.briefing.focus[0];
  const port = recordedBody.briefing.rest[0];
  if (!first || !port) throw new Error("Recorded queue required");
  const body = structuredClone(recordedBody);
  body.briefing.focus = [
    { ...first, id: "later:file", scope: "file", rung: 2, cls: "READY" },
    { ...first, id: "later:legal", scope: "legal", rung: 2, cls: "READY" },
    { ...first, id: "gate:legal", scope: "legal", rung: 1, cls: "GATE" },
  ];
  body.briefing.rest = [
    { ...first, id: "conflict:legal", scope: "legal", rung: 0, cls: "CONFLICT" },
    { ...port, ids: ["port:entitlements", "port:schema"] },
  ];
  await render(undefined, undefined, body);
  expect(attention("service/legal")).toEqual({
    dot: "p0",
    priority: "P0",
    word: "conflict",
  });
  expect(attention("service/file")).toEqual({ dot: "p2", priority: "P2", word: "ready" });
  expect(attention("service/schema")).toEqual({ dot: "p1", priority: "P1", word: "port" });
});

it("carries the places' facts beside their attention dots", async () => {
  await render();
  expect(attention("engineering-system")).toEqual({ dot: "p1", priority: "P1", word: "0 of 5" });
  expect(attention("environment")).toEqual({
    dot: "p0",
    priority: "P0",
    word: "v0.28.0",
  });
  expect(attention("releases")).toEqual({ dot: null, priority: null, word: "2026.10" });
});

it("uses hollow only for an empty unread scope, and no dot for an empty read scope", async () => {
  pinFleet();
  const body = structuredClone(recordedBody);
  body.tree = body.tree.map((node) =>
    node.id === "service:file" ? { ...node, status: "fresh" } : node,
  );
  const { store } = await render(undefined, undefined, body);
  expect(attention("service/partition").dot).toBe("unread");
  expect(attention("service/file")).toEqual({ dot: null, priority: null, word: null });
  for (const status of ["stale", "incomplete"] as const) {
    await act(async () =>
      store.setState({
        snapshot: {
          cursor: body.cursor,
          body: {
            ...body,
            tree: body.tree.map((node) =>
              node.id === "service:file" ? { ...node, status } : node,
            ),
          },
        },
      }),
    );
    expect(attention("service/file").dot).toBeNull();
  }
});

it("leaves every dot unchanged when an area read and the tree scopes fail", async () => {
  pinFleet();
  const body = structuredClone(recordedBody);
  body.tree = body.tree.map((node) =>
    node.id === "service:file" ? { ...node, status: "fresh" } : node,
  );
  const { store } = await render(undefined, undefined, body);
  const dots = () =>
    [...container.querySelectorAll("[data-sidebar-row]")].map((element) => [
      element.getAttribute("data-sidebar-row"),
      element.querySelector(".sidebar-attention-dot")?.outerHTML ?? null,
    ]);
  const before = dots();
  const failed: ViewSnapshot = {
    ...body,
    cursor: body.cursor + 1,
    areas: body.areas.map((area) => ({
      ...area,
      envelope: {
        ...area.envelope,
        state: "failed",
        completeness: area.envelope.completeness ?? { kind: "complete" },
      },
    })),
    tree: body.tree.map((node) => ({ ...node, status: "failed" })),
  };
  await act(async () =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: "failed-read",
      kind: "event",
      type: "view.snapshot",
      payload: failed,
    }),
  );
  expect(
    store.getState().snapshot?.body.areas.every(({ envelope }) => envelope.state === "failed"),
  ).toBe(true);
  expect(dots()).toEqual(before);
  expect(attention("service/partition").dot).toBe("unread");
  expect(attention("service/file").dot).toBeNull();
  await act(async () =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: "recovered-read",
      kind: "event",
      type: "view.snapshot",
      payload: {
        ...body,
        cursor: failed.cursor + 1,
        tree: body.tree.map((node) => ({ ...node, status: "fresh" })),
      },
    }),
  );
  expect(attention("service/partition").dot).toBeNull();
  expect(attention("service/entitlements").dot).toBe("p0");
});

it("pins Find or ask, Today and Line above the scrolling groups, and the footer below them", async () => {
  pinFleet();
  await render(undefined, undefined, undefined, vi.fn(), vi.fn());
  const scroller = container.querySelector('[data-slot="sidebar-content"]');
  const pinnedTop = container.querySelector('[data-slot="sidebar-header"]');
  expect(pinnedTop?.querySelector('ul[aria-label="Today"]')).not.toBeNull();
  expect(pinnedTop?.querySelector('ul[aria-label="Line"]')).not.toBeNull();
  expect(pinnedTop?.textContent).toContain("Find or ask");
  expect(scroller?.querySelector('ul[aria-label="Today"]')).toBeNull();
  expect(scroller?.contains(container.querySelector('ul[aria-label="Places"]'))).toBe(true);
  expect(scroller?.contains(container.querySelector('ul[aria-label="Pinned"]'))).toBe(true);
  expect(scroller?.querySelector('ul[aria-label="Settings"]')).toBeNull();
  expect(
    container.querySelector('[data-slot="sidebar-footer"] ul[aria-label="Settings"]'),
  ).not.toBeNull();
});

it("ends with a Settings row that opens Settings, and no sweep time", async () => {
  const onSettings = vi.fn();
  await render(undefined, undefined, undefined, undefined, onSettings);
  const footer = container.querySelector('[data-slot="sidebar-footer"]');
  const settings = footer?.querySelector<HTMLButtonElement>('[data-sidebar-row="settings"]');
  expect(settings?.querySelector(".sidebar-row-label")?.textContent).toBe("Settings");
  expect(settings?.getAttribute("aria-haspopup")).toBe("dialog");
  expect(settings?.getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+,$/);
  expect(settings?.querySelector("kbd")?.textContent).toMatch(/^(⌘|Ctrl\+),$/);
  expect(footer?.querySelector("time")).toBeNull();
  expect(footer?.querySelector(".sweep-stamp")).toBeNull();
  expect(footer?.textContent).not.toMatch(/swept|not swept/);
  await act(async () => settings?.click());
  expect(onSettings).toHaveBeenCalledTimes(1);
});

it("has no footer row without a way to open Settings", async () => {
  await render();
  expect(container.querySelector('[data-slot="sidebar-footer"]')).toBeNull();
});

it("lights the Settings row green when ready, amber on attention and red on a failure", async () => {
  const { store } = await render(undefined, undefined, undefined, undefined, vi.fn());
  const dot = () => container.querySelector('[data-sidebar-row="settings"] .sidebar-readiness-dot');
  const states = (...states: SetupState["tools"][number]["state"][]) =>
    act(async () =>
      store.setState({
        setup: {
          watchReady: states.every((state) => state === "ready"),
          disabledReason: states.every((state) => state === "ready") ? null : "gh is not ready",
          tools: (["copilot", "git", "gh", "glab"] as const).map((tool, index) => ({
            tool,
            state: states[index] ?? "ready",
            action: null,
          })),
        },
      }),
    );
  expect(dot()).toBeNull();
  await states("ready", "ready", "ready", "ready");
  expect(dot()?.getAttribute("data-readiness")).toBe("ready");
  expect(dot()?.getAttribute("aria-label")).toBe("Every tool is ready");
  await states("ready", "ready", "signed-out", "ready");
  expect(dot()?.getAttribute("data-readiness")).toBe("attention");
  expect(dot()?.getAttribute("aria-label")).toBe("A tool needs attention");
  await states("ready", "failed", "signed-out", "ready");
  expect(dot()?.getAttribute("data-readiness")).toBe("failure");
  expect(dot()?.getAttribute("aria-label")).toBe("A tool failed");
  await states("ready", "ready", "installing", "ready");
  expect(dot()).toBeNull();
});

it("keeps a folded group folded across a fresh render, from local storage", async () => {
  pinFleet();
  await render();
  expect(header("Places")?.getAttribute("aria-expanded")).toBe("true");
  await act(async () => header("Places")?.click());
  expect(header("Places")?.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector('ul[aria-label="Places"]')).toBeNull();
  expect(JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) ?? "{}")).toEqual({
    places: true,
  });
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(header("Places")?.getAttribute("aria-expanded")).toBe("false");
  expect(header("Pinned")?.getAttribute("aria-expanded")).toBe("true");
});

it("folds Places on a short window unless the operator chose", () => {
  expect(isCollapsed("places", {}, 700)).toBe(false);
  expect(isCollapsed("places", {}, 600)).toBe(true);
  expect(isCollapsed("pinned", {}, 400)).toBe(false);
  expect(isCollapsed("places", { places: false }, 600)).toBe(false);
  expect(isCollapsed("pinned", { pinned: true }, 900)).toBe(true);
});
