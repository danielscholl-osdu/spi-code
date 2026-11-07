// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type WatchItem as FocusItem, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-59d6895.json?raw";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { inboxCount, queueGroups } from "./queue.js";
import { Shell } from "./Shell.js";

const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
const previous = watchStore.getState();
const previousSpi = window.spi;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.location.hash = "";
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  selectionStore.getState().clear();
  watchStore.setState(previous);
  window.spi = previousSpi;
  window.location.hash = "";
});

it("groups the queue by rung into Now, Next and Later in briefing order", () => {
  const [env, halt, rollout, legal, stack] = body.briefing.focus as [
    FocusItem,
    FocusItem,
    FocusItem,
    FocusItem,
    FocusItem,
  ];
  const later = (item: FocusItem) => ({ ...item, rung: 2 as const });
  const groups = queueGroups({ focus: [later(rollout), env, legal, later(stack), halt] });
  const titles = (label: string) =>
    groups.find((group) => group.label === label)?.entries.map(({ item }) => item.title);
  expect(groups.map(({ label }) => label)).toEqual(["Now", "Next", "Later"]);
  expect(titles("Now")).toEqual([env.title, halt.title]);
  expect(titles("Next")).toEqual([legal.title]);
  expect(titles("Later")).toEqual([rollout.title, stack.title]);
  expect(groups[2]?.entries[0]?.item.rung).toBe(2);
  expect(queueGroups({ focus: [env, halt] }).map(({ label }) => label)).toEqual(["Now"]);
});

it("shows the former Inbox pip once on Today as P0 plus P1", async () => {
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () => root.render(<Shell />));
  const count = inboxCount(body.briefing);
  const p0p1 = [...body.briefing.focus, ...body.briefing.rest].filter(({ rung }) => rung <= 1);
  expect(count).toBe(p0p1.length);
  expect(count).toBe(6);
  const pips = container.querySelectorAll(".sidebar-pip");
  expect(pips).toHaveLength(1);
  expect(pips[0]?.closest('ul[aria-label="Today"]')).not.toBeNull();
  const shown = [...container.querySelectorAll("*")].filter(
    (element) => element.children.length === 0 && element.textContent?.trim() === String(count),
  );
  expect(shown).toEqual([pips[0]]);
});
