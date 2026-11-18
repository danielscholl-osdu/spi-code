// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type SetupState, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import current from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import type { Route } from "../../app/routes.js";
import { movePin, PINS_STORAGE_KEY, pin, readPins, SEED_PINS, unpin } from "../../store/pins.js";
import { createWatchStore } from "../../store/watch.js";
import { watchFixtureText } from "../../test-utils/watch-fixtures.test-helper.js";
import { COLLAPSE_STORAGE_KEY } from "./collapse.js";
import { ProgramSidebar } from "./ProgramSidebar.js";
import { serviceMark } from "./service-mark.js";
import { SidebarProvider } from "./ui-sidebar.js";

const recorded = watchFixtureText("snapshot-59d6895.json", readFixture);
const acknowledgedText = watchFixtureText("snapshot-1106-acknowledged.json", readFixture);
const unreadText = watchFixtureText("snapshot-1106-unread.json", readFixture);

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
const FIXED_LABELS = ["Today", "Environment", "Template"];
const SEED_LABELS = ["Upstream", "Releases", "Security"];
const storePins = (pins: readonly string[]) =>
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(pins));

async function render(
  route: Route = { kind: "today" },
  onNavigate = vi.fn(),
  body = recordedBody,
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
const serviceMarks = () =>
  [...container.querySelectorAll('ul[aria-label="Pinned"] [data-sidebar-row]')].flatMap(
    (element) => {
      const mark = element.querySelector('.sidebar-mark[role="img"]');
      return mark
        ? [[element.getAttribute("data-sidebar-row"), mark.getAttribute("aria-label")]]
        : [];
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
const menuItems = (pinId: string) =>
  [...document.querySelectorAll(`[data-pin-menu="${pinId}"] > *`)].map((item) =>
    item.getAttribute("role") === "separator" ? "—" : item.textContent,
  );
const unpinFromMenu = async (key: string, pinId: string) => {
  await openMenu(key);
  await act(async () => menuItem(pinId, "Unpin from sidebar")?.click());
};
const altKey = (key: string, arrow: "ArrowUp" | "ArrowDown") =>
  act(async () => {
    row(key)?.dispatchEvent(
      new KeyboardEvent("keydown", { key: arrow, altKey: true, bubbles: true, cancelable: true }),
    );
  });
const focused = () => document.activeElement?.getAttribute("data-sidebar-row");

it("leads with Find or ask, then a headerless fixed block, then Pinned seeded with Upstream, Releases and Security", async () => {
  await render({ kind: "service", id: "legal" }, vi.fn(), recordedBody);
  const nav = container.querySelector('nav[aria-label="Sidebar"]');
  expect(nav?.querySelector("button")?.textContent).toContain("Find or ask");
  expect(rows("Program")).toEqual(FIXED_LABELS);
  expect(row("today")?.querySelector(".sidebar-pip")?.textContent).toBe("4");
  expect(rows("Pinned")).toEqual(SEED_LABELS);
  expect(container.querySelector('ul[aria-label="Places"]')).toBeNull();
  expect(
    [...container.querySelectorAll('[data-slot="section-header"]')].map((h) => h.textContent),
  ).toEqual(["Pinned"]);
  expect(container.querySelector('[data-group="settled"]')).toBeNull();
  expect(container.querySelector('[data-sidebar-row="setup"]')).toBeNull();
  expect(nav?.textContent).not.toContain("Setup");
  expect(container.querySelector('[aria-current="page"]')).toBeNull();
  await render();
  expect(rows("Program")).toEqual(["Today", "Environment", "Template"]);
});

it("draws the fixed block with no grip, menu or pin control, and no row with an unpin button", async () => {
  storePins([...SEED_PINS, "entitlements"]);
  await render(undefined, undefined, undefined);
  const fixed = container.querySelector('ul[aria-label="Program"]');
  expect(fixed?.querySelectorAll("button")).toHaveLength(FIXED_LABELS.length);
  expect(fixed?.querySelector(".pin-grip, [draggable]")).toBeNull();
  for (const key of ["today", "environment", "engineering-system"]) {
    await openMenu(key);
    expect(document.querySelector("[data-pin-menu]"), key).toBeNull();
  }
  expect(container.querySelector('[aria-label^="Unpin"], .pin-unpin')).toBeNull();
  const pinned = [...container.querySelectorAll('ul[aria-label="Pinned"] > li')];
  expect(pinned.map((item) => item.querySelectorAll("button").length)).toEqual([1, 1, 1, 1]);
});
it("counts core line members independently of focus, rest, tier and acknowledgement", async () => {
  const { store } = await render(undefined, undefined, currentBody);
  const pip = () => row("today")?.querySelector(".sidebar-pip");
  expect(pip()?.textContent).toBe("27");
  expect(pip()?.getAttribute("title")).toBe("27 yours on Today");
  const body = structuredClone(currentBody);
  body.briefing.focus = [];
  body.briefing.rest = [];
  await act(async () => store.setState({ snapshot: { cursor: body.cursor, body } }));
  expect(pip()?.textContent).toBe("27");
  for (const lines of [[], undefined]) {
    const next = structuredClone(body);
    next.briefing.lines = lines;
    await act(async () => store.setState({ snapshot: { cursor: next.cursor, body: next } }));
    expect(pip()).toBeNull();
  }
});

it("draws a service pin only while the sweep names it, in pin order, lights the open one, and hides Pinned when empty", async () => {
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
  expect(container.querySelector('[data-group="pinned"]')).toBeNull();
  expect(header("Pinned")).toBeUndefined();
  expect(rows("Program")).toEqual(["Today", "Environment", "Template"]);
  expect(readPins()).toEqual(["gone"]);
});
it("marks each pinned service as its home's mark reads, and never a place", async () => {
  const services = (currentBody.services ?? []).map(({ service }) => service);
  storePins(["place:environment", ...services]);
  await render(undefined, undefined, currentBody);
  expect(serviceMarks()).toEqual(
    services.map((service) => [
      `service/${service}`,
      serviceMark(currentBody, service)?.label ?? null,
    ]),
  );
  expect(serviceMarks().map(([, label]) => label)).toEqual(
    expect.arrayContaining(["3 blocked or waiting on you", "1 waiting on you", "2 waiting on you"]),
  );
  expect(row("environment")?.querySelector('.sidebar-mark[role="img"]')).toBeNull();
});

it("unpins Upstream from its menu and pins it again at the end, across a reload", async () => {
  await render(undefined, undefined, undefined);
  await unpinFromMenu("upstream", "place:upstream");
  expect(rows("Pinned")).toEqual(["Releases", "Security"]);
  expect(readPins()).not.toContain("place:upstream");
  await act(async () => pin("place:upstream"));
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
        <sidebar.ProgramSidebar store={store} route={{ kind: "today" }} onNavigate={vi.fn()} />
      </ui.SidebarProvider>,
    ),
  );
  expect(rows("Program")).toEqual(FIXED_LABELS);
  expect(rows("Pinned")).toEqual(["Releases", "Security", "Upstream"]);
});
it("offers Open, Move up, Move down and Unpin from sidebar on each Pinned row, and Unpin removes it", async () => {
  storePins([...SEED_PINS, "entitlements"]);
  const { onNavigate } = await render(undefined, undefined, undefined);
  for (const [key, pinId] of [
    ["upstream", "place:upstream"],
    ["releases", "place:releases"],
    ["security", "place:security"],
    ["service/entitlements", "entitlements"],
  ] as const) {
    await openMenu(key);
    expect(menuItems(pinId)).toEqual(["Open", "Move up", "Move down", "—", "Unpin from sidebar"]);
    await act(async () => menuItem(pinId, "Open")?.click());
  }
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "service", id: "entitlements" });
  await unpinFromMenu("releases", "place:releases");
  expect(rows("Pinned")).toEqual(["Upstream", "Security", "entitlements"]);
  expect(readPins()).toEqual(["place:upstream", "place:security", "entitlements"]);
});

