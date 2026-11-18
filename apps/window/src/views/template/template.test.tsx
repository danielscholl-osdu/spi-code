// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { openSelection, setOpenSelection } from "../../app/navigation.js";
import { Shell } from "../../app/Shell.js";
import { createSelectionStore, selectionStore } from "../../panels/selection.js";
import { createWatchStore, watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { timedText } from "../../time.js";
import Template from "./index.js";

const loadFixture = fixtureLoader(readFixture);
const snapshot = () => loadFixture("snapshot-1106.json");
const previous = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.location.hash = "";
  harness = installSpi({ openExternal: async () => true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => setOpenSelection(null));
  await act(async () => root.unmount());
  container.remove();
  selectionStore.getState().clear();
  watchStore.setState(previous);
  harness.restore();
  window.location.hash = "";
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

async function mount(body: ViewSnapshot = snapshot()) {
  const selection = createSelectionStore({ postMessage: vi.fn() });
  const store = createWatchStore(vi.fn(), selection);
  store.setState({ snapshot: { cursor: body.cursor, body } });
  await render(<Template store={store} />);
  return { store, selection };
}

async function click(selector: string) {
  const target = container.querySelector<HTMLElement>(selector);
  expect(target, `Missing one-click target ${selector}`).not.toBeNull();
  await act(async () => target?.click());
  return target;
}

async function openDetails() {
  const summary = await click(".template-details > summary");
  expect(summary?.closest("details")?.open).toBe(true);
}

const part = (name: string) => container.querySelector(`[data-part="${name}"]`);
const parts = () =>
  [...container.querySelectorAll("[data-part]")].map((node) => node.getAttribute("data-part"));
const popover = () => container.querySelector<HTMLElement>(".popover");

it("renders the engineering reading with verified-on-target, open-PR and rollout tiles", async () => {
  const body = snapshot();
  const reading = body.readings.find(({ anchor }) => anchor.kind === "engineering")?.content;
  expect(reading).toBeTruthy();
  // The merged/adopted fact is not the reading's verified-on-target measure.
  const template = body.briefing.repositories.template;
  if (template) template.figure = "13 of 13";
  await mount(body);
  expect(container.querySelector(".place h1")?.textContent).toBe("Template");
  expect(container.querySelector(".place")?.getAttribute("aria-label")).toBe("Template");
  expect(container.querySelector(".place-headline")?.textContent).toBe(reading?.headline);
  expect(
    container.querySelector(".place-headline")?.textContent?.split(/\s+/).length,
  ).toBeLessThanOrEqual(12);
  expect(
    [...container.querySelectorAll(".place-tile")].map((tile) =>
      ["dt", ".place-tile-value", ".place-tile-counts"].map(
        (selector) => tile.querySelector(selector)?.textContent,
      ),
    ),
  ).toEqual([
    ["Template", "0 of 13", "forks on 7d269b5"],
    ["Template PRs", "13", "open across the forks"],
    ["Rollout", "In progress", "13 forks left to verify"],
  ]);
  expect(container.querySelector(".place-item-title")?.textContent).toBe(
    "Rollout to template 7d269b5",
  );
  expect(container.querySelectorAll(".place-item")).toHaveLength(reading?.items.length ?? 0);
  expect(container.querySelector(".place-folded")?.textContent).toBe(reading?.folded);
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector(".place")?.nextElementSibling?.className).toBe("template-details");
});

it("opens a reading item in the shared popover, leaving the panel closed", async () => {
  const { selection } = await mount();
  await click('.place-item-content[data-selection-id="rollout"]');
  expect(openSelection()).toEqual({ kind: "item", id: "rollout" });
  expect(selection.getState()).toMatchObject({ selected: null, open: false });
  expect(popover()?.querySelector("h3")?.textContent).toMatch(/^fleet · /);
  expect(container.querySelector<HTMLDetailsElement>(".template-details")?.open).toBe(false);
});

it.each([
  ["November", "snapshot-1106.json"],
  ["October", "snapshot-59d6895.json"],
] as const)(
  "keeps every former Template field one disclosure away in the %s sweep",
  async (_name, fixture) => {
    const body = loadFixture(fixture);
    const fact = body.briefing.repositories.template;
    const rollout = [...body.briefing.focus, ...body.briefing.rest].find(
      ({ id }) => id === "rollout",
    );
    const repository = body.briefing.repositories.rows.find(({ name }) => name === "osdu-spi");
    if (!fact || !rollout || !repository) throw new Error("Recorded Template fields missing");
    await mount(body);
    await openDetails();
    expect(parts()).toEqual(["fact", "rollout", "repository"]);
    const factNode = part("fact")?.querySelector(".inbox-fact");
    expect(factNode?.getAttribute("data-pointer")).toBe("/briefing/repositories/template");
    expect(factNode?.getAttribute("data-tone")).toBe(fact.tone);
    expect(
      [".inbox-fact-label", ".inbox-fact-figure", ".inbox-fact-sub"].map(
        (selector) => factNode?.querySelector(selector)?.textContent,
      ),
    ).toEqual([fact.label, fact.figure, fact.sub]);
    const queue = part("rollout");
    for (const [selector, value] of [
      [".inbox-priority", `P${rollout.rung}`],
      [".inbox-scope", rollout.scope],
      [".inbox-row-title", rollout.title],
      [".inbox-class", rollout.cls],
      [".inbox-sub", rollout.sub],
    ])
      expect(queue?.querySelector(selector ?? "")?.textContent).toBe(value);
    expect(
      [...(queue?.querySelectorAll(".template-detail > div") ?? [])].map((line) => ({
        label: line.querySelector("dt")?.textContent,
        text: line.querySelector("dd")?.textContent,
      })),
    ).toEqual(
      rollout.more?.map(({ label, text }) => ({ label, text: timedText(text, { hint: false }) })),
    );
    const repoNode = part("repository");
    expect(repoNode?.querySelector(".inbox-section-count")?.textContent).toBe(repository.name);
    expect(repoNode?.querySelector(".template-repo-title")?.textContent).toBe(repository.title);
    expect(repoNode?.querySelector(".template-repo-title")?.getAttribute("data-tone")).toBe(
      repository.tone,
    );
    expect(repoNode?.querySelector(".template-repo-lead .template-line-sub")?.textContent).toBe(
      repository.sub,
    );
    expect(repoNode?.querySelector(".template-note")?.textContent).toBe(repository.note);
    const sections = repoNode?.querySelectorAll(".template-repo-section");
    expect(sections).toHaveLength(repository.sections.length);
    for (const [sectionIndex, section] of repository.sections.entries()) {
      const sectionNode = sections?.[sectionIndex];
      expect(sectionNode?.getAttribute("data-weight")).toBe(section.weight ?? null);
      expect(sectionNode?.querySelector("h3")?.textContent).toBe(
        `${section.title} ${section.count}${section.rest ?? ""}`,
      );
      const lines = sectionNode?.querySelectorAll(".template-lines li");
      expect(lines).toHaveLength(section.lines.length);
      for (const [index, line] of section.lines.entries()) {
        expect(lines?.[index]?.getAttribute("data-tone")).toBe(line.tone);
        expect(lines?.[index]?.getAttribute("data-upstream")).toBe(line.upstream ? "true" : null);
        expect(lines?.[index]?.querySelector(".template-line-tag")?.textContent).toBe(line.tag);
        expect(lines?.[index]?.querySelector(".template-line-text")?.textContent).toBe(line.text);
        expect(lines?.[index]?.querySelector(".template-line-sub")?.textContent).toBe(line.sub);
      }
    }
  },
);

it("omits empty and unshipped parts, including before the first sweep", async () => {
  await render(<Template store={createWatchStore(vi.fn())} />);
  expect(container.querySelector("h1")?.textContent).toBe("Template");
  expect(container.querySelector(".place-reading, details, [data-part]")).toBeNull();
  const empty = snapshot();
  empty.readings = [];
  delete empty.briefing.repositories.template;
  empty.briefing.focus = [];
  empty.briefing.rest = [];
  empty.briefing.repositories.rows = [];
  empty.briefing.repositories.facts = [];
  for (const place of empty.briefing.places ?? []) delete place.visual;
  await mount(empty);
  expect(container.querySelector(".place-reading, details, [data-part]")).toBeNull();
  expect(container.querySelector(".template")?.textContent).not.toMatch(
    /Threads|composer|not available yet|gate 3/,
  );
});

it("omits missing facts, rollout details and empty sections", async () => {
  const body = snapshot();
  delete body.briefing.repositories.template;
  const rollout = body.briefing.focus.find(({ id }) => id === "rollout");
  if (!rollout) throw new Error("Recorded rollout missing");
  rollout.more = undefined;
  const repo = body.briefing.repositories.rows.find(({ name }) => name === "osdu-spi");
  if (!repo) throw new Error("Recorded template repository missing");
  repo.sections = [
    { title: "Empty", count: "0", lines: [] },
    {
      title: "Issues",
      count: "1",
      lines: [{ tag: "bug", tone: "neutral", text: "No id", sub: "opened 1d ago" }],
    },
  ];
  await mount(body);
  await openDetails();
  expect(parts()).toEqual(["rollout", "repository"]);
  expect(container.querySelector(".template-detail")).toBeNull();
  expect(container.querySelectorAll(".template-repo-section")).toHaveLength(1);
  const line = container.querySelector(".template-lines li");
  expect(line?.textContent).toBe("bugNo idopened 1d ago");
});

it("opens Template through its existing route and its repository's popover", async () => {
  const body = snapshot();
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  window.location.hash = "#template";
  await render(<Shell />);
  expect(container.querySelector("main h1")?.textContent).toBe("Template");
  await openDetails();
  await click('[data-part="repository"] .template-repo-lead');
  expect(container.querySelectorAll(".popover")).toHaveLength(1);
  expect(selectionStore.getState()).toMatchObject({ selected: null, open: false });
});

it("opens Details for what is open inside it, and leaves it closed for what the place shows", async () => {
  const body = snapshot();
  await mount(body);
  const details = container.querySelector<HTMLDetailsElement>(".template-details");
  await act(async () => setOpenSelection({ kind: "item", id: "rollout" }));
  expect(
    container.querySelector('.place-item[data-item-id="rollout"]')?.hasAttribute("data-selected"),
  ).toBe(true);
  expect(details?.open).toBe(false);
  expect(popover()).not.toBeNull();
  const repo = body.briefing.repositories.rows.find(({ name }) => name === "osdu-spi");
  if (!repo) throw new Error("Recorded template repository missing");
  await act(async () => setOpenSelection({ kind: "item", id: repo.id }));
  expect(details?.open).toBe(true);
  expect(container.querySelector(".template-repo-lead")?.getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(popover()?.querySelector("h3")?.textContent).toBe(repo.title);
});

it("opens a reading item as its own reading, never as another kind sharing its id", async () => {
  const body = snapshot();
  const queued = body.briefing.focus.find(({ id }) => id === "rollout");
  if (!queued) throw new Error("Recorded rollout missing");
  queued.id = "queued-rollout";
  const repo = body.briefing.repositories.rows.find(({ name }) => name === "osdu-spi");
  if (!repo) throw new Error("Recorded template repository missing");
  repo.id = "rollout";
  const item = body.readings
    .find(({ anchor }) => anchor.kind === "engineering")
    ?.content?.items.find(({ id }) => id === "rollout");
  await mount(ViewSnapshotSchema.parse(body));
  await click('.place-item-content[data-selection-id="rollout"]');
  expect(item).toBeDefined();
  expect(popover()?.querySelector("h3")?.textContent).not.toBe(repo.title);
  expect(container.querySelector<HTMLDetailsElement>(".template-details")?.open).toBe(false);
});

it("opens Details when the open rollout is reachable only inside it", async () => {
  const body = snapshot();
  const reading = body.readings.find(({ anchor }) => anchor.kind === "engineering")?.content;
  if (!reading) throw new Error("Recorded engineering reading missing");
  reading.items = reading.items.filter(({ id }) => id !== "rollout");
  await mount(ViewSnapshotSchema.parse(body));
  await act(async () => setOpenSelection({ kind: "item", id: "rollout" }));
  const details = container.querySelector<HTMLDetailsElement>(".template-details");
  expect(container.querySelector('.place [data-selection-id="rollout"]')).toBeNull();
  expect(details?.open).toBe(true);
  expect(details?.querySelector('[data-opens="item~rollout"]')?.getAttribute("aria-expanded")).toBe(
    "true",
  );
});
