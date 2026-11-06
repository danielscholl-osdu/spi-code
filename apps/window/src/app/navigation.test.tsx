// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-59d6895.json?raw";
import { watchStore } from "../store/watch.js";
import {
  LINE,
  navigate,
  type Registry,
  type Route,
  type RouteKind,
  routeHash,
  routeLabel,
} from "./routes.js";
import { Shell } from "./Shell.js";

let container: HTMLDivElement;
let unmount: () => Promise<void>;
const previousSpi = window.spi;
const previousWatch = watchStore.getState();

function View({ route }: { route: Route }) {
  return (
    <section data-view={route.kind}>
      <h1>{routeHash(route)}</h1>
      <input aria-label="Draft" />
    </section>
  );
}

const view = (route: Route) => <View route={route} />;
const ALL_KINDS: readonly RouteKind[] = [
  "today",
  "upstream",
  "environment",
  "engineering-system",
  "releases",
  "security",
  "service",
  "release",
  "inbox",
  "lens",
  "setup",
];
const every = Object.fromEntries(ALL_KINDS.map((kind) => [kind, view])) as Registry["views"];
const sheet = vi.fn((origin: Route) => <p data-sheet>{routeHash(origin)}</p>);

async function mount(registry: Registry) {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell registry={registry} />));
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

const main = () => container.querySelector<HTMLElement>("main");
const shown = () => main()?.querySelector("[data-view] h1")?.textContent;
const place = () => container.querySelector("header [data-place]")?.textContent;
const lineSheet = () =>
  container.querySelector<HTMLElement>('section.line-sheet[aria-label="Line"]');
const press = (key: string, init: KeyboardEventInit = { ctrlKey: true }) =>
  act(async () => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
const go = (route: Route | typeof LINE) => act(async () => navigate(route));
const setHash = (hash: string) =>
  act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

beforeEach(() => {
  window.location.hash = "";
  sheet.mockClear();
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    setAppearance: vi.fn(async () => true),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
});

afterEach(async () => {
  await unmount();
  window.spi = previousSpi;
  watchStore.setState(previousWatch, true);
  window.location.hash = "";
});

it("renders the registered component for every route id, with its service id and month", async () => {
  await mount({ views: every, fallback: { kind: "inbox" } });
  const routes: Route[] = [
    { kind: "today" },
    { kind: "upstream" },
    { kind: "environment" },
    { kind: "engineering-system" },
    { kind: "releases" },
    { kind: "security" },
    { kind: "service", id: "legal" },
    { kind: "release", month: "2026-10" },
    { kind: "inbox" },
    { kind: "lens", lens: "flow" },
    { kind: "lens", lens: "horizon" },
    { kind: "setup" },
  ];
  for (const route of routes) {
    await go(route);
    expect(window.location.hash).toBe(routeHash(route));
    expect(main()?.querySelector("[data-view]")?.getAttribute("data-view")).toBe(route.kind);
    expect(shown()).toBe(routeHash(route));
    expect(place()).toBe(routeLabel(route));
  }
  await setHash("#template");
  expect(shown()).toBe("#engineering-system");
});

it("opens the Line sheet over the current place with ⌘L and returns to the same place on close", async () => {
  await mount({ views: every, sheet, fallback: { kind: "inbox" } });
  for (const [origin, close] of [
    [{ kind: "service", id: "legal" }, () => press("Escape", {})],
    [{ kind: "release", month: "2026-10" }, () => press("l")],
    [{ kind: "today" }, () => go({ kind: "today" })],
  ] as const) {
    await go(origin);
    const beneath = main()?.querySelector("[data-view]");
    const draft = beneath?.querySelector("input");
    if (!draft) throw new Error("missing view");
    draft.value = "kept";
    await act(async () => draft.focus());

    await press("l");
    expect(lineSheet()).not.toBeNull();
    expect(lineSheet()?.textContent).toBe(routeHash(origin));
    expect(sheet).toHaveBeenLastCalledWith(origin);
    expect(document.activeElement).toBe(lineSheet());
    expect(main()?.hasAttribute("inert")).toBe(true);
    expect(main()?.querySelector("[data-view]")).toBe(beneath);
    expect(window.location.hash).toBe(routeHash(origin));
    expect(place()).toBe(routeLabel(origin));

    await close();
    expect(lineSheet()).toBeNull();
    expect(main()?.hasAttribute("inert")).toBe(false);
    expect(window.location.hash).toBe(routeHash(origin));
    expect(main()?.querySelector("[data-view]")).toBe(beneath);
    expect(draft.value).toBe("kept");
    expect(document.activeElement).toBe(draft);
  }
});

it("closes the Line sheet when the operator goes somewhere else", async () => {
  await mount({ views: every, sheet, fallback: { kind: "inbox" } });
  await go({ kind: "environment" });
  await go(LINE);
  expect(lineSheet()?.textContent).toBe("#environment");
  expect(window.location.hash).toBe("#environment");
  expect(shown()).toBe("#environment");
  await go({ kind: "service", id: "legal" });
  expect(lineSheet()).toBeNull();
  expect(shown()).toBe("#service/legal");
  await go(LINE);
  await setHash("#releases");
  expect(lineSheet()).toBeNull();
  await setHash("#environment");
  expect(lineSheet()).toBeNull();
});

it("leaves ⌘L alone when no Line sheet is registered", async () => {
  await mount({ views: every, fallback: { kind: "inbox" } });
  await go({ kind: "environment" });
  const event = new KeyboardEvent("keydown", { key: "l", ctrlKey: true, cancelable: true });
  await act(async () => window.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  await go(LINE);
  expect(lineSheet()).toBeNull();
  expect(main()?.hasAttribute("inert")).toBe(false);
});

it("lists only registered places in the sidebar and Find, and falls back from the rest", async () => {
  const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  const {
    lens: _lens,
    setup: _setup,
    upstream: _u,
    security: _s,
    environment: _e,
    ...views
  } = every;
  await mount({ views, fallback: { kind: "today" } });
  const nav = container.querySelector('nav[aria-label="Sidebar"]');
  const rows = (group: string) =>
    [...(nav?.querySelectorAll(`ul[aria-label="${group}"] .sidebar-row-label`) ?? [])].map(
      (row) => row.textContent,
    );
  expect(rows("Today")).toEqual(["Today"]);
  expect(rows("Inbox")).toEqual(["Inbox"]);
  expect(rows("Program")).toEqual(["Engineering system", "Releases"]);
  expect(rows("Services")).toEqual(["partition", "entitlements", "legal", "schema", "file"]);
  expect(nav?.querySelector('ul[aria-label="Lenses"]')).toBeNull();
  expect(nav?.textContent).not.toMatch(/Upstream|Security|Environment|Setup|Flow/);

  await press("k");
  const palette = document.querySelector('[role="dialog"][aria-label="Find or ask"]');
  const found = (group: string) =>
    [...(palette?.querySelectorAll(`[data-group="${group}"] .palette-label`) ?? [])].map(
      (row) => row.textContent,
    );
  expect(found("go-to")).toEqual(["Today", "Inbox", "Engineering system", "Releases"]);
  expect(found("services")).toEqual(["partition", "entitlements", "legal", "schema", "file"]);
  expect(found("lenses")).toEqual([]);
  await press("k");

  for (const hash of ["#upstream", "#security", "#environment", "#lens/flow", "#setup", "#nope"]) {
    await setHash(hash);
    expect(shown()).toBe("#today");
    expect(place()).toBe("Today");
  }
});
