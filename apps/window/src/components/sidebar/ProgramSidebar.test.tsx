// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type SetupState, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import current from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import type { Route } from "../../app/routes.js";
import { LINE_PIN, PINS_STORAGE_KEY, pin, readPins, unpin } from "../../store/pins.js";
import { createWatchStore } from "../../store/watch.js";
import { watchFixtureText } from "../../test-utils/watch-fixtures.test-helper.js";
import { COLLAPSE_STORAGE_KEY } from "./collapse.js";
import { ProgramSidebar } from "./ProgramSidebar.js";
import { SidebarProvider } from "./ui-sidebar.js";

const recorded = watchFixtureText("snapshot-59d6895.json", readFixture);

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
const PLACE_LABELS = ["Upstream", "Environment", "Engineering system", "Releases", "Security"];
const storePins = (pins: readonly string[]) =>
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(pins));

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
  [...container.querySelectorAll(`ul[aria-label="${label}"] [data-sidebar-row]`)].map(
    (button) => button.querySelector(".sidebar-row-label")?.textContent,
  );
const row = (key: string) => container.querySelector<HTMLElement>(`[data-sidebar-row="${key}"]`);
const words = () =>
  [...container.querySelectorAll('ul[aria-label="Pinned"] [data-sidebar-row]')].flatMap(
    (element) => {
      const word = element.querySelector(".sidebar-word");
      return word ? [[element.getAttribute("data-sidebar-row"), word.textContent]] : [];
    },
  );
const menuItem = (pinId: string, label: string) =>
  [...document.querySelectorAll<HTMLElement>(`[data-pin-menu="${pinId}"] [role="menuitem"]`)].find(
    (item) => item.textContent === label,
  );
const openMenu = (key: string) =>
  act(async () => {
    row(key)?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }),
    );
  });

it("lists Find or ask first, Today with its count, and one Pinned list seeded with Line and the places", async () => {
  const onLine = vi.fn();
  await render({ kind: "service", id: "legal" }, vi.fn(), recordedBody, onLine);
  const nav = container.querySelector('nav[aria-label="Sidebar"]');
  expect(nav?.querySelector("button")?.textContent).toContain("Find or ask");
  expect(rows("Today")).toEqual(["Today"]);
  expect(container.querySelector('ul[aria-label="Today"] .sidebar-pip')?.textContent).toBe("2");
  expect(rows("Pinned")).toEqual(["Line", ...PLACE_LABELS]);
  expect(container.querySelector('ul[aria-label="Places"]')).toBeNull();
  expect(
    [...container.querySelectorAll('[data-slot="section-header"]')].map((h) => h.textContent),
  ).toEqual(["Pinned"]);
  expect(container.querySelector('[data-group="settled"]')).toBeNull();
  expect(container.querySelector('[data-sidebar-row="setup"]')).toBeNull();
  expect(nav?.textContent).not.toContain("Setup");
  expect(container.querySelector('[aria-current="page"]')).toBeNull();
  await act(async () => row("line")?.click());
  expect(onLine).toHaveBeenCalledExactlyOnceWith();
  await render();
  expect(rows("Pinned")).toEqual(PLACE_LABELS);
});

it("counts the recorded Interrupt, not the P0 and P1 total", async () => {
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
  },
);

it("draws a service pin only while the sweep names it, in pin order, and lights the open one", async () => {
  storePins(["gone", "schema", "place:releases", "entitlements"]);
  await render({ kind: "release", month: "2026-10" });
  expect(rows("Pinned")).toEqual(["schema", "Releases", "entitlements"]);
  expect(row("releases")?.getAttribute("aria-current")).toBe("true");
  const { onNavigate } = await render({ kind: "service", id: "schema" });
  expect(container.querySelector('[aria-current="page"]')?.textContent).toContain("schema");
  await act(async () => row("service/entitlements")?.click());
  expect(onNavigate).toHaveBeenCalledWith({ kind: "service", id: "entitlements" });
  await act(async () => row("releases")?.click());
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "releases" });
  for (const id of ["schema", "place:releases", "entitlements"]) await act(async () => unpin(id));
  expect(header("Pinned")).toBeUndefined();
  expect(container.querySelector('ul[aria-label="Pinned"]')).toBeNull();
  expect(readPins()).toEqual(["gone"]);
});

it("words a pinned service only when its line is read and not fine, and never a place", async () => {
  const body = structuredClone(recordedBody);
  storePins(["place:environment", ...body.stations.map(({ service }) => service)]);
  const entitlements = body.stations.find(({ service }) => service === "entitlements");
  const legal = body.stations.find(({ service }) => service === "legal");
  if (!entitlements || !legal) throw new Error("Recorded stations required");
  for (const station of [...entitlements.stations, ...legal.stations]) station.state = "idle";
  const sync = legal.stations[1];
  sync.substate = "waiting-on-person";
  await render(undefined, undefined, body);
  expect(words()).toEqual([
    ["service/entitlements", "stopped"],
    ["service/legal", "waiting"],
  ]);
  expect(row("environment")?.querySelector(".sidebar-word")).toBeNull();
});

