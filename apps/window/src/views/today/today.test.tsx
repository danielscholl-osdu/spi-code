// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import Today from "./index.js";

const fixture = ViewSnapshotSchema.parse(JSON.parse(recorded));
const cleanups: (() => Promise<void>)[] = [];

async function mount(body: ViewSnapshot | null = fixture) {
  const port = { postMessage: vi.fn() };
  const store = createWatchStore(vi.fn(), createSelectionStore(port));
  if (body) store.setState({ snapshot: { cursor: body.cursor, body } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onNavigate = vi.fn();
  await act(async () => root.render(<Today store={store} onNavigate={onNavigate} />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, store, port, onNavigate };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const text = (container: Element, selector: string) =>
  [...container.querySelectorAll(selector)].map((element) => element.textContent);

function visibleText(container: Element): string {
  const copy = container.cloneNode(true) as Element;
  for (const details of copy.querySelectorAll("details:not([open])")) {
    for (const child of [...details.children]) {
      if (child.tagName !== "SUMMARY") child.remove();
    }
  }
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(node.textContent ?? "");
  }
  return parts.join(" ");
}

it("keeps the recorded brief near 75 visible words, with three named measures and no future parts", async () => {
  const { container } = await mount();
  const words = visibleText(container).trim().split(/\s+/);
  expect(words.length).toBeGreaterThanOrEqual(60);
  expect(words.length).toBeLessThanOrEqual(95);
  expect(text(container, ".place-tile-value")).toEqual(["v0.35.3", "1 of 13", "0 of 13"]);
  expect(text(container, ".place-tile-counts")).toEqual([
    "deployable",
    "forks stopped",
    "forks on 7d269b5",
  ]);
  expect(text(container, ".place-tile dt")).toEqual([
    "Environment",
    "Upstream sync",
    "Engineering system",
  ]);
  expect(container.querySelector("textarea, [contenteditable], [data-slot='composer']")).toBeNull();
  expect(container.textContent).not.toMatch(/Waiting for you|Owned|not available|gate 3|📊/u);
});

it("groups the five focus items by their typed due and ownership, never by P rank", async () => {
  const { container } = await mount();
  expect(container.querySelectorAll(".place-item")).toHaveLength(5);
  expect(text(container, ".place-group h3")).toEqual(["Before next sync", "New"]);
  expect(
    text(container, '[aria-label="Before next sync"] .place-item').map((value) => value?.trim()),
  ).toEqual([
    "P1indexercarries os-core-common 8.5.0",
    "P1legalcarries os-core-common 8.4.1-boot4-SNAPSHOT",
  ]);
  expect(text(container, '[aria-label="New"] .place-rank')).toEqual(["P0", "P1", "P1"]);
  expect(text(container, "summary")).toEqual(["12 more · 13 release PRs open, 1 failing"]);
  const owned = structuredClone(fixture);
  const item = owned.briefing.focus[3];
  if (!item) throw new Error("Recorded due item missing");
  item.owned = true;
  const next = await mount(owned);
  expect(text(next.container, ".place-group h3")).toEqual(["Before next sync", "Owned", "New"]);
  expect(
    next.container
      .querySelector('[aria-label="Owned"] [data-item-id]')
      ?.getAttribute("data-item-id"),
  ).toBe(item.id);
});

it("caps focus at five, folds ambient items and leaves empty groups out", async () => {
  const body = structuredClone(fixture);
  const first = body.briefing.focus[0];
  if (!first) throw new Error("Recorded focus missing");
  body.briefing.focus.push(
    { ...first, id: "sixth", title: "Sixth item" },
    { ...first, id: "seventh", title: "Seventh item" },
  );
  first.attention = "ambient";
  const { container } = await mount(body);
  expect(container.querySelectorAll(".place-item")).toHaveLength(5);
  expect(container.querySelector(`.place-item[data-item-id="${first.id}"]`)).toBeNull();
  expect(container.querySelector(`details [data-selection-id="${first.id}"]`)).not.toBeNull();
  const empty = await mount({
    ...fixture,
    briefing: { ...fixture.briefing, focus: [], rest: [], ready: [], more: 0 },
  });
  expect(empty.container.querySelector(".place-group, details")).toBeNull();
});

it("writes the headline from the acknowledged baseline and counts only newly arrived Interrupts", async () => {
  const at = "2026-11-06T17:40:00Z";
  const since = clockTime(at);
  for (const ids of [[], ["conflict:entitlements:121"], ["a", "b"]]) {
    const body = { ...fixture, seen: { cursor: 1, at, since: ids } };
    const { container } = await mount(body);
    expect(container.querySelector(".place-headline")?.textContent).toBe(
      `${ids.length === 0 ? "No" : ids.length} new interruption${ids.length === 1 ? "" : "s"} since ${since}.`,
    );
    expect(
      [...(container.querySelectorAll(".place-headline time") ?? [])].map((time) =>
        time.getAttribute("datetime"),
      ),
    ).toEqual([at]);
    expect(
      container.querySelector(".place-headline")?.textContent?.split(/\s+/).length,
    ).toBeLessThanOrEqual(12);
  }
  const first = await mount();
  expect(first.container.querySelector(".place-headline")?.textContent).toBe(
    "First look: 1 interruption needs you.",
  );
});

it("qualifies a failed or incomplete feeding source without claiming the reading is complete", async () => {
  const { container } = await mount();
  expect(container.querySelector(".place-qualifier")?.textContent).toBe(
    "Upstream radar read failed; items may be missing.",
  );
  const incomplete = structuredClone(fixture);
  const radar = incomplete.areas.find(({ area }) => area === "radar");
  if (!radar) throw new Error("Recorded radar source missing");
  radar.envelope = {
    source: radar.envelope.source,
    state: "incomplete",
    observedAt: fixture.sweptAt,
    completeness: { kind: "cut", read: 6, total: 13, reason: "budget" },
  };
  const cut = await mount(incomplete);
  expect(cut.container.querySelector(".place-qualifier")?.textContent).toBe(
    "Upstream radar incomplete; items may be missing.",
  );
  radar.envelope = {
    source: radar.envelope.source,
    state: "fresh",
    observedAt: fixture.sweptAt,
    completeness: { kind: "complete" },
  };
  const fresh = await mount(incomplete);
  expect(fresh.container.querySelector(".place-qualifier")).toBeNull();
});

it("keeps every former Inbox item readable in one click and selectable through inspect.request", async () => {
  const { container, store, port, onNavigate } = await mount();
  const details = container.querySelector("details");
  const summary = details?.querySelector("summary");
  if (!details || !summary) throw new Error("Missing folded queue");
  expect(details.open).toBe(false);
  const all = [...fixture.briefing.focus, ...fixture.briefing.rest];
  const initial = visibleText(container);
  await act(async () => summary.click());
  expect(details.open).toBe(true);
  for (const item of all) {
    const button = container.querySelector<HTMLButtonElement>(`[data-selection-id="${item.id}"]`);
    if (!button) throw new Error(`Missing former Inbox item ${item.id}`);
    expect(button.closest("details")?.open ?? true).toBe(true);
    expect(visibleText(container)).toContain(button.textContent);
    if (!initial.includes(button.textContent ?? ""))
      expect(button.closest("details")).toBe(details);
    await act(async () => button.click());
    expect(store.getState().selection?.id).toBe(item.id);
    expect(port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "inspect.request", payload: { id: item.id } }),
    );
  }
  for (const ready of fixture.briefing.ready) {
    const button = container.querySelector<HTMLButtonElement>(`[data-selection-id="${ready.id}"]`);
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(store.getState().selection?.id).toBe(ready.id);
  }
  const scope = container.querySelector<HTMLButtonElement>('.place-scope[title="Open legal"]');
  await act(async () => scope?.click());
  expect(onNavigate).toHaveBeenLastCalledWith({ kind: "service", id: "legal" });
});

it("shows only named sweep.status fields before the first snapshot and does not auto-select", async () => {
  const { container, store, port } = await mount(null);
  await act(async () =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: "sweep",
      kind: "event",
      type: "sweep.status",
      payload: {
        remaining: 123,
        floor: 100,
        resetAt: null,
        deferredAreas: [{ area: "radar", reason: "budget" }],
      },
    }),
  );
  expect(text(container, "dt")).toEqual(["remaining", "floor", "resetAt", "deferredAreas"]);
  expect(container.textContent).toContain("123 API calls");
  expect(container.textContent).toContain("radar: budget");
  expect(container.querySelector(".place-tiles, .place-group, details")).toBeNull();
  await act(async () => store.setState({ snapshot: { cursor: fixture.cursor, body: fixture } }));
  expect(container.querySelectorAll(".place-tile")).toHaveLength(3);
  expect(store.getState().selection).toBeNull();
  expect(port.postMessage).not.toHaveBeenCalled();
});
