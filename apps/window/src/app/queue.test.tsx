// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { WatchItem as FocusItem } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, installSpi } from "../test-utils/harness.js";
import { relaunch } from "./navigation.js";
import { queueGroups } from "./queue.js";
import { Shell } from "./Shell.js";

const loadFixture = fixtureLoader((path) => readFileSync(path, "utf8"));

const body = loadFixture("snapshot-59d6895.json");
const previous = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  relaunch();
  window.location.hash = "";
  harness = installSpi();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  selectionStore.getState().clear();
  watchStore.setState(previous);
  harness.restore();
  window.location.hash = "";
  localStorage.clear();
  relaunch();
  vi.restoreAllMocks();
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

it("keeps Today's distinct Interrupt count after acknowledgement, until resolution", async () => {
  const fixture = loadFixture("snapshot-1106.json");
  const interrupt = fixture.briefing.focus[0];
  if (!interrupt) throw new Error("Recorded Interrupt missing");
  fixture.seen.since = [interrupt.id];
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  watchStore.setState({ snapshot: { cursor: fixture.cursor, body: fixture } });
  await act(async () => root.render(<Shell />));
  const pip = () => container.querySelector('ul[aria-label="Today"] .sidebar-pip');
  const interrupts = new Set(
    [...fixture.briefing.focus, ...fixture.briefing.rest]
      .filter(({ attention }) => attention === "interrupt")
      .map(({ id }) => id),
  );
  const acknowledgements = () =>
    vi
      .mocked(window.spi.postMessage)
      .mock.calls.map(([message]) => message)
      .filter((message) => message.type === "view.acknowledge")
      .map((message) => message.payload);
  expect(interrupts.size).toBe(1);
  expect(pip()?.textContent).toBe(String(interrupts.size));
  expect(container.querySelectorAll(".sidebar-pip")).toHaveLength(1);
  expect(acknowledgements()).toEqual([]);

  vi.mocked(document.hasFocus).mockReturnValue(true);
  await act(async () => window.dispatchEvent(new FocusEvent("focus")));
  expect(acknowledgements()).toEqual([]);
  await act(async () => window.dispatchEvent(new FocusEvent("blur")));
  expect(acknowledgements()).toEqual([{ cursor: fixture.cursor }]);
  expect(pip()?.textContent).toBe("1");

  const acknowledged = {
    ...fixture,
    cursor: fixture.cursor + 1,
    seen: { cursor: fixture.cursor, at: fixture.sweptAt, since: [] },
  };
  await act(async () =>
    watchStore.setState({ snapshot: { cursor: acknowledged.cursor, body: acknowledged } }),
  );
  expect(pip()?.textContent).toBe("1");

  const resolved = {
    ...acknowledged,
    cursor: acknowledged.cursor + 1,
    briefing: {
      ...acknowledged.briefing,
      focus: acknowledged.briefing.focus.filter(({ id }) => id !== interrupt.id),
      rest: acknowledged.briefing.rest.filter(({ id }) => id !== interrupt.id),
    },
  };
  await act(async () =>
    watchStore.setState({ snapshot: { cursor: resolved.cursor, body: resolved } }),
  );
  expect(pip()).toBeNull();
});
