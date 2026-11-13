// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type InspectResult,
  type Message,
  PROTOCOL_VERSION,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import november from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { RouteView } from "../../app/routes.js";
import { selectionStore } from "../../panels/selection.js";
import { watchStore } from "../../store/watch.js";
import { watchFixtureText } from "../../test-utils/watch-fixtures.test-helper.js";
import Releases, { ReleaseMonth } from "./index.js";

const recorded = watchFixtureText("snapshot-59d6895.json", readFixture);

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const previous = watchStore.getState();
let bridge: Window["spi"];
const listeners = new Set<(input: unknown) => void>();
const send = vi.fn<(message: Message) => void>();
const snapshot = () => ViewSnapshotSchema.parse(JSON.parse(november));

beforeEach(() => {
  bridge = window.spi;
  window.spi = {
    proof: false,
    postMessage: send,
    openExternal: vi.fn(async () => true),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  send.mockClear();
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  watchStore.setState(previous);
  selectionStore.getState().clear();
  window.spi = bridge;
  window.location.hash = "";
  listeners.clear();
});

it("renders November's releases reading, not the former static introduction or release-month headline", async () => {
  const body = snapshot();
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () => root.render(<RouteView route={{ kind: "releases" }} />));
  const reading = body.readings.find(({ anchor }) => anchor.kind === "releases")?.content;
  if (!reading) throw new Error("Missing recorded releases reading");
  const section = container.querySelector('[aria-label="Releases reading"]');
  expect(section?.querySelector("h2")?.textContent).toBe(reading.headline);
  expect([...container.querySelectorAll(".place-tile")].map((tile) => tile.textContent)).toEqual(
    reading.tiles.map((tile) => `${tile.label}${tile.value}${tile.counts}`),
  );
  expect(container.querySelectorAll(".place-item")).toHaveLength(reading.items.length);
  for (const item of reading.items) {
    const row = container.querySelector(`[data-item-id="${item.id}"]`);
    expect(row?.querySelector(".place-item-title")?.textContent).toBe(item.title);
    expect(row?.querySelector(".place-item-sub")?.textContent).toBe(item.sub);
    expect(row?.closest(".place-group")?.querySelector("h3")?.textContent).toBe(item.group);
  }
  expect(container.querySelector(".place-folded")?.textContent).toBe(reading.folded);
  expect(container.textContent).not.toContain("Monthly release notes for SPI consumers.");
  await act(async () => container.querySelector<HTMLButtonElement>(".place-scope")?.click());
  expect(window.location.hash).toBe("#service/entitlements");
});

it("updates the reading from the snapshot and omits absent reading, groups, months and future parts", async () => {
  const body = snapshot();
  const reading = body.readings.find(({ anchor }) => anchor.kind === "releases");
  if (!reading?.content) throw new Error("Missing recorded releases reading");
  reading.content.qualifier = "One release read failed, so months could be missing.";
  body.releases.lines = [];
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () => root.render(<Releases />));
  expect(container.querySelector(".place-qualifier")?.textContent).toBe(reading.content.qualifier);
  expect(container.querySelector(".release-months")).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.textContent).not.toMatch(
    /Threads|composer|not available yet|gate 3|fork_upstream/i,
  );
  reading.content.items = [];
  reading.content.folded = null;
  delete reading.content.qualifier;
  await act(async () =>
    watchStore.setState({ snapshot: { cursor: body.cursor + 1, body: structuredClone(body) } }),
  );
  expect(container.querySelector(".place-groups")).toBeNull();
  expect(container.querySelector(".place-folded")).toBeNull();
  expect(container.querySelector(".place-qualifier")).toBeNull();
  reading.content = null;
  await act(async () =>
    watchStore.setState({ snapshot: { cursor: body.cursor + 2, body: structuredClone(body) } }),
  );
  expect(container.querySelector('[aria-label="Releases reading"]')).toBeNull();
});

