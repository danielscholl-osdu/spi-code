// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PlaceRow } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { closeSheet, navigate } from "../../app/navigation.js";
import { placeFreshCases, placeReachCases } from "../../app/place-reachability.test-helper.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import Environment from "../../views/environment/index.js";
import Line from "../../views/line/index.js";
import Security from "../../views/security/index.js";
import Template from "../../views/template/index.js";

const loadFixture = fixtureLoader(readFixture);

const previous = watchStore.getState();
const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
let harness: ReturnType<typeof installSpi>;
beforeEach(() => {
  root = createRoot(container);
  closeSheet();
  localStorage.clear();
  harness = installSpi();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  watchStore.setState(previous, true);
  selectionStore.getState().clear();
  closeSheet();
  harness.restore();
});

const views = {
  line: <Line presentation="overlay" />,
  environment: <Environment />,
  engineering: <Template />,
  security: <Security />,
};
const marked = () =>
  [...container.querySelectorAll<HTMLElement>("[data-fresh-item]")].map(
    (element) => element.dataset.freshItem,
  );

it.each(Object.keys(views) as PlaceRow["place"][])(
  "%s marks exactly core's fresh ids, including items outside its capped reading",
  async (place) => {
    const body = loadFixture("snapshot-busy.json");
    const row = body.briefing.places?.find((row) => row.place === place);
    const reading = body.readings.find(
      ({ anchor }) => anchor.kind === (place === "line" ? "program" : place),
    );
    const item = reading?.content?.items[0];
    const extra = body.briefing.rest.find(({ cls }) => cls === "SECURITY");
    if (!row || !item || !extra) throw new Error("Missing recorded data");
    row.fresh.itemIds = [item.id, extra.id, "not-in-the-snapshot"];
    // A different place's freshness must not mark this place's other items.
    const other = body.briefing.places?.find((candidate) => candidate !== row);
    if (other) other.fresh.itemIds = reading.content?.items.slice(1).map(({ id }) => id) ?? [];
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    document.body.append(container);
    await act(async () => root.render(views[place]));
    expect(marked().sort()).toEqual([...new Set([item.id, extra.id])].sort());
    for (const chip of container.querySelectorAll("[data-fresh-item]")) {
      expect(chip.querySelector(".kit-chip--accent")).not.toBeNull();
      expect(chip.textContent).toBe("new");
    }
    expect([...container.querySelectorAll("h1,h2,h3")].some((h) => h.textContent === "new")).toBe(
      false,
    );
    const target = container.querySelector<HTMLButtonElement>(
      `.place-fresh-items [data-selection-id="${extra.id}"]`,
    );
    await act(async () => target?.click());
    expect(selectionStore.getState().selected).toBe(extra.id);

    for (const fresh of [{ itemIds: [] }, undefined]) {
      const next = structuredClone(body);
      const updated = next.briefing.places?.find((row) => row.place === place);
      if (!updated) throw new Error("Missing place");
      if (fresh) updated.fresh = fresh;
      else Reflect.deleteProperty(updated, "fresh");
      await act(async () => watchStore.setState({ snapshot: { cursor: body.cursor, body: next } }));
      expect(marked()).toEqual([]);
      expect(container.querySelector(".place-fresh-items")).toBeNull();
    }
  },
);

it("registers each new chip at its place and Today's opener, and opens all four destinations", async () => {
  const body = loadFixture("snapshot-busy.json");
  for (const row of body.briefing.places ?? []) {
    const reading = body.readings.find(
      ({ anchor }) => anchor.kind === (row.place === "line" ? "program" : row.place),
    );
    const item = reading?.content?.items[0];
    if (!item) throw new Error("Missing reading item");
    row.fresh.itemIds = [item.id];
  }
  const cases = placeFreshCases(body);
  expect(cases).toHaveLength(4);
  for (const row of cases) {
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    document.body.append(container);
    const route = row.home.start.route;
    const place = route.kind === "engineering-system" ? "engineering" : route.kind;
    if (!(place in views)) throw new Error("Unexpected place");
    await act(async () => root.render(views[place as keyof typeof views]));
    expect(container.querySelector(row.selector as string)?.getAttribute(row.attribute ?? "")).toBe(
      row.value,
    );
  }
  await act(async () => {
    navigate({ kind: "today" });
    root.render(<Shell />);
  });
  const openers = placeReachCases(body).filter(
    ({ opens, pointer }) => opens && pointer.includes("/fresh/"),
  );
  expect(openers).toHaveLength(4);
  for (const opener of openers) {
    await act(async () => navigate({ kind: "today" }));
    const opens = opener.opens;
    if (!opens || !("place" in opens)) throw new Error("Missing registered opener");
    const place = opens.place.kind;
    const button = container.querySelector<HTMLButtonElement>(opens.click as string);
    await act(async () => button?.click());
    if (place === "line") {
      expect(container.querySelector(".line-sheet [data-fresh-item]")).not.toBeNull();
    } else {
      expect(window.location.hash).toBe(`#${place}`);
    }
    const destination = place === "line" ? ".line-sheet" : "main";
    expect(container.querySelector(`${destination} [data-fresh-item]`)).not.toBeNull();
  }
});