it("moves a pin from its menu and with Alt+Up and Alt+Down, past a pin the sweep does not name, and keeps the order", async () => {
  storePins(["place:security", "gone", "place:upstream", "place:releases"]);
  await render(undefined, undefined, undefined);
  await openMenu("security");
  expect(menuItem("place:security", "Move up")?.hasAttribute("data-disabled")).toBe(true);
  await act(async () => menuItem("place:security", "Move down")?.click());
  expect(rows("Pinned")).toEqual(["Upstream", "Security", "Releases"]);
  await openMenu("releases");
  expect(menuItem("place:releases", "Move down")?.hasAttribute("data-disabled")).toBe(true);
  await act(async () => menuItem("place:releases", "Move up")?.click());
  expect(rows("Pinned")).toEqual(["Upstream", "Releases", "Security"]);
  await altKey("upstream", "ArrowDown");
  expect(rows("Pinned")).toEqual(["Releases", "Upstream", "Security"]);
  expect(focused()).toBe("upstream");
  await altKey("security", "ArrowUp");
  expect(rows("Pinned")).toEqual(["Releases", "Security", "Upstream"]);
  expect(focused()).toBe("security");
  await altKey("releases", "ArrowUp");
  expect(readPins()).toEqual(["gone", "place:releases", "place:security", "place:upstream"]);
  vi.resetModules();
  expect((await import("../../store/pins.js")).readPins()).toEqual(readPins());
});

it("moves focus after Unpin to the next Pinned row, else the previous, else the fixed block's last row", async () => {
  await render(undefined, undefined, undefined);
  await unpinFromMenu("releases", "place:releases");
  expect(focused()).toBe("security");
  await unpinFromMenu("security", "place:security");
  expect(focused()).toBe("upstream");
  await unpinFromMenu("upstream", "place:upstream");
  expect(header("Pinned")).toBeUndefined();
  expect(focused()).toBe("engineering-system");
});

