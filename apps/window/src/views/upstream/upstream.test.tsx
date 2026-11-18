// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { closeSheet, navigate, openSelection, setOpenSelection } from "../../app/navigation.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { routeSelectionIds } from "../../panels/selection-rows.js";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { timedText } from "../../time.js";
import { upstreamReading } from "./reading.js";

const loadFixture = fixtureLoader(readFixture);
const fixture = () => loadFixture("snapshot-1106.json");
// Core writes the fixture in UTC; the window reads its instants in Chicago, where 00:00Z is 18:00.
const previousZone = process.env.TZ;
process.env.TZ = "America/Chicago";
afterAll(() => {
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});
const previousWatch = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
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
const popover = () => container.querySelector<HTMLElement>(".popover");
const pairs = () =>
  [...(popover()?.querySelectorAll(".popover-fields dt") ?? [])].map((dt) => [
    dt.textContent,
    dt.nextElementSibling?.textContent,
  ]);
const fields = () => Object.fromEntries(pairs());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(fixture().sweptAt));
  closeSheet();
  window.location.hash = "#upstream";
  harness = installSpi();
  setOpenSelection(null);
  selectionStore.getState().clear();
  selectionStore.getState().setOpen(false);
  load(fixture());
  container = await render(<Shell />);
});

