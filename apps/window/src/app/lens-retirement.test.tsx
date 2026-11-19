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
import { navigate, relaunch } from "./navigation.js";
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
    else if (place === "Template") navigate({ kind: "engineering-system" });
    else navigate({ kind: "upstream" });
    root.render(<Shell />);
  });
  const selector =
    target === "Stack repository"
      ? ".env-repository-pill"
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

it("keeps the explicit unread exemptions out of the resting window", async () => {
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

it.each([
  [
    "/briefing/repositories/facts/0/figure",
    "Template · Details",
    (body: ViewSnapshot) => {
      const fact = body.briefing.repositories.facts[0];
      if (!fact) throw new Error("Missing Issues fact");
      fact.figure = "15";
    },
  ],
  [
    "/briefing/repositories/headline",
    "Template · Details",
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
] as const)("detects a source mutation at %s", async (pointer, home, mutate) => {
  const body = fixture();
  mutate(body);
  await openHome(home, body);
  const row = table.find((row) => row.pointer === pointer);
  if (!row) throw new Error(`Missing coverage for ${pointer}`);
  expect(() => assertField(row)).toThrow();
});

const drawnRepositories = fixture()
  .briefing.repositories.rows.map((repo, index) => [repo.name, index] as const)
  .filter(([, index]) =>
    table.some(
      (row) =>
        row.pointer === `/briefing/repositories/rows/${index}/cells/issues/text` && !row.exempt,
    ),
  );

it.each(drawnRepositories)(
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
  await openHome("Template · Details", body);
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
