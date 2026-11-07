// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import november6 from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { closeSheet, navigate } from "../../app/navigation.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { routeSelectionIds, selectionRows } from "../../panels/selection-rows.js";
import { watchStore } from "../../store/watch.js";
import Today from "../today/index.js";
import { upstreamReading } from "./reading.js";

const fixture = () => ViewSnapshotSchema.parse(JSON.parse(november6));
const previousWatch = watchStore.getState();
const previousSpi = window.spi;
let container: HTMLDivElement;
const unmounts: (() => Promise<void>)[] = [];

async function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
}

function load(body: ViewSnapshot) {
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
}

const place = () => {
  const found = container.querySelector<HTMLElement>('main section.place[aria-label="Upstream"]');
  if (!found) throw new Error("Missing Upstream place");
  return found;
};
const texts = (root: Element, selector: string) =>
  [...root.querySelectorAll(selector)].map((element) => element.textContent);
const group = (label: string) =>
  place().querySelector(`section.place-group[aria-label="${label}"]`);
const itemIds = (label: string) =>
  [...(group(label)?.querySelectorAll<HTMLElement>("[data-item-id]") ?? [])].map(
    (item) => item.dataset.itemId,
  );
const click = (element: Element | null | undefined) =>
  act(async () => {
    if (!(element instanceof HTMLElement)) throw new Error("Missing clickable element");
    element.click();
  });
const itemButton = (id: string) =>
  place().querySelector(`[data-item-id="${CSS.escape(id)}"] .place-item-content`);
const ahead = () => {
  const found = container.querySelector<HTMLElement>('section[aria-label="Further ahead"]');
  if (!found) throw new Error("Missing Further ahead");
  return found;
};
const theme = (id: string) => {
  const found = ahead().querySelector<HTMLElement>(`[data-theme-id="${CSS.escape(id)}"]`);
  if (!found) throw new Error(`Missing theme ${id}`);
  return found;
};
const detailFields = () =>
  Object.fromEntries(
    [...container.querySelectorAll('dl[aria-label="Row reading"] dt')].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]),
  );

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  closeSheet();
  window.location.hash = "#upstream";
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    setAppearance: vi.fn(async () => true),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
  selectionStore.getState().clear();
  selectionStore.getState().setOpen(false);
  load(fixture());
  container = await render(<Shell />);
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  closeSheet();
  watchStore.setState(previousWatch, true);
  window.spi = previousSpi;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("lists Upstream first among the places and opens it from the sidebar", async () => {
  await act(async () => navigate({ kind: "today" }));
  const nav = container.querySelector('nav[aria-label="Sidebar"]');
  if (!nav) throw new Error("Missing sidebar");
  const places = texts(nav, 'ul[aria-label="Program"] .sidebar-row-label');
  expect(places[0]).toBe("Upstream");
  await click(nav?.querySelector('[data-sidebar-row="upstream"]'));
  expect(window.location.hash).toBe("#upstream");
  expect(place().querySelector("h1")?.textContent).toBe("Upstream");
});

it("renders the Nov 6 upstream reading: headline, qualifier, tiles and groups", () => {
  expect(place().querySelector(".place-headline")?.textContent).toBe(
    "At 00:00, 107 commits reach 10 forks. Two need you first.",
  );
  expect(place().querySelector(".place-qualifier")?.textContent).toBe(
    "GitLab cut the upstream diffs for 6 services and the reads failed for 3 services, so a toolchain move could be missing.",
  );
  expect(texts(place(), ".place-tile dt")).toEqual(["Incoming", "Toolchain", "Largest"]);
  expect(texts(place(), ".place-tile-value")).toEqual(["107", "8 forks", "25"]);
  expect(texts(place(), ".place-tile-counts")).toEqual([
    "commits · 10 of 13 forks",
    "move to os-core-common 8.5.0 · 1 more move",
    "commits · indexer · then legal 17, schema 16",
  ]);
  expect(texts(place(), ".place-group > h3")).toEqual(["Before 00:00", "Toolchain"]);
  expect(itemIds("Before 00:00")).toEqual(["radar:partition", "radar:legal"]);
  expect(place().querySelector(".place-folded")?.textContent).toBe(
    "indexer-queue takes 3 commits with no toolchain move.",
  );
});

it("shows the detected campaigns and reads their forks in Detail", async () => {
  const body = fixture();
  expect(itemIds("Toolchain")).toEqual(
    ["os-core-common%208.5.0", "os-core-common%2010.0.0"].map((f) => `campaign:toolchain:${f}`),
  );
  expect(texts(group("Toolchain") ?? place(), ".place-item-title")).toEqual([
    "Detected: os-core-common 8.5.0 on 8 forks",
    "Detected: os-core-common 10.0.0 on 3 forks",
  ]);
  const id = "campaign:toolchain:os-core-common%208.5.0";
  await click(itemButton(id));
  expect(selectionStore.getState().selected).toBe(id);
  expect(detailFields().Forks).toBe(
    body.campaigns.find((campaign) => campaign.id === id)?.forks.join(", "),
  );
  expect(detailFields().Forks).toBe(
    "crs-conversion, file, indexer, schema, search, storage, unit, workflow",
  );
});