afterEach(async () => {
  await act(async () => setOpenSelection(null));
  for (const unmount of unmounts.splice(0)) await unmount();
  closeSheet();
  watchStore.setState(previousWatch, true);
  harness.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("pins Upstream first among the places and opens it from the sidebar", async () => {
  await act(async () => navigate({ kind: "today" }));
  const nav = container.querySelector('nav[aria-label="Sidebar"]');
  if (!nav) throw new Error("Missing sidebar");
  const pinned = texts(nav, 'ul[aria-label="Pinned"] .sidebar-row-label');
  expect(pinned.filter((label) => label !== "Line")[0]).toBe("Upstream");
  await click(nav?.querySelector('[data-sidebar-row="upstream"]'));
  expect(window.location.hash).toBe("#upstream");
  expect(container.querySelector("main header h1")?.textContent).toBe("Upstream");
});

it("renders the Nov 6 upstream reading: headline, qualifier, tiles and groups", () => {
  expect(place().querySelector(".place-headline")?.textContent).toBe(
    "At 18:00, 65 commits reach 8 forks. 13 need you first.",
  );
  expect(place().querySelector(".place-qualifier")?.textContent).toBe(
    "GitLab truncated the upstream diffs for 6 services and the reads failed for 3 services, so a toolchain move could be missing.",
  );
  expect(texts(place(), ".place-tile dt")).toEqual(["Incoming", "Toolchain", "Largest"]);
  expect(texts(place(), ".place-tile-value")).toEqual(["110", "10 forks", "25"]);
  expect(texts(place(), ".place-tile-counts")).toEqual([
    "commits behind upstream · 37 in 3 sync PRs · 65 at 18:00 · 8 won't land",
    "move to os-core-common 8.5.0",
    "commits · indexer · then legal 17, schema 16",
  ]);
  expect(texts(place(), ".place-group > h3")).toEqual(["Before 18:00", "Toolchain"]);
  expect(itemIds("Before 18:00")).toEqual([
    "radar:partition",
    "radar:legal",
    "gate1:indexer",
    "gate1:indexer-queue",
  ]);
  expect(place().querySelector(".place-folded")?.textContent).toBe(
    "indexer-queue takes 3 commits with no toolchain move.",
  );
});

it("states the next sync in local time, and leaves the due to the group that says it", () => {
  const body = fixture();
  expect(place().querySelector(".place-headline")?.textContent).toMatch(/^At 18:00, /);
  const before = group("Before 18:00");
  expect(before?.querySelector("h3 time")?.getAttribute("datetime")).toBe(body.briefing.nextSyncAt);
  expect(texts(before ?? place(), ".place-item-sub")).toEqual([
    "8 commits queued · syncs at 18:00",
    "17 commits queued · syncs at 18:00",
    "25 commits held · 1d 13h",
    "3 commits held · 1d 13h",
  ]);
  expect(before?.querySelectorAll(".place-item-meta")).toHaveLength(0);
  expect(texts(group("Toolchain") ?? place(), ".place-item-meta time")).toEqual([
    "Before next sync",
  ]);
  expect(place().textContent).not.toMatch(/00:00|T\d{2}:\d{2}/);
});

it("shows the leading campaign without an empty overlapping row and reads its forks in its popover", async () => {
  const body = fixture();
  expect(itemIds("Toolchain")).toEqual(
    ["os-core-common%208.5.0"].map((f) => `campaign:toolchain:${f}`),
  );
  expect(texts(group("Toolchain") ?? place(), ".place-item-title")).toEqual([
    "Detected: os-core-common 8.5.0 on 10 forks",
  ]);
  expect(place().querySelector(".place-folded")?.textContent).not.toContain(
    "os-core-common 10.0.0",
  );
  const recordIds = (upstreamReading(body).content?.items ?? []).flatMap((item) => item.ids);
  expect(new Set(recordIds).size).toBe(recordIds.length);
  const id = "campaign:toolchain:os-core-common%208.5.0";
  await click(itemButton(id));
  expect(openSelection()).toEqual({ kind: "item", id });
  expect(fields().Forks).toBe(
    body.campaigns.find((campaign) => campaign.id === id)?.forks.join(", "),
  );
  expect(fields().Forks).toBe(
    "crs-conversion, file, indexer, legal, partition, schema, search, storage, unit, workflow",
  );
  expect(selectionStore.getState()).toMatchObject({ selected: null, open: false });
});

it("refreshes an open campaign's popover when a sweep changes its forks", async () => {
  const id = "campaign:toolchain:os-core-common%208.5.0";
  await click(itemButton(id));
  expect(fields().Forks?.split(", ")).toContain("workflow");
  const body = fixture();
  const title = "Detected: os-core-common 8.5.0 on 9 forks";
  const swept: ViewSnapshot = {
    ...body,
    cursor: body.cursor + 1,
    campaigns: body.campaigns.map((campaign) =>
      campaign.id === id
        ? { ...campaign, forks: campaign.forks.filter((fork) => fork !== "workflow") }
        : campaign,
    ),
    readings: body.readings.map((reading) =>
      reading.anchor.kind === "upstream" && reading.content
        ? {
            ...reading,
            content: {
              ...reading.content,
              items: reading.content.items.map((item) =>
                item.id === id ? { ...item, title } : item,
              ),
            },
          }
        : reading,
    ),
  };
  await act(async () => load(swept));
  expect(openSelection()).toEqual({ kind: "item", id });
  expect(place().querySelector(`[data-item-id="${CSS.escape(id)}"]`)?.textContent).toContain(title);
  expect(fields().Forks).toBe(
    "crs-conversion, file, indexer, legal, partition, schema, search, storage, unit",
  );
  expect(popover()?.querySelector("h3")?.textContent).toBe(title);
});

it("lists Before next sync items as briefing records and opens a hold in the shared body", async () => {
  const body = fixture();
  const before = itemIds("Before 18:00");
  const briefing = [...body.briefing.focus, ...body.briefing.rest].map(({ id }) => id);
  expect(before.length).toBeGreaterThan(0);
  for (const id of before) expect(briefing).toContain(id);

  await click(itemButton("radar:legal"));
  expect(openSelection()).toEqual({ kind: "item", id: "radar:legal" });
  expect(selectionStore.getState()).toMatchObject({ selected: null, open: false });
  const opened = popover()?.querySelector(".opened-body");
  expect(opened?.querySelector("h3")?.textContent).toBe(
    "legal · upstream changes need a toolchain upgrade",
  );
  expect(opened?.querySelector(".opened-body-deadline time")?.textContent).toBe(
    "Before the next upstream sync, 18:00",
  );
  expect(opened?.querySelector(".opened-body-effect")?.textContent).toBe(
    "17 commits reach the fork at the 18:00 sync.",
  );
  expect(opened?.querySelector(".opened-body-step")?.textContent).toBe(
    "Absorb os-core-common 8.4.1-boot4-SNAPSHOT on the fork before the next Sync Upstream carries it.",
  );
  expect(
    [...(opened?.querySelectorAll(".opened-body-sources a") ?? [])].map((a) =>
      a.getAttribute("href"),
    )[0],
  ).toBe(
    "https://community.opengroup.org/osdu/platform/security-and-compliance/legal/-/commit/0cab109017b316cfd6a037c6c603ad4ee293f3c1",
  );
  expect(place().querySelector('[data-item-id="radar:legal"]')?.hasAttribute("data-selected")).toBe(
    true,
  );
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(popover()).toBeNull();
  expect(openSelection()).toBeNull();
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
  expect(itemIds("Before 18:00")).toEqual(["radar:legal", "gate1:indexer", "gate1:indexer-queue"]);
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
        field: `${t.id} popover`,
        expected: t.title,
        locate: async () => {
          await click(theme(t.id).querySelector(".upstream-theme-head"));
          return popover()?.querySelector("h3")?.textContent ?? undefined;
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
    await act(async () => setOpenSelection(null));
    expect({ field, value: await locate() }).toEqual({
      field,
      value: timedText(expected, { hint: false }),
    });
  }
});

it("opens every theme's next step, fork states and exposed forks in one click", async () => {
  const body = fixture();
  for (const entry of body.briefing.themes) {
    await act(async () => setOpenSelection(null));
    await click(theme(entry.id).querySelector(".upstream-theme-head"));
    expect(openSelection()).toEqual({ kind: "theme", id: entry.id });
    const opened = popover();
    expect(opened?.querySelector("h3")?.textContent).toBe(entry.title);
    if (entry.next)
      expect(opened?.querySelector(".opened-body-step")?.textContent).toBe(
        timedText(entry.next, { hint: false }),
      );
    const read = pairs();
    for (const list of ["certain", "possible"] as const)
      for (const fork of entry[list])
        expect(read).toContainEqual([
          fork.fork,
          timedText(`${list} · ${fork.state}`, { hint: false }),
        ]);
    for (const fork of entry.exposed) expect(read).toContainEqual([fork, "exposed"]);
    expect(read).toHaveLength(entry.certain.length + entry.possible.length + entry.exposed.length);
  }
  expect(selectionStore.getState()).toMatchObject({ selected: null, open: false });
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

it("opens the Line sheet filtered to the Upstream column from its Line view link", async () => {
  const body = fixture();
  const station = body.stations
    .find(({ service }) => service === "partition")
    ?.stations.find(({ id }) => id === "upstream");
  if (!station) throw new Error("Missing fixture station");
  station.text = "";
  await act(async () => load({ ...body, cursor: body.cursor + 1 }));
  const sheet = () => container.querySelector<HTMLElement>(".line-sheet");
  expect(sheet()).toBeNull();
  const link = [...container.querySelectorAll<HTMLButtonElement>("main header button")].find(
    (button) => button.textContent === "Line view",
  );
  await click(link);
  expect(sheet()?.dataset.presentation).toBe("overlay");
  expect(window.location.hash).toBe("#upstream");
  const chip = sheet()?.querySelector('[aria-label="Clear Upstream filter"]');
  expect(chip?.getAttribute("aria-pressed")).toBe("true");
  const rows = [...(sheet()?.querySelectorAll<HTMLElement>("tbody tr[data-service]") ?? [])].map(
    (row) => row.dataset.service,
  );
  expect(rows).not.toContain("partition");
  expect(rows).toEqual(
    body.stations
      .filter(({ stations }) => stations.some(({ id, text }) => id === "upstream" && text.trim()))
      .map(({ service }) => service),
  );
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
