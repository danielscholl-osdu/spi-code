// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readGenerated } from "../../../../../scripts/watch-generated.mjs";
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
import { buildPaletteGroups } from "../../palette/palette.logic.js";
import { createSelectionStore } from "../../panels/selection.js";
import { PINS_STORAGE_KEY, readPins, SEED_PINS } from "../../store/pins.js";
import { createWatchStore } from "../../store/watch.js";
import { when } from "../../time.js";
import { ageInOneUnit } from "../today/parts.js";
import nov16 from "../today/snapshot-1116.json?raw";
import ServicePage from "./index.js";

const sixteenth = () => ViewSnapshotSchema.parse(JSON.parse(nov16));
const sixth = (variant?: "unread") =>
  ViewSnapshotSchema.parse(
    JSON.parse(variant ? readGenerated("snapshot-1106-unread.json") : recorded),
  );

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

  const again = $<HTMLButtonElement>('button[data-door="dependabot"]');
  again?.focus();
  const scrolled = vi.fn();
  const row = $(`li[data-row="${door}"]`);
  if (row) row.scrollIntoView = scrolled;
  await act(async () => again?.click());
  expect(openRow()).toBe(door);
  expect(document.activeElement).toBe(head(door));
  expect(scrolled).toHaveBeenCalled();
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

  await act(async () => navigate({ kind: "service", id: "search", tab: "unknown", row: "x" }));
  expect($('[role="tab"][aria-selected="true"]')?.textContent).toBe("Overview");
  expect(openRow()).toBeUndefined();
});

it.each([
  ["read", sixteenth, "file", "Nothing waiting on you"],
  [
    "not read",
    () => sixth("unread"),
    "crs-catalog",
    "⌀ Part of this fork was not read. Evidence ›",
  ],
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

it("filters Merged to merged PRs and gives only Waiting on you gates an amber tone", async () => {
  const body = sixteenth();
  await mount(body, "#service/search/pulls");
  const service = body.services?.find(({ service }) => service === "search");
  const waiting = new Set(
    service?.home?.overview
      .filter(({ section }) => section === "waiting")
      .map((row) => row.links[0]?.url),
  );
  const visible = () => [...container.querySelectorAll<HTMLElement>("[data-work=pr] li[data-row]")];
  const amber = visible().filter((row) => row.querySelector('[data-tone="warning"]'));
  expect(amber.map(({ dataset }) => dataset.row)).toEqual(["77", "76"]);
  expect(amber.every((row) => waiting.has(row.querySelector("a")?.href))).toBe(true);
  expect($('li[data-row="71"] [data-tone="error"]')).not.toBeNull();

  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.startsWith("Merged "))
      ?.click(),
  );
  const merged = service?.work?.pulls.rows
    .filter(({ state }) => state === "merged")
    .map(({ number }) => String(number));
  expect(visible().map(({ dataset }) => dataset.row)).toEqual(merged);
  expect($('li[data-row="81"]')).toBeNull();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "All")
      ?.click(),
  );
  expect($('li[data-row="81"]')).not.toBeNull();
});

it("shows a proven tracking issue only under All and keeps its companion on the PR", async () => {
  await mount(sixteenth(), "#service/search/issues");
  expect($('li[data-row="78"]')).toBeNull();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "All")
      ?.click(),
  );
  expect($('li[data-row="78"]')?.textContent).toContain("tracks PR #77");
  await act(async () => navigate({ kind: "service", id: "search", tab: "pulls" }));
  expect($('li[data-row="77"] a[data-kind="issue"]')?.getAttribute("href")).toBe(
    "https://github.com/Azure/osdu-spi-search/issues/78",
  );
});

const serviceOf = (body: ViewSnapshot, id: string) => {
  const service = body.services?.find(({ service }) => service === id);
  if (!service?.home || !service.work) throw new Error(`${id} has no home`);
  return { home: service.home, work: service.work };
};
const chip = (tab: string) => $(`[data-tab="${tab}"] .service-tab-count`)?.textContent;