it("lists Before next sync items as the same records Today shows, and selects them as Today does", async () => {
  const body = fixture();
  const before = itemIds("Before 00:00");
  const briefing = [...body.briefing.focus, ...body.briefing.rest].map(({ id }) => id);
  expect(before.length).toBeGreaterThan(0);
  for (const id of before) expect(briefing).toContain(id);

  const today = await render(<Today />);
  const todayIds = [
    ...today.querySelectorAll<HTMLElement>("[data-item-id], [data-selection-id]"),
  ].map((row) => row.dataset.itemId ?? row.dataset.selectionId);
  for (const id of before) expect(todayIds).toContain(id);

  await click(itemButton("radar:legal"));
  expect(selectionStore.getState().selected).toBe("radar:legal");
  expect(selectionStore.getState().row).toEqual(
    selectionRows(body).find(({ id }) => id === "radar:legal"),
  );
  expect(selectionStore.getState().row?.prefixes).toEqual([
    `/briefing/focus/${body.briefing.focus.findIndex(({ id }) => id === "radar:legal")}`,
  ]);
  expect(today.querySelector('[data-item-id="radar:legal"]')?.hasAttribute("data-selected")).toBe(
    true,
  );
  expect(place().querySelector('[data-item-id="radar:legal"]')?.hasAttribute("data-selected")).toBe(
    true,
  );
});

it("drops a resolved item from the Upstream place and its selection ids", async () => {
  const body = fixture();
  const resolved: ViewSnapshot = {
    ...body,
    cursor: body.cursor + 1,
    briefing: {
      ...body.briefing,
      rest: body.briefing.rest.filter(({ id }) => id !== "radar:partition"),
      themes: body.briefing.themes.filter(({ inspect }) => inspect !== "radar:partition"),
    },
    readings: body.readings.map((reading) =>
      reading.anchor.kind === "upstream" && reading.content
        ? {
            ...reading,
            content: {
              ...reading.content,
              items: reading.content.items.filter(({ id }) => id !== "radar:partition"),
            },
          }
        : reading,
    ),
  };
  expect(routeSelectionIds(body, { kind: "upstream" })).toContain("radar:partition");
  expect(routeSelectionIds(resolved, { kind: "upstream" })).not.toContain("radar:partition");
  await act(async () => load(resolved));
  expect(itemIds("Before 00:00")).toEqual(["radar:legal"]);
});

type Located = { field: string; expected: string; locate: () => Promise<string | undefined> };

it("reaches every former Horizon field within one click of the Upstream place", async () => {
  const body = fixture();
  const { horizon, themes } = body.briefing;
  expect(themes.length).toBeGreaterThan(0);
  const table: Located[] = [
    {
      field: "horizon.headline",
      expected: horizon.headline,
      locate: async () =>
        ahead().querySelector(".upstream-ahead-headline")?.textContent ?? undefined,
    },
    ...themes.flatMap((t): Located[] => [
      {
        field: `${t.id}.title`,
        expected: t.title,
        locate: async () =>
          theme(t.id).querySelector(".upstream-theme-title")?.textContent ?? undefined,
      },
      {
        field: `${t.id}.sub`,
        expected: t.sub,
        locate: async () =>
          theme(t.id).querySelector(".upstream-theme-sub")?.textContent ?? undefined,
      },
      {
        field: `${t.id}.kind`,
        expected: t.kind,
        locate: async () =>
          theme(t.id).querySelector(".upstream-theme-kind")?.textContent ?? undefined,
      },
      {
        field: `${t.id}.tone`,
        expected: t.tone,
        locate: async () =>
          theme(t.id).querySelector<HTMLElement>(".upstream-theme-kind")?.dataset.tone,
      },
      ...(t.when
        ? [
            {
              field: `${t.id}.when`,
              expected: t.when,
              locate: async () =>
                theme(t.id).querySelector(".upstream-theme-when")?.textContent ?? undefined,
            },
          ]
        : []),
      {
        field: `${t.id} Detail`,
        expected: t.inspect ?? `theme:${t.id}`,
        locate: async () => {
          await click(theme(t.id).querySelector(".upstream-theme-head"));
          return selectionStore.getState().selected ?? undefined;
        },
      },
    ]),
  ];
  const evidence = ahead().querySelector<HTMLElement>(
    '[data-section-evidence="/briefing/horizon /briefing/themes"]',
  );
  expect(evidence?.textContent?.trim()).toBe("Upstream radar read failed · 2 more");
  expect(evidence?.dataset.tone).toBe("bad");
  for (const { field, expected, locate } of table) {
    window.location.hash = "#upstream";
    await act(async () => navigate({ kind: "upstream" }));
    expect({ field, value: await locate() }).toEqual({ field, value: expected });
  }
});

it("opens each fork a theme names from the Upstream place in one click", async () => {
  const { themes } = fixture().briefing;
  const named = themes.flatMap((t) =>
    [...t.certain.map(({ fork }) => fork), ...t.possible.map(({ fork }) => fork), ...t.exposed]
      .filter((fork) => t.sub.split(/[^a-z0-9-]+/).includes(fork))
      .map((fork) => [t.id, fork] as const),
  );
  expect(named).toContainEqual(["halt:top_level:schemathesis-tests", "partition"]);
  for (const [id, fork] of named) {
    await act(async () => navigate({ kind: "upstream" }));
    const link = [...theme(id).querySelectorAll<HTMLElement>(".upstream-fork")].find(
      (button) => button.textContent === fork,
    );
    await click(link);
    expect(window.location.hash).toBe(`#service/${fork}`);
  }
});

it("takes no space for a missing reading or an empty horizon", async () => {
  const body = fixture();
  await act(async () =>
    load({
      ...body,
      cursor: body.cursor + 1,
      readings: body.readings.filter(({ anchor }) => anchor.kind !== "upstream"),
      briefing: { ...body.briefing, themes: [] },
    }),
  );
  expect(upstreamReading(watchStore.getState().snapshot?.body as ViewSnapshot).content).toBeNull();
  expect(place().querySelector(".place-reading")).toBeNull();
  expect(container.querySelector('section[aria-label="Further ahead"]')).toBeNull();
});