it("reorders by dragging within Pinned, and a drop on the fixed block or outside the list changes nothing", async () => {
  await render(undefined, undefined, undefined);
  const pinItem = (id: string) => container.querySelector<HTMLElement>(`li[data-pin="${id}"]`);
  const drag = (target: Element | null | undefined, type: string, clientY = 0) =>
    act(async () => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
      target?.dispatchEvent(event);
    });
  expect(pinItem("place:security")?.getAttribute("draggable")).toBe("true");
  await drag(pinItem("place:security"), "dragstart");
  for (const target of [row("engineering-system")?.closest("li"), container, document.body]) {
    await drag(target, "dragover");
    await drag(target, "drop");
  }
  await drag(pinItem("place:security"), "dragend");
  expect(readPins()).toEqual(SEED_PINS);
  await drag(pinItem("place:security"), "dragstart");
  await drag(pinItem("place:upstream"), "dragover", -1);
  expect(pinItem("place:upstream")?.getAttribute("data-drop")).toBe("before");
  await drag(pinItem("place:upstream"), "drop");
  expect(readPins()).toEqual(["place:security", "place:upstream", "place:releases"]);
  expect(rows("Pinned")).toEqual(["Security", "Upstream", "Releases"]);
});
it("ends with a gear that opens Settings, and no sweep time", async () => {
  const onSettings = vi.fn();
  await render(undefined, undefined, undefined, onSettings);
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
  const { store } = await render(undefined, undefined, undefined, vi.fn());
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

const marks = () =>
  [...container.querySelectorAll(".sidebar-mark")].map((mark) => [
    mark.closest("[data-sidebar-row]")?.getAttribute("data-sidebar-row"),
    mark.getAttribute("data-mark"),
    mark.getAttribute("data-tone"),
    mark.textContent,
  ]);

async function nov6Evening(run: () => Promise<void>) {
  vi.useFakeTimers({ now: Date.parse("2026-11-06T22:30:00.000Z"), toFake: ["Date"] });
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

it("draws each status mark on its own row, the fixed block's and a Pinned place's wherever it sits, and nowhere else", () =>
  nov6Evening(async () => {
    storePins(["place:releases", "entitlements", "place:security", "place:upstream"]);
    await render(undefined, undefined, currentBody);
    expect(marks()).toEqual([
      ["environment", "check", "success", ""],
      ["engineering-system", "count", "warning", "13"],
      ["service/entitlements", "count", "error", "3"],
      ["upstream", "count", "warning", "3"],
    ]);
    await act(async () => movePin("place:upstream", "place:releases"));
    expect(marks()[2]).toEqual(["upstream", "count", "warning", "3"]);
    expect(rows("Pinned")[0]).toBe("Upstream");
  }));
it("draws an unpinned status pin's mark nowhere", () =>
  nov6Evening(async () => {
    await render(undefined, undefined, currentBody);
    for (const id of ["place:environment", "place:upstream", "place:engineering-system"])
      await act(async () => unpin(id));
    expect(marks()).toEqual([
      ["environment", "check", "success", ""],
      ["engineering-system", "count", "warning", "13"],
    ]);
  }));

it("puts each status field's sentence in its row's hover and description, a fine Environment's included", () =>
  nov6Evening(async () => {
    await render(undefined, undefined, currentBody);
    const sentence = (key: string) => {
      const element = row(key);
      expect(element?.getAttribute("title")).toBe(element?.getAttribute("aria-description"));
      return element?.getAttribute("aria-description");
    };
    expect(sentence("environment")).toBe("Environment: Ready. v0.35.3 is ready.");
    expect(sentence("engineering-system")).toMatch(/^13 template sync PRs to review: /);
    expect(sentence("upstream")).toBe("3 rows on Upstream.");
    expect(sentence("releases")).toBeNull();
  }));

it("keeps Today's count once the Interrupt is acknowledged", () =>
  nov6Evening(async () => {
    const unacknowledged = structuredClone(currentBody);
    const interrupt = unacknowledged.briefing.focus[0];
    if (!interrupt) throw new Error("Recorded Interrupt missing");
    unacknowledged.seen = { cursor: null, since: [interrupt.id] };
    const { store } = await render(undefined, undefined, unacknowledged);
    const pip = () => row("today")?.querySelector(".sidebar-pip")?.textContent;
    expect(pip()).toBe("27");
    const acknowledged = ViewSnapshotSchema.parse(JSON.parse(acknowledgedText));
    expect(acknowledged.seen).toMatchObject({ cursor: currentBody.cursor, since: [] });
    await act(async () =>
      store.setState({ snapshot: { cursor: acknowledged.cursor, body: acknowledged } }),
    );
    expect(pip()).toBe("27");
  }));

it("dots a collapsed Pinned header by its services' marks: error for Blocked, warning for Waiting, none for a check or not read", async () => {
  storePins(["place:releases", "crs-catalog"]);
  await render(undefined, undefined, ViewSnapshotSchema.parse(JSON.parse(unreadText)));
  const dot = () => header("Pinned")?.querySelector(".sidebar-status-dot");
  await act(async () => header("Pinned")?.click());
  expect(dot()).toBeNull();
  await act(async () => pin("legal"));
  expect(dot()?.getAttribute("data-tone")).toBe("warning");
  await act(async () => pin("entitlements"));
  expect(dot()?.getAttribute("data-tone")).toBe("error");
  await act(async () => header("Pinned")?.click());
  expect(dot()).toBeNull();
});
