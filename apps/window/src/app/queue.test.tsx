// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type WatchItem as FocusItem, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-59d6895.json?raw";
import current from "../../../../fixtures/watch/snapshot-1106.json?raw";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { relaunch } from "./navigation.js";
import { queueGroups } from "./queue.js";
import { Shell } from "./Shell.js";

const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
const previous = watchStore.getState();
const previousSpi = window.spi;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  relaunch();
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

it("keeps Today's distinct Interrupt count after foreground acknowledgement, until resolution", async () => {
  const fixture = ViewSnapshotSchema.parse(JSON.parse(current));
  const interrupt = fixture.briefing.focus[0];
  if (!interrupt) throw new Error("Recorded Interrupt missing");
  fixture.seen.since = [interrupt.id];
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  watchStore.setState({ snapshot: { cursor: fixture.cursor, body: fixture } });
  await act(async () => root.render(<Shell />));
  const pip = () => container.querySelector('ul[aria-label="Today"] .sidebar-pip');
  const drawnInterrupts = () =>
    [...fixture.briefing.focus, ...fixture.briefing.rest].filter(
      (item) =>
        item.attention === "interrupt" &&
        container.querySelector(`.today [data-selection-id="${item.id}"]`),
    );
  const acknowledgements = () =>
    vi
      .mocked(window.spi.postMessage)
      .mock.calls.map(([message]) => message)
      .filter((message) => message.type === "view.acknowledge")
      .map((message) => message.payload);
  expect(drawnInterrupts()).toHaveLength(1);
  expect(pip()?.textContent).toBe(String(drawnInterrupts().length));
  expect(container.querySelectorAll(".sidebar-pip")).toHaveLength(1);
  expect(acknowledgements()).toEqual([]);

  vi.mocked(document.hasFocus).mockReturnValue(true);
  await act(async () => window.dispatchEvent(new FocusEvent("focus")));
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
  expect(container.querySelector(".today .place-headline")?.textContent).toMatch(
    /^No new interruptions since /,
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
  expect(container.querySelector(`.today [data-selection-id="${interrupt.id}"]`)).toBeNull();
  expect(pip()).toBeNull();
});
