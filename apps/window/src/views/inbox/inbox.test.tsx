// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type WatchBriefing as Briefing,
  type WatchItem as FocusItem,
  type SweepStatus,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-59d6895.json?raw";
import { DEFAULT_REGISTRY, navigate } from "../../app/routes.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { createWatchStore, watchStore } from "../../store/watch.js";
import Inbox from "./index.js";
import { inboxCount } from "./queue.js";

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

function storeWith(briefing: Briefing = body.briefing) {
  const store = createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: body.cursor, body: { ...body, briefing } } });
  return store;
}

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

const section = (name: string) => container.querySelector(`[data-section="${name}"]`);
const titles = (name: string) =>
  [...(section(name)?.querySelectorAll(".inbox-row-title") ?? [])].map((row) => row.textContent);

it("renders every section of a recorded sweep with its data", async () => {
  await render(<Inbox store={storeWith()} onNavigate={vi.fn()} />);
  expect(container.querySelector("h1")?.textContent).toBe("Inbox");
  expect(container.querySelector(".inbox-tool-sub")?.textContent).toBe("5 in focus · 1 more");
  expect(container.querySelector(".inbox-head")?.textContent).toBe(body.briefing.headline);
  expect(container.querySelector(".inbox-summary")?.textContent).toBe(body.briefing.summary);
  expect(
    [...container.querySelectorAll(".inbox-fact")].map((fact) => [
      fact.querySelector(".inbox-fact-label")?.textContent,
      fact.querySelector(".inbox-fact-figure")?.textContent,
      fact.getAttribute("data-tone"),
    ]),
  ).toEqual([
    ["Environment", "v0.28.0", "warn"],
    ["Upstream sync", "2 of 5", "bad"],
    ["Template · main bb49a03", "0 of 5", "warn"],
  ]);
  expect(section("waiting")?.textContent).toBe("Waiting for youApprovals are not available yet.");
  expect(titles("now")).toEqual(["Maintenance mode", "Sync halted on schemathesis-tests"]);
  expect(titles("next")).toEqual([
    "Rollout to template bb49a03",
    "Sync PR #31 fails Java Build",
    "1 outside PR waits for workflow approval",
  ]);
  expect(section("later")).toBeNull();
  const fold = section("more") as HTMLDetailsElement;
  expect(fold.open).toBe(false);
  expect(fold.querySelector("summary")?.textContent).toBe("1 more in the queue");
  expect(titles("more")).toEqual(["3 upstream provider changes not ported"]);
  expect(section("ready")?.textContent).toBe("Ready, no rush: 1 release PR");
  expect(section("now")?.querySelector(".inbox-evidence")?.textContent).toBe(
    "9 of 9 sources not fresh · stale · inferred",
  );
});

it("groups the queue by rung into Now, Next and Later in briefing order", async () => {
  const [env, halt, rollout, legal, stack] = body.briefing.focus as [
    FocusItem,
    FocusItem,
    FocusItem,
    FocusItem,
    FocusItem,
  ];
  const later = (item: FocusItem) => ({ ...item, rung: 2 as const });
  const briefing = {
    ...body.briefing,
    focus: [later(rollout), env, legal, later(stack), halt],
  };
  await render(<Inbox store={storeWith(briefing)} onNavigate={vi.fn()} />);
  expect(
    [...container.querySelectorAll("[data-section] h2")].map((heading) => heading.textContent),
  ).toEqual(["Waiting for you", "Now", "Next", "Later"]);
  expect(titles("now")).toEqual([env.title, halt.title]);
  expect(titles("next")).toEqual([legal.title]);
  expect(titles("later")).toEqual([rollout.title, stack.title]);
  expect(section("later")?.querySelector(".inbox-priority")?.textContent).toBe("P2");
});

it("routes a scope chip to the thing's page and keeps the row selected there", async () => {
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await render(
    <Shell
      registry={{
        ...DEFAULT_REGISTRY,
        views: { ...DEFAULT_REGISTRY.views, today: () => <Inbox onNavigate={navigate} /> },
      }}
    />,
  );
  const row = container.querySelector('[data-selection-id="halt:entitlements"]');
  const chip = row?.querySelector<HTMLButtonElement>("button.inbox-scope");
  expect(chip?.textContent).toBe("entitlements");
  await act(async () => chip?.click());
  expect(window.location.hash).toBe("#service/entitlements");
  expect(container.querySelector("header [data-place]")?.textContent).toBe("entitlements");
  expect(watchStore.getState().selection).toEqual({ id: "halt:entitlements" });
  expect(window.spi.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "inspect.request" }),
  );
  await act(async () => {
    window.location.hash = "#inbox";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(
    container
      .querySelector('[data-selection-id="halt:entitlements"]')
      ?.hasAttribute("data-selected"),
  ).toBe(true);
  const fleet = container.querySelector('[data-selection-id="rollout"] .inbox-scope');
  expect(fleet?.tagName).toBe("SPAN");
});

it("shows the former Inbox pip once on Today as P0 plus P1", async () => {
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await render(<Shell />);
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

it("shows only sweep.status by field before the first sweep", async () => {
  const sweep: SweepStatus = {
    remaining: 412,
    floor: 500,
    resetAt: "2026-10-12T22:30:00.000Z",
    deferredAreas: [{ area: "security", reason: "below the floor" }],
  };
  const store = createWatchStore(vi.fn());
  store.setState({ snapshot: null, sweep });
  await render(<Inbox store={store} onNavigate={vi.fn()} />);
  const fields = [...container.querySelectorAll("[data-sweep-status] [data-field]")];
  expect(fields.map((field) => field.querySelector("dt")?.textContent)).toEqual([
    "remaining",
    "floor",
    "resetAt",
    "deferredAreas",
  ]);
  expect(fields[0]?.querySelector("dd")?.textContent).toBe("412 API calls");
  expect(fields[1]?.querySelector("dd")?.textContent).toBe("500 API calls");
  expect(fields[2]?.querySelector("time")?.getAttribute("dateTime")).toBe(sweep.resetAt);
  expect(fields[3]?.querySelector("dd")?.textContent).toBe("security: below the floor");
  expect(container.querySelector(".inbox-head")).toBeNull();
  expect(container.querySelector("[data-section]")).toBeNull();
  expect(container.querySelector(".inbox-facts")).toBeNull();

  await act(async () =>
    store.setState({
      sweep: { remaining: null, resetAt: null, deferredAreas: [] },
    }),
  );
  expect(
    [...container.querySelectorAll("[data-sweep-status] dd")].map((value) => value.textContent),
  ).toEqual(["unknown", "none", "unknown", "none"]);
});