it("keeps every former Releases field one click away through its recorded month anchor", async () => {
  const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  const months = [...body.releases.lines].sort((a, b) => b.month.localeCompare(a.month));
  for (const line of months) {
    await act(async () => root.render(<Releases />));
    const row = container.querySelector(`[data-rel="${line.id}"]`);
    expect(row?.querySelector(".release-name")?.textContent).toBe(`SPI ${line.name}`);
    expect(row?.querySelector("[data-notes]")?.getAttribute("data-notes")).toBe(line.notes);
    expect(row?.textContent).toContain(line.stateText);
    expect(row?.textContent).toContain(line.headline);
    await act(async () => row?.querySelector<HTMLButtonElement>(".release-name")?.click());
    expect(window.location.hash).toBe(`#release/${line.month}`);
    await act(async () =>
      root.render(<RouteView route={{ kind: "release", month: line.month }} />),
    );
    expect(container.querySelector("h1")?.textContent).toBe(`SPI ${line.name}`);
    expect(container.querySelector(".place-headline")?.textContent).toBe(line.headline);
    expect(container.querySelector(".place-tile-counts")?.textContent).toBe(line.stateText);
    expect(
      [...container.querySelectorAll(".pane-fact")].map((fact) => ({
        short: fact.querySelector(".pane-fact-short")?.textContent,
        figure: fact.querySelector("strong")?.textContent,
        label: fact.querySelector("div")?.textContent,
        anchor: fact.getAttribute("data-anchor"),
      })),
    ).toEqual(
      line.stats.map(({ short, figure, label, anchor }) => ({ short, figure, label, anchor })),
    );
    expect(container.querySelector('[aria-label="Threads"]')).toBeNull();
  }
  const line = body.releases.lines[0];
  if (!line) throw new Error("Missing recorded release month");
  line.keyChanges = ["Review the updated provider configuration."];
  watchStore.setState({ snapshot: { cursor: body.cursor + 1, body: structuredClone(body) } });
  await act(async () => root.render(<ReleaseMonth month={line.month} />));
  expect(container.querySelector('[aria-label="Key changes"] li')?.textContent).toBe(
    line.keyChanges[0],
  );
  const request = send.mock.lastCall?.[0];
  if (!request) throw new Error("Missing release document request");
  const related: InspectResult["related"] = [
    { state: "Highlight", text: "Provider configuration updated." },
    { state: "Services: changed", text: "Use the updated provider configuration." },
    { state: "open", text: "Configuration issue remains open." },
    {
      state: "released",
      text: "partition: 1.0.0",
      url: "https://github.com/Azure/osdu-spi-partition/releases",
    },
    {
      state: "Releases",
      text: "Release history",
      url: "https://github.com/Azure/osdu-spi/releases",
    },
  ];
  await act(async () => {
    for (const listener of listeners)
      listener({
        version: PROTOCOL_VERSION,
        kind: "response",
        id: request.id,
        type: "inspect.result",
        payload: {
          id: line.id,
          class: "READY",
          cause: line.headline,
          effect: line.stateText,
          next: "",
          why: "",
          evidence: [],
          actions: [],
          approval: null,
          related,
        },
      });
  });
  expect(
    [...container.querySelectorAll("[data-related-state]")].map((entry) => entry.textContent),
  ).toEqual(related.map((entry) => `${entry.state}${entry.text}`));
  for (const link of container.querySelectorAll<HTMLAnchorElement>('[aria-label="Document"] a')) {
    await act(async () => link.click());
    expect(window.spi.openExternal).toHaveBeenLastCalledWith(link.href);
  }
});

it("renders November's month as a place: its reading first, then its figures and document", async () => {
  const body = snapshot();
  const [line] = body.releases.lines;
  const reading = body.readings.find(
    ({ anchor }) => anchor.kind === "release-month" && anchor.month === line?.month,
  )?.content;
  if (!line || !reading) throw new Error("Missing recorded November month reading");
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () => root.render(<RouteView route={{ kind: "release", month: line.month }} />));
  const page = container.querySelector(`[data-rel-detail="${line.id}"]`);
  const place = page?.firstElementChild;
  expect(place?.matches("section.place")).toBe(true);
  expect(place?.querySelector("h1")?.textContent).toBe("SPI 2026.11");
  expect(place?.querySelector(".place-header button")?.textContent).toBe("Detail");
  const section = place?.querySelector('[aria-label="SPI 2026.11 reading"]');
  expect(section?.querySelector(".place-headline")?.textContent).toBe(line.headline);
  expect([...(section?.querySelectorAll(".place-tile") ?? [])].map((t) => t.textContent)).toEqual([
    "NotesNo notes yetIn progress, closes Nov 30",
    "Services released?/13services released from SPI forks",
    "Actions?actions not reviewed yet",
  ]);
  for (const absent of [".place-groups", ".place-folded", ".place-qualifier"])
    expect(section?.querySelector(absent), absent).toBeNull();
  const figures = page?.querySelector('[aria-label="Figures"]');
  expect(figures && section?.compareDocumentPosition(figures)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect([...(figures?.querySelectorAll(".pane-fact") ?? [])].map((f) => f.textContent)).toEqual(
    line.stats.map(({ short, figure, label }) => `${short}${figure}${label}`),
  );
  expect(page?.querySelector('[role="status"]')?.textContent).toBe("Reading release document…");
  expect(page?.textContent).not.toMatch(/Threads|composer|not available yet/i);
  for (const empty of page?.querySelectorAll("h1, h2, h3, h4, ul, dl") ?? [])
    expect(empty.textContent?.trim(), empty.outerHTML).not.toBe("");

  const unread = body.readings.find(({ anchor }) => anchor.kind === "release-month");
  if (unread) unread.content = null;
  await act(async () =>
    watchStore.setState({ snapshot: { cursor: body.cursor + 1, body: structuredClone(body) } }),
  );
  expect(container.querySelector('[aria-label="SPI 2026.11 reading"]')).toBeNull();
  expect(container.querySelectorAll('[aria-label="Figures"] .pane-fact')).toHaveLength(
    line.stats.length,
  );
});
