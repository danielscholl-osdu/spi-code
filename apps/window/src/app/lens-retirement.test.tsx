// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, installSpi } from "../test-utils/harness.js";
import { type LensField, lensFields } from "./lens-fields.test-helper.js";
import { closeSheet, navigate, relaunch } from "./navigation.js";
import { Shell } from "./Shell.js";

const loadFixture = fixtureLoader((path) => readFileSync(path, "utf8"));

const fixture = () => loadFixture("snapshot-1106.json");
const table = lensFields(fixture());
const homes = [...new Set(table.filter((row) => !row.exempt).map((row) => row.home))];
const previous = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  closeSheet();
  relaunch();
  localStorage.clear();
  window.location.hash = "#today";
  harness = installSpi();
  selectionStore.getState().clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  selectionStore.getState().clear();
  watchStore.setState(previous, true);
  harness.restore();
  closeSheet();
  relaunch();
  vi.unstubAllGlobals();
});

async function openHome(home: string, body = fixture()) {
  await act(async () => root.render(null));
  const [place, target] = home.split(" · ");
  await act(async () => {
    watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
    if (place?.startsWith("Service ")) navigate({ kind: "service", id: place.slice(8) });
    else if (place === "Today") navigate({ kind: "today" });
    else if (place === "Environment") navigate({ kind: "environment" });
    else if (place === "Engineering system") navigate({ kind: "engineering-system" });
    else navigate({ kind: "upstream" });
    root.render(<Shell />);
  });
  const selector =
    target === "Stack runs"
      ? '[data-part="runs"] > summary'
      : target === "Stack repository"
        ? '[data-part="repository"] > summary'
        : target === "Details"
          ? ".template-details > summary"
          : target === "Repository"
            ? '[data-section="repository"] > summary'
            : target === "Upstream sync Detail"
              ? "[data-service-detail='upstream']"
              : undefined;
  if (!selector) return;
  const button = container.querySelector<HTMLElement>(selector);
  expect(button, home).not.toBeNull();
  await act(async () => button?.click());
  if (button?.tagName === "SUMMARY") expect(button.closest("details")?.open, home).toBe(true);
}

function assertField(row: LensField) {
  const element = container.querySelector(row.selector);
  expect(element, row.pointer).not.toBeNull();
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) expect(ancestor.open, row.pointer).toBe(true);
    expect(ancestor.hasAttribute("hidden"), row.pointer).toBe(false);
    expect(getComputedStyle(ancestor).display, row.pointer).not.toBe("none");
    expect(getComputedStyle(ancestor).visibility, row.pointer).not.toBe("hidden");
  }
  const value = row.attribute ? element?.getAttribute(row.attribute) : element?.textContent;
  if (row.contains) expect(value, row.pointer).toContain(row.value);
  else expect(value, row.pointer).toBe(row.blank ? "" : row.value);
}

it.each(homes)("resolves every recorded lens field at %s in at most one click", async (home) => {
  await openHome(home);
  for (const row of table.filter((row) => row.home === home && !row.exempt)) assertField(row);
});

it("keeps the explicit pending-card and unread exemptions out of the resting window", async () => {
  await openHome("Environment · Stack runs");
  expect(container.querySelector("main")?.textContent).not.toContain("Waiting on you");
  expect(container.querySelector("main")?.textContent).not.toContain("0 presses in SPI Code");
  for (const home of [
    ...new Set(table.filter((row) => row.exempt?.startsWith("Unread")).map((row) => row.home)),
  ]) {
    await openHome(home);
    for (const row of table.filter(
      (row) => row.home === home && row.exempt?.startsWith("Unread"),
    )) {
      expect(container.querySelector(row.selector), row.pointer).toBeNull();
    }
  }
});

