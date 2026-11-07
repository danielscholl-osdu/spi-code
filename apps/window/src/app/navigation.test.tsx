// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-59d6895.json?raw";
import { watchStore } from "../store/watch.js";
import {
  closeSheet,
  LINE,
  navigate,
  pinSheet,
  type Registry,
  type Route,
  type RouteKind,
  relaunch,
  routeHash,
  routeLabel,
  unpinSheet,
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
const sheet = vi.fn((origin: Route, _presentation: string) => (
  <p data-sheet>{routeHash(origin)}</p>
));
const PINNED_KEY = "spi-code.line-sheet.pinned";
const LAST_PLACE_KEY = "spi-code.last-place";

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
  localStorage.removeItem(PINNED_KEY);
  localStorage.removeItem(LAST_PLACE_KEY);
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
  closeSheet();
  localStorage.removeItem(PINNED_KEY);
  localStorage.removeItem(LAST_PLACE_KEY);
  vi.restoreAllMocks();
  relaunch();
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
    expect(sheet).toHaveBeenLastCalledWith(origin, "overlay");
    expect(lineSheet()?.dataset.presentation).toBe("overlay");
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

it("pins the Line sheet beside a live centre across navigation and a reload; unpin closes it", async () => {
  await mount({ views: every, sheet, fallback: { kind: "inbox" } });
  const legal: Route = { kind: "service", id: "legal" };
  await go(legal);
  const beneath = main()?.querySelector("[data-view]");
  const draft = beneath?.querySelector("input");
  if (!draft) throw new Error("missing view");
  await act(async () => draft.focus());
  await press("l");
  expect(main()?.hasAttribute("inert")).toBe(true);

  await act(async () => pinSheet());
  expect(lineSheet()?.dataset.presentation).toBe("pinned");
  expect(sheet).toHaveBeenLastCalledWith(legal, "pinned");
  expect(main()?.closest("[inert]")).toBeNull();
  expect(main()?.querySelector("[data-view]")).toBe(beneath);
  expect(window.location.hash).toBe("#service/legal");
  expect(document.activeElement).toBe(draft);
  draft.value = "typed beside the sheet";
  await press("Escape", {});
  expect(lineSheet()?.dataset.presentation).toBe("pinned");
  expect(document.activeElement).toBe(draft);
  expect(localStorage.getItem(PINNED_KEY)).toBe("1");

  await go({ kind: "release", month: "2026-10" });
  expect(shown()).toBe("#release/2026-10");
  expect(lineSheet()?.dataset.presentation).toBe("pinned");
  await setHash("#environment");
  expect(shown()).toBe("#environment");
  expect(lineSheet()).not.toBeNull();

  await act(async () => unpinSheet());
  expect(lineSheet()).toBeNull();
  expect(localStorage.getItem(PINNED_KEY)).toBeNull();
  expect(shown()).toBe("#environment");

  // A reload starts from what the last session stored.
  await unmount();
  localStorage.setItem(PINNED_KEY, "1");
  await mount({ views: every, sheet, fallback: { kind: "inbox" } });
  expect(lineSheet()?.dataset.presentation).toBe("pinned");
  expect(main()?.hasAttribute("inert")).toBe(false);
  expect(shown()).toBe("#environment");
  await press("l");
  expect(lineSheet()).toBeNull();
});

it("draws a registered strip under the title bar on every route and beside either sheet", async () => {
  const strip = vi.fn(() => <p>line state</p>);
  await mount({ views: every, sheet, strip, fallback: { kind: "inbox" } });
  const header = () => container.querySelector("header.title-bar");
  const drawn = () => {
    const slot = header()?.nextElementSibling;
    return slot?.matches(".window-strip") && !slot.closest("[inert]") ? slot.textContent : null;
  };
  for (const route of [{ kind: "today" }, { kind: "service", id: "legal" }] as const) {
    await go(route);
    expect(drawn()).toBe("line state");
  }
  await go(LINE);
  expect(lineSheet()?.dataset.presentation).toBe("overlay");
  expect(drawn()).toBe("line state");
  await act(async () => pinSheet());
  expect(lineSheet()?.dataset.presentation).toBe("pinned");
  expect(drawn()).toBe("line state");

  await unmount();
  await mount({ views: every, sheet, fallback: { kind: "inbox" } });
  expect(container.querySelector(".window-strip")).toBeNull();
  expect(header()?.nextElementSibling?.matches(".app-sidebar, .sidebar-backdrop, nav")).toBe(true);
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

describe("landing", () => {
  const recordedBody = ViewSnapshotSchema.parse(JSON.parse(recorded));
  const registry: Registry = { views: every, sheet, fallback: { kind: "inbox" } };
  const arrive = (cursor: number, seen: { cursor: number; since: string[] }) =>
    act(async () => {
      const body = { ...recordedBody, cursor, seen };
      watchStore.setState({ snapshot: { cursor, body } });
    });
  const acknowledged = () =>
    vi
      .mocked(window.spi.postMessage)
      .mock.calls.map(([message]) => message)
      .filter((message) => message.type === "view.acknowledge")
      .map((message) => message.payload);
  const launch = async (lastPlace?: string) => {
    if (lastPlace) localStorage.setItem(LAST_PLACE_KEY, lastPlace);
    await mount(registry);
  };
  const restart = async () => {
    await unmount();
    relaunch();
    window.location.hash = "";
    watchStore.setState({ snapshot: null });
  };

  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("lands on the last place after Today was acknowledged and the sweep brought nothing new", async () => {
    await launch("#upstream");
    await arrive(4, { cursor: 3, since: ["halt:legal"] });
    expect(shown()).toBe("#today");
    expect(acknowledged()).toEqual([{ cursor: 4 }]);
    await go({ kind: "upstream" });

    await restart();
    await launch();
    expect(shown()).toBe("#upstream");
    await arrive(5, { cursor: 4, since: [] });
    expect(shown()).toBe("#upstream");
    expect(acknowledged()).toEqual([{ cursor: 4 }]);
  });

  it("opens on Today when a new Interrupt arrived, and again when an existing P0 worsens", async () => {
    await launch("#environment");
    await arrive(4, { cursor: 3, since: [] });
    expect(shown()).toBe("#environment");

    await restart();
    await launch();
    await arrive(5, { cursor: 4, since: ["halt:legal"] });
    expect(shown()).toBe("#today");
    expect(acknowledged()).toEqual([{ cursor: 5 }]);
    await go({ kind: "environment" });

    await restart();
    await launch();
    await arrive(6, { cursor: 5, since: ["stack:38181620856"] });
    expect(shown()).toBe("#today");
    expect(acknowledged()).toEqual([{ cursor: 5 }, { cursor: 6 }]);
  });

  it("keeps a place chosen before the first snapshot, and falls back without a last place", async () => {
    await launch();
    expect(shown()).toBe("#inbox");
    await go({ kind: "security" });
    await arrive(4, { cursor: 3, since: ["halt:legal"] });
    expect(shown()).toBe("#security");
    expect(acknowledged()).toEqual([]);
  });

  it("acknowledges only while Today is in the foreground, and each cursor once", async () => {
    await launch();
    await go({ kind: "today" });
    await go(LINE);
    await arrive(4, { cursor: 3, since: ["halt:legal"] });
    expect(lineSheet()).not.toBeNull();
    expect(acknowledged()).toEqual([]);
    await act(async () => closeSheet());
    expect(acknowledged()).toEqual([{ cursor: 4 }]);

    vi.mocked(document.hasFocus).mockReturnValue(false);
    await go({ kind: "inbox" });
    await arrive(5, { cursor: 4, since: [] });
    await go({ kind: "today" });
    expect(acknowledged()).toEqual([{ cursor: 4 }]);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await act(async () => window.dispatchEvent(new FocusEvent("focus")));
    expect(acknowledged()).toEqual([{ cursor: 4 }, { cursor: 5 }]);

    await act(async () => window.dispatchEvent(new FocusEvent("focus")));
    await go({ kind: "inbox" });
    await go({ kind: "today" });
    expect(acknowledged()).toEqual([{ cursor: 4 }, { cursor: 5 }]);
  });

  it("does not acknowledge while the Watch gate holds Today's items", async () => {
    const setup = (watchReady: boolean) =>
      act(async () =>
        watchStore.setState({
          setup: { tools: [], watchReady, disabledReason: watchReady ? null : "gh-missing" },
        }),
      );
    await launch();
    await setup(false);
    await go({ kind: "today" });
    await arrive(4, { cursor: 3, since: ["halt:legal"] });
    expect(shown()).toBe("#today");
    expect(acknowledged()).toEqual([]);

    await setup(true);
    expect(acknowledged()).toEqual([{ cursor: 4 }]);
  });
});