it("draws a failed read's retained rows under the not-read line, with the mark on the chip", async () => {
  const at = "2026-11-16T07:38:00.000Z";
  const body = sixteenth();
  const { work } = serviceOf(body, "search");
  Object.assign(work.pulls, { read: false, at });
  const count = work.pulls.count;
  expect(count).toBeGreaterThan(0);
  await mount(body, "#service/search/pulls");
  const line = $("[data-work=pr] .service-list-unread");
  expect(line?.textContent).toBe(
    `⌀ Pull requests not read. Showing the read from ${when(at, { now: Date.now() })}. Evidence ›`,
  );
  const rows = [...container.querySelectorAll("[data-work=pr] li[data-row]")];
  expect(rows.length).toBeGreaterThan(0);
  expect(line?.compareDocumentPosition(rows[0] as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(chip("pulls")).toBe(`${count} ⌀`);
  const find = buildPaletteGroups(body)
    .flatMap(({ items }) => items)
    .flatMap((item) => item.children?.items ?? [])
    .find(({ value }) => value === "on:search:pulls");
  expect(find?.count).toBe(count);
  await unmount();

  delete work.pulls.at;
  await mount(body, "#service/search/pulls");
  expect($("[data-work=pr] .service-list-unread")?.textContent).toBe(
    "⌀ Pull requests not read. Evidence ›",
  );

  Object.assign(work.pulls, { count: null, partial: true });
  await unmount();
  await mount(body, "#service/search/pulls");
  expect(chip("pulls")).toBe("⌀");
  expect($("[data-work=pr] .service-list-unread")).not.toBeNull();
});

it("keeps the mark and the not-read line on a failed tab whose retained list holds no rows", async () => {
  const at = "2026-11-16T07:38:00.000Z";
  const body = sixteenth();
  const { work } = serviceOf(body, "search");
  Object.assign(work.issues, { read: false, at, count: 0, partial: false, rows: [] });
  await mount(body, "#service/search/issues");
  expect(chip("issues")).toBe("0 ⌀");
  const find = buildPaletteGroups(body)
    .flatMap(({ items }) => items)
    .flatMap((item) => item.children?.items ?? [])
    .find(({ value }) => value === "on:search:issues");
  expect(find?.count === undefined || typeof find.count === "number").toBe(true);
  await unmount();

  Object.assign(work.issues, { count: null, partial: true });
  await mount(body, "#service/search/issues");
  expect(chip("issues")).toBe("⌀");
  expect($("[data-work=issue] .service-list-unread")?.textContent).toBe(
    `⌀ Issues not read. Showing the read from ${when(at, { now: Date.now() })}. Evidence ›`,
  );
});

it("reads a failed tab with nothing retained as it did before", async () => {
  const body = sixteenth();
  const { work } = serviceOf(body, "search");
  Object.assign(work.issues, { read: false, count: null, partial: false, rows: [] });
  await mount(body, "#service/search/issues");
  expect($("[data-work=issue] .service-list-unread")).toBeNull();
  expect($("[data-work=issue]")?.textContent).toContain("⌀ Open issues were not read.");
  expect(chip("issues")).toBe("⌀");
});

it("counts held PRs at each door of an incomplete listing, under one mark on the group", async () => {
  const body = sixteenth();
  const { home } = serviceOf(body, "storage");
  const complete = home.doors.map(({ id, count }) => [id, count]);
  const word = (id: string) => $(`[data-door="${id}"] .flow-door-word`)?.textContent;
  await mount(body, "#service/storage");
  expect($('[data-door="unread"]')).toBeNull();
  for (const [id, count] of complete)
    if (id !== "template") expect(word(String(id))).toBe(count ? `${count} open` : "None open");
  await unmount();

  for (const door of home.doors) door.count = null;
  await mount(body, "#service/storage");
  const held = home.doors.filter(({ prs }) => prs.length > 0);
  const empty = home.doors.filter(({ id, prs }) => id !== "template" && prs.length === 0);
  expect(held.length).toBeGreaterThan(0);
  expect(empty.length).toBeGreaterThan(0);
  for (const door of held) expect(word(door.id)).toBe(`${door.prs.length} open`);
  for (const door of empty) expect(word(door.id)).toBe("⌀ not read");
  const marks = container.querySelectorAll('[data-door="unread"]');
  expect(marks).toHaveLength(1);
  expect(marks[0]?.textContent).toBe("⌀");
  expect(marks[0]?.getAttribute("title")).toBeTruthy();
});

it("gives an Overview row the age Today gives it, with its clock time on hover", async () => {
  const body = sixth();
  const member = body.briefing.lines
    ?.flatMap(({ members }) => members)
    .find(({ id }) => id === "gate1:indexer");
  const since = member?.since;
  if (!member?.age || !since) throw new Error("gate1:indexer has no age");
  await mount(body, "#service/indexer");
  const age = $('li[data-row="gate1:indexer"] .service-row-age time');
  expect(age?.textContent).toBe(ageInOneUnit(member.age));
  expect(age?.textContent).toBe("37h");
  expect(age?.getAttribute("title")).toBe(when(since, { now: Date.now() }));
});