it("omits lane capacity when the snapshot has no Lanes tile", async () => {
  const body = fixture();
  body.briefing.flow.tiles = body.briefing.flow.tiles.filter(({ label }) => label !== "Lanes");
  await openHome("Environment · Stack runs", body);
  expect(container.querySelector("meter[aria-label='Lanes']")).toBeNull();
  expect(container.querySelector("main")?.textContent).not.toContain("0 of 5");
  expect(container.querySelector("main")?.textContent).not.toContain(
    "shared with the template rollout",
  );
});

it.each([
  [
    "/briefing/flow/tiles/1/meter/cap",
    "Environment · Stack runs",
    (body: ViewSnapshot) => {
      const tile = body.briefing.flow.tiles.find(({ label }) => label === "Lanes");
      if (!tile?.meter) throw new Error("Missing lane meter");
      tile.meter.cap = 6;
    },
  ],
  [
    "/briefing/flow/headline",
    "Environment · Stack runs",
    (body: ViewSnapshot) => {
      body.briefing.flow.headline = "Changed flow verdict";
    },
  ],
  [
    "/briefing/repositories/facts/0/figure",
    "Engineering system · Details",
    (body: ViewSnapshot) => {
      const fact = body.briefing.repositories.facts[0];
      if (!fact) throw new Error("Missing Issues fact");
      fact.figure = "15";
    },
  ],
  [
    "/briefing/repositories/headline",
    "Engineering system · Details",
    (body: ViewSnapshot) => {
      body.briefing.repositories.headline = "Changed repository verdict";
    },
  ],
  [
    "/briefing/horizon/headline",
    "Upstream · Further ahead",
    (body: ViewSnapshot) => {
      body.briefing.horizon.headline = "Changed horizon verdict";
    },
  ],
  [
    "/briefing/flow/plan/note",
    "Environment · Stack runs",
    (body: ViewSnapshot) => {
      body.briefing.flow.plan.note = "Changed plan note";
    },
  ],
  [
    "/briefing/flow/rows/0/tag",
    "Service crs-catalog · Upstream sync Detail",
    (body: ViewSnapshot) => {
      const row = body.briefing.flow.rows[0];
      if (!row) throw new Error("Missing Flow row");
      row.tag = "changed";
    },
  ],
] as const)("detects a source mutation at %s", async (pointer, home, mutate) => {
  const body = fixture();
  mutate(body);
  await openHome(home, body);
  const row = table.find((row) => row.pointer === pointer);
  if (!row) throw new Error(`Missing coverage for ${pointer}`);
  expect(() => assertField(row)).toThrow();
});

it.each(fixture().briefing.repositories.rows.map((repo, index) => [repo.name, index] as const))(
  "detects a per-repository count mutation in %s's disclosure",
  async (_name, index) => {
    const body = fixture();
    const repo = body.briefing.repositories.rows[index];
    if (!repo) throw new Error("Missing repository");
    repo.cells.issues.text = "91";
    const row = table.find(
      (row) => row.pointer === `/briefing/repositories/rows/${index}/cells/issues/text`,
    );
    if (!row) throw new Error("Missing repository count coverage");
    await openHome(row.home, body);
    expect(() => assertField(row)).toThrow();
  },
);

it("draws newly readable security fleet facts and hides either unread marker", async () => {
  const body = fixture();
  const fact = body.briefing.repositories.facts[3];
  if (!fact) throw new Error("Missing vulnerability fact");
  fact.figure = "7";
  fact.sub = "7 critical or high in shipped code";
  await openHome("Engineering system · Details", body);
  const selector = '[data-pointer="/briefing/repositories/facts/3"]';
  expect(container.querySelector(selector)?.textContent).toContain("Vulnerabilities · ours");
  expect(container.querySelector(`${selector} strong`)?.textContent).toBe("7");
  for (const figure of ["?", "not read yet"]) {
    fact.figure = figure;
    await act(async () =>
      watchStore.setState({ snapshot: { cursor: body.cursor, body: structuredClone(body) } }),
    );
    expect(container.querySelector(selector)).toBeNull();
  }
});
