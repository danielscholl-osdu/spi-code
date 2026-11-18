// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import {
  navigate,
  parseRoute,
  type Registry,
  relaunch,
  setOpenSelection,
  useNavigation,
} from "../../app/navigation.js";
import {
  createTitleStore,
  TitleEnd,
  TitleProvider,
  TitleRow,
  type TitleStore,
} from "../../app/title-row.js";
import { createSelectionStore } from "../../panels/selection.js";
import { PINS_STORAGE_KEY, readPins, SEED_PINS } from "../../store/pins.js";
import { createWatchStore } from "../../store/watch.js";
import nov16 from "../today/snapshot-1116.json?raw";
import ServicePage from "./index.js";

const sixteenth = () => ViewSnapshotSchema.parse(JSON.parse(nov16));
const sixth = () => ViewSnapshotSchema.parse(JSON.parse(recorded));

let container: HTMLElement;
let unmount = async () => {};

function Routed({ registry }: { registry: Registry }) {
  const { route } = useNavigation(registry);
  return <div data-route={route.kind}>{registry.views[route.kind]?.(route as never)}</div>;
}

async function mount(body: ViewSnapshot, hash: string, titles?: TitleStore) {
  window.location.hash = hash;
  const watch = createWatchStore(vi.fn(), createSelectionStore({ postMessage: vi.fn() }));
  watch.setState({ snapshot: { cursor: body.cursor, body } });
  const registry: Registry = {
    views: {
      today: () => <p data-today="">Today</p>,
      evidence: () => <p data-evidence="">Evidence</p>,
      service: (route) => (
        <ServicePage id={route.id} tab={route.tab} row={route.row} store={watch} />
      ),
    },
    fallback: { kind: "today" },
  };
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <TitleProvider value={titles ?? null}>
        {titles && (
          <>
            <div className="centre-title">
              <TitleRow store={titles} fallback="" />
            </div>
            <div className="centre-end">
              <TitleEnd store={titles} />
            </div>
          </>
        )}
        <Routed registry={registry} />
      </TitleProvider>,
    ),
  );
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

const $ = <T extends Element = HTMLElement>(selector: string) =>
  container.querySelector<T>(selector);
const click = (selector: string) => act(async () => $(selector)?.click());
const openRow = () => $("li[data-open]")?.getAttribute("data-row");
const head = (row: string) => $(`li[data-row="${row}"] .service-row-head`);

beforeEach(() => {
  window.location.hash = "";
});

afterEach(async () => {
  await unmount();
  await act(async () => setOpenSelection(null));
  window.location.hash = "";
  localStorage.removeItem(PINS_STORAGE_KEY);
  relaunch();
});

it("opens a station's row and a door's row on Overview with focus on it", async () => {
  await mount(sixteenth(), "#service/search");
  expect(openRow()).toBeUndefined();

  await click('button[data-station="upstream"]');
  expect(parseRoute(window.location.hash)).toEqual({
    kind: "service",
    id: "search",
    tab: "overview",
    row: "sync-run:search",
  });
  expect(openRow()).toBe("sync-run:search");
  expect(document.activeElement).toBe(head("sync-run:search"));
  expect(head("sync-run:search")?.getAttribute("aria-expanded")).toBe("true");
  expect($("li[data-open] .opened-body")?.textContent).toContain("Sync Upstream failed");

  const door = "can:repositories:https://github.com/Azure/osdu-spi-search/pull/68";
  await click('button[data-door="dependabot"]');
  expect(openRow()).toBe(door);
  expect(document.activeElement).toBe(head(door));
});

it("draws a station or door that holds no row as no button", async () => {
  await mount(sixteenth(), "#service/entitlements");
  expect($('[data-station="main"]')?.tagName).toBe("DIV");
  expect($('[data-door="other"]')?.tagName).toBe("SPAN");
  expect($('[data-door="release"]')?.tagName).toBe("BUTTON");
  expect($('[data-door="template"]')).toBeNull();
  expect($('[data-station="integration"]')?.tagName).toBe("BUTTON");
});

it("opens the tab and the row a route names, and closes the row back to the tab", async () => {
  await mount(sixteenth(), "#service/search/overview/gate2%3Asearch");
  expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Overview");
  expect(openRow()).toBe("gate2:search");

  await click('li[data-row="gate2:search"] .service-row-head');
  expect(openRow()).toBeUndefined();
  expect(parseRoute(window.location.hash)).toEqual({
    kind: "service",
    id: "search",
    tab: "overview",
  });

  await act(async () => navigate({ kind: "service", id: "search", tab: "runs", row: "x" }));
  expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Overview");
  expect(openRow()).toBeUndefined();
});

it.each([
  ["read", sixteenth, "file", "Nothing waiting on you"],
  ["not read", sixth, "crs-catalog", "⌀ Part of this fork was not read. Evidence ›"],
])("opens a quiet fork whose rows were %s on its one line", async (_, body, id, line) => {
  await mount(body(), `#service/${id}`);
  expect($(".service-quiet")?.textContent).toBe(line);
  expect($('[data-section="blocked"], [data-section="waiting"]')).toBeNull();
  if (id === "crs-catalog") {
    await click(".service-quiet a");
    expect(parseRoute(window.location.hash)).toEqual({
      kind: "evidence",
      from: { kind: "service", id },
    });
  }
});

it("still opens the service page on Overview from a link that names only the service", async () => {
  await mount(sixteenth(), "#today");
  expect($("[data-today]")).not.toBeNull();
  await act(async () => navigate({ kind: "service", id: "indexer" }));
  expect($('[data-view-pane="service"]')?.getAttribute("aria-label")).toBe("indexer");
  expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Overview");
  expect($('[data-section="blocked"]')).not.toBeNull();
});

it("puts the pin control at the top row's end, and the template icon reads the home", async () => {
  const titles = createTitleStore();
  await mount(sixteenth(), "#service/search", titles);
  const control = () => $<HTMLButtonElement>(".centre-end > .pin-control");
  expect($(".centre-title h1")?.textContent).toBe("search");
  expect($(".centre-title [data-template]")?.getAttribute("data-template")).toBe("behind");
  await act(async () => control()?.click());
  expect(readPins()).toEqual([...SEED_PINS, "search"]);
  await act(async () => control()?.click());
  expect(readPins()).toEqual(SEED_PINS);

  await act(async () => navigate({ kind: "service", id: "file" }));
  expect($(".centre-title [data-template]")?.getAttribute("data-template")).toBe("current");
  const unknown = sixteenth();
  const home = unknown.services?.find(({ service }) => service === "file")?.home;
  if (home) home.template = "unknown";
  await unmount();
  await mount(unknown, "#service/file", createTitleStore());
  expect($("[data-template]")).toBeNull();
});
