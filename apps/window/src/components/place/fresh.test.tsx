// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PlaceRow } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { closeSheet, openSelection, setOpenSelection } from "../../app/navigation.js";
import { placeFreshCases } from "../../app/place-reachability.test-helper.js";
import { selectionStore } from "../../panels/selection.js";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import Environment from "../../views/environment/index.js";
import Line from "../../views/line/index.js";
import Security from "../../views/security/index.js";
import Template from "../../views/template/index.js";
import * as OpenedBodyView from "../opened-body/OpenedBody.js";
import { FreshItems } from "./FreshItems.js";

const loadFixture = fixtureLoader(readFixture);

const previous = watchStore.getState();
const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
let harness: ReturnType<typeof installSpi>;
beforeEach(() => {
  root = createRoot(container);
  closeSheet();
  setOpenSelection(null);
  localStorage.clear();
  harness = installSpi();
  selectionStore.getState().setOpen(false);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  watchStore.setState(previous, true);
  selectionStore.getState().clear();
  closeSheet();
  setOpenSelection(null);
  harness.restore();
  vi.restoreAllMocks();
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
    const own = reading?.content?.items[0]?.id;
    const extra = body.briefing.rest.find(({ cls }) => cls === "SECURITY");
    if (!row || !reading?.content || !extra) throw new Error("Missing recorded data");
    const ids = own ? [own, extra.id] : [extra.id];
    row.fresh.itemIds = [...ids, "not-in-the-snapshot"];
    // A different place's freshness must not mark this place's other items.
    const other = body.briefing.places?.find((candidate) => candidate !== row);
    if (other) other.fresh.itemIds = reading.content?.items.slice(1).map(({ id }) => id) ?? [];
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    document.body.append(container);
    await act(async () => root.render(views[place]));
    expect(marked().sort()).toEqual([...new Set(ids)].sort());
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
    expect(openSelection()).toEqual({ kind: "fresh-item", id: extra.id });
    expect(container.querySelector(".place-fresh-body .opened-body")).not.toBeNull();
    const onToday = body.briefing.lines?.some(({ members }) =>
      members.some((member) => member.id === extra.id || member.ids.includes(extra.id)),
    );
    expect(container.querySelector(".place-fresh-body .opened-body-place") !== null).toBe(
      Boolean(onToday),
    );
    expect(selectionStore.getState().open).toBe(false);

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

it("registers each new chip at its place", async () => {
  const body = loadFixture("snapshot-busy.json");
  const seeded: string[] = [];
  for (const row of body.briefing.places ?? []) {
    const reading = body.readings.find(
      ({ anchor }) => anchor.kind === (row.place === "line" ? "program" : row.place),
    );
    if (!reading?.content) throw new Error("Missing reading");
    const item = reading.content.items[0];
    if (item) {
      row.fresh.itemIds = [item.id];
      seeded.push(row.place);
    }
  }
  // The busy sweep's Environment reading has no item: its re-run item belongs to the fork.
  expect(seeded.sort()).toEqual(["engineering", "line", "security"]);
  const cases = placeFreshCases(body);
  expect(cases).toHaveLength(seeded.length);
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
});

it.each(["security", undefined] as const)(
  "fresh item body uses its home, falling back to the viewed place (home %s)",
  async (home) => {
    const openedBody = vi.spyOn(OpenedBodyView, "OpenedBody");
    const body = loadFixture("snapshot-busy.json");
    const member = body.briefing.lines
      ?.flatMap(({ members }) => members)
      .find(({ home }) => home === "security");
    const place = body.briefing.places?.find(({ place }) => place === "engineering");
    if (!member || !place) throw new Error("Missing fresh security member");
    if (home) member.home = home;
    else delete member.home;
    place.fresh.itemIds = [member.id];
    document.body.append(container);
    await act(async () => root.render(<FreshItems snapshot={body} place="engineering" />));
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".place-item-content")?.click(),
    );
    expect(openedBody.mock.lastCall?.[0].content.place).toEqual({
      label: home ? "Security" : "Template",
      destination: { kind: home ? "security" : "engineering-system" },
    });
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    await act(async () =>
      root.render(<FreshItems snapshot={structuredClone(body)} place="engineering" />),
    );
    expect(added.mock.calls.filter(([type]) => type === "pointerdown")).toHaveLength(0);
    expect(removed.mock.calls.filter(([type]) => type === "pointerdown")).toHaveLength(0);
    added.mockRestore();
    removed.mockRestore();
  },
);
