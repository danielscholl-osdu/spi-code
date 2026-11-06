// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-59d6895.json?raw";
import type { Route } from "../../app/routes.js";
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

async function render(route: Route = { kind: "inbox" }, onNavigate = vi.fn(), body = recordedBody) {
  const store = createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () =>
    root.render(
      <SidebarProvider>
        <ProgramSidebar store={store} route={route} onNavigate={onNavigate} />
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

it("lists the things in order, with services in the recorded fleet order", async () => {
  const { onNavigate } = await render({ kind: "service", id: "legal" });
  const nav = container.querySelector('nav[aria-label="Sidebar"]');
  expect(nav?.querySelector("button")?.textContent).toContain("Find or ask");
  expect(rows("Inbox")).toEqual(["Inbox"]);
  expect(container.querySelector('ul[aria-label="Inbox"] .sidebar-pip')?.textContent).toBe("6");
  expect(rows("Program")).toEqual(["Template", "Environment", "Releases"]);
  expect(rows("Services")).toEqual(["partition", "entitlements", "legal", "schema", "file"]);
  expect(header("Services")?.textContent).toContain("5");
  expect(rows("Lenses")).toEqual(["Flow", "Repositories", "Horizon"]);
  expect(header("Settled")?.textContent).toContain("0");
  expect(rows("Setup")).toEqual(["Setup"]);
  expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(
    "2026-10-12T21:58:14.428Z",
  );
  expect(container.querySelector('[aria-current="page"]')?.textContent).toContain("legal");
  const schema = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.querySelector(".sidebar-row-label")?.textContent === "schema",
  );
  await act(async () => schema?.click());
  expect(onNavigate).toHaveBeenCalledWith({ kind: "service", id: "schema" });
});

it("shows each recorded service's highest queue priority and class word, not a count", async () => {
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
  expect(container.querySelector('ul[aria-label="Services"] .sidebar-pip')).toBeNull();
});

it("shows a read service's flow tag when it has no queue items", async () => {
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
  const first = recordedBody.briefing.focus[0];
  if (!first) throw new Error("Recorded queue required");
  const body = structuredClone(recordedBody);
  body.briefing.focus = [{ ...first, cls, scope: "legal" }];
  body.briefing.rest = [];
  await render(undefined, undefined, body);
  expect(attention("service/legal")).toEqual({ dot: "p0", priority: "P0", word });
});

it("takes the highest rung across focus and rest, including a folded port's services", async () => {
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

it("carries the Program facts beside their attention dots", async () => {
  await render();
  expect(attention("template")).toEqual({ dot: "p1", priority: "P1", word: "0 of 5" });
  expect(attention("environment")).toEqual({
    dot: "p0",
    priority: "P0",
    word: "v0.28.0",
  });
  expect(attention("releases")).toEqual({ dot: null, priority: null, word: "2026.10" });
});

it("uses hollow only for an empty unread scope, and no dot for an empty read scope", async () => {
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

it("pins Find or ask and the Inbox above the scrolling groups, and the footer below them", async () => {
  await render();
  const scroller = container.querySelector('[data-slot="sidebar-content"]');
  const pinnedTop = container.querySelector('[data-slot="sidebar-header"]');
  expect(pinnedTop?.querySelector('ul[aria-label="Inbox"]')).not.toBeNull();
  expect(pinnedTop?.textContent).toContain("Find or ask");
  expect(scroller?.querySelector('ul[aria-label="Inbox"]')).toBeNull();
  expect(scroller?.contains(container.querySelector('ul[aria-label="Services"]'))).toBe(true);
  expect(scroller?.querySelector('ul[aria-label="Setup"]')).toBeNull();
  expect(
    container.querySelector('[data-slot="sidebar-footer"] ul[aria-label="Setup"]'),
  ).not.toBeNull();
});

it("keeps a folded group folded across a fresh render, from local storage", async () => {
  await render();
  expect(header("Program")?.getAttribute("aria-expanded")).toBe("true");
  await act(async () => header("Program")?.click());
  expect(header("Program")?.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector('ul[aria-label="Program"]')).toBeNull();
  expect(JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) ?? "{}")).toEqual({
    program: true,
  });
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(header("Program")?.getAttribute("aria-expanded")).toBe("false");
  expect(header("Services")?.getAttribute("aria-expanded")).toBe("true");
});

it("folds Lenses first, then Program, on a short window unless the operator chose", () => {
  expect(isCollapsed("lenses", {}, 900)).toBe(false);
  expect(isCollapsed("lenses", {}, 700)).toBe(true);
  expect(isCollapsed("program", {}, 700)).toBe(false);
  expect(isCollapsed("program", {}, 600)).toBe(true);
  expect(isCollapsed("services", {}, 400)).toBe(false);
  expect(isCollapsed("lenses", { lenses: false }, 600)).toBe(false);
  expect(isCollapsed("program", { program: false }, 600)).toBe(false);
  expect(isCollapsed("services", { services: true }, 900)).toBe(true);
});
