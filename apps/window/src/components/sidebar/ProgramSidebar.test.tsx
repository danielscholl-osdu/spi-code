// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
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

async function render(route: Route = { kind: "inbox" }, onNavigate = vi.fn()) {
  const store = createWatchStore(vi.fn());
  const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
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
    (button) => button.textContent,
  );

it("lists the things in order, with services in the recorded fleet order", async () => {
  const { onNavigate } = await render({ kind: "service", id: "legal" });
  const nav = container.querySelector('nav[aria-label="Sidebar"]');
  expect(nav?.querySelector("button")?.textContent).toContain("Find or ask");
  expect(rows("Inbox")).toEqual(["Inbox"]);
  expect(rows("Program")).toEqual(["Template", "Environment", "Releases"]);
  expect(rows("Services")).toEqual(["partition", "entitlements", "legal", "schema", "file"]);
  expect(header("Services")?.textContent).toContain("5");
  expect(rows("Lenses")).toEqual(["Flow", "Repositories", "Horizon"]);
  expect(header("Settled")?.textContent).toContain("0");
  expect(rows("Setup")).toEqual(["Setup"]);
  expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(
    "2026-10-12T21:58:14.428Z",
  );
  expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("legal");
  const schema = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "schema",
  );
  await act(async () => schema?.click());
  expect(onNavigate).toHaveBeenCalledWith({ kind: "service", id: "schema" });
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