it("unpins Line from its row and pins it again at the end, across a reload", async () => {
  await render(undefined, undefined, undefined, vi.fn());
  const unpinLine = container.querySelector<HTMLButtonElement>('button[aria-label="Unpin Line"]');
  await act(async () => unpinLine?.click());
  expect(rows("Pinned")).toEqual(PLACE_LABELS);
  expect(readPins()).not.toContain(LINE_PIN);
  await act(async () => pin(LINE_PIN));
  await act(async () => root.unmount());
  vi.resetModules();
  const pins = await import("../../store/pins.js");
  const sidebar = await import("./ProgramSidebar.js");
  const ui = await import("./ui-sidebar.js");
  const watch = await import("../../store/watch.js");
  expect(pins.readPins()).toEqual([...readPins()]);
  const store = watch.createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: recordedBody.cursor, body: recordedBody } });
  root = createRoot(container);
  await act(async () =>
    root.render(
      <ui.SidebarProvider>
        <sidebar.ProgramSidebar
          store={store}
          route={{ kind: "today" }}
          onNavigate={vi.fn()}
          onLine={vi.fn()}
        />
      </ui.SidebarProvider>,
    ),
  );
  expect(rows("Pinned")).toEqual([...PLACE_LABELS, "Line"]);
});

it("moves a pin up and down from its context menu, past a pin the sweep does not name", async () => {
  storePins([LINE_PIN, "gone", "place:upstream", "place:security"]);
  const onLine = vi.fn();
  await render(undefined, undefined, undefined, onLine);
  await openMenu("line");
  expect(menuItem(LINE_PIN, "Move up")?.hasAttribute("data-disabled")).toBe(true);
  await act(async () => menuItem(LINE_PIN, "Move down")?.click());
  expect(rows("Pinned")).toEqual(["Upstream", "Line", "Security"]);
  await openMenu("security");
  await act(async () => menuItem("place:security", "Move up")?.click());
  expect(rows("Pinned")).toEqual(["Upstream", "Security", "Line"]);
  expect(readPins()).toEqual(["gone", "place:upstream", "place:security", LINE_PIN]);
  await openMenu("line");
  expect(menuItem(LINE_PIN, "Move down")?.hasAttribute("data-disabled")).toBe(true);
  await act(async () => menuItem(LINE_PIN, "Open")?.click());
  expect(onLine).toHaveBeenCalledOnce();
  await openMenu("line");
  await act(async () => menuItem(LINE_PIN, "Unpin")?.click());
  expect(rows("Pinned")).toEqual(["Upstream", "Security"]);
});

it("reorders by dragging one pin onto another", async () => {
  storePins([LINE_PIN, "place:upstream", "place:security"]);
  await render(undefined, undefined, undefined, vi.fn());
  const item = (id: string) => container.querySelector<HTMLElement>(`li[data-pin="${id}"]`);
  const drag = (id: string, type: string) =>
    act(async () => {
      item(id)?.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    });
  await drag("place:security", "dragstart");
  await drag(LINE_PIN, "dragover");
  await drag(LINE_PIN, "drop");
  expect(readPins()).toEqual(["place:security", LINE_PIN, "place:upstream"]);
  expect(rows("Pinned")).toEqual(["Security", "Line", "Upstream"]);
});

it("ends with a gear that opens Settings, and no sweep time", async () => {
  const onSettings = vi.fn();
  await render(undefined, undefined, undefined, undefined, onSettings);
  const footer = container.querySelector('[data-slot="sidebar-footer"]');
  const settings = footer?.querySelector<HTMLButtonElement>('[data-sidebar-row="settings"]');
  expect(settings?.getAttribute("aria-label")).toBe("Settings");
  expect(settings?.getAttribute("aria-haspopup")).toBe("dialog");
  expect(settings?.getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+,$/);
  expect(footer?.querySelector("time")).toBeNull();
  expect(footer?.textContent).not.toMatch(/swept|not swept/);
  await act(async () => settings?.click());
  expect(onSettings).toHaveBeenCalledTimes(1);
});

it("has no footer without a way to open Settings", async () => {
  await render();
  expect(container.querySelector('[data-slot="sidebar-footer"]')).toBeNull();
});

it("dots the gear only when Readiness needs the operator, not when ready or unchecked", async () => {
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
  expect(dot()).toBeNull();
  await states("ready", "ready", "installing", "ready");
  expect(dot()).toBeNull();
  await states("ready", "ready", "signed-out", "ready");
  expect(dot()?.getAttribute("data-readiness")).toBe("attention");
  await states("ready", "failed", "signed-out", "ready");
  expect(dot()?.getAttribute("data-readiness")).toBe("failure");
  await act(async () => store.setState({ setup: null }));
  expect(dot()).toBeNull();
});

it("keeps a folded Pinned list folded across a fresh render, from local storage", async () => {
  await render();
  expect(header("Pinned")?.getAttribute("aria-expanded")).toBe("true");
  await act(async () => header("Pinned")?.click());
  expect(header("Pinned")?.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector('ul[aria-label="Pinned"]')).toBeNull();
  expect(JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) ?? "{}")).toEqual({
    pinned: true,
  });
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(header("Pinned")?.getAttribute("aria-expanded")).toBe("false");
});
