// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import earlier from "../../../../../fixtures/watch/snapshot-59d6895.json?raw";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { Shell } from "../../app/Shell.js";
import { RightPanel } from "../../panels/RightPanel.js";
import {
  createSelectionStore,
  type SelectionStore,
  selectionStore,
} from "../../panels/selection.js";
import { selectionRows } from "../../panels/selection-rows.js";
import { createWatchStore, watchStore } from "../../store/watch.js";
import Template from "./index.js";

const snapshot = () => ViewSnapshotSchema.parse(JSON.parse(recorded));
const previous = watchStore.getState();
const previousSpi = window.spi;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.location.hash = "";
  window.spi = {
    proof: false,
    openExternal: vi.fn(async () => true),
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

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

function Subject({
  store,
  selection,
}: {
  store: ReturnType<typeof createWatchStore>;
  selection: SelectionStore;
}) {
  const body = useStore(store, (state) => state.snapshot?.body);
  return (
    <>
      <Template store={store} inspector={selection} />
      <RightPanel store={selection} {...(body ? { snapshot: body } : {})} />
    </>
  );
}

async function mount(body: ViewSnapshot = snapshot()) {
  const selection = createSelectionStore({ postMessage: vi.fn() });
  const store = createWatchStore(vi.fn(), selection);
  store.setState({ snapshot: { cursor: body.cursor, body } });
  await render(<Subject store={store} selection={selection} />);
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
const fields = () =>
  Object.fromEntries(
    [...container.querySelectorAll(".detail-row-fields > div")].map((field) => [
      field.querySelector("dt")?.textContent,
      field.querySelector("dd")?.textContent,
    ]),
  );

it("renders the engineering reading with verified-on-target, open-PR and rollout tiles", async () => {
  const body = snapshot();
  const reading = body.readings.find(({ anchor }) => anchor.kind === "engineering")?.content;
  expect(reading).toBeTruthy();
  // The merged/adopted fact is not the reading's verified-on-target measure.
  body.briefing.facts = body.briefing.facts.map((fact) =>
    fact.label.startsWith("Template") ? { ...fact, figure: "13 of 13" } : fact,
  );
  await mount(body);
  expect(container.querySelector(".place h1")?.textContent).toBe("Engineering system");
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
    ["Engineering system", "0 of 13", "forks on 7d269b5"],
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

it("opens a reading item in Detail, including when Evidence was open", async () => {
  const { selection } = await mount();
  selection.getState().openSweepEvidence();
  await click('.place-item-content[data-selection-id="rollout"]');
  expect(selection.getState()).toMatchObject({
    selected: "rollout",
    row: { kind: "queue", title: "Rollout to template 7d269b5" },
    open: true,
    tab: "detail",
  });
  expect(container.querySelector(".detail-title")?.textContent).toBe("Rollout to template 7d269b5");
});

it.each([
  ["November", recorded],
  ["October", earlier],
])(
  "keeps every former Template field one disclosure away in the %s sweep",
  async (_name, fixture) => {
    const body = ViewSnapshotSchema.parse(JSON.parse(fixture));
    const factIndex = body.briefing.facts.findIndex(({ label }) => label.startsWith("Template"));
    const fact = body.briefing.facts[factIndex];
    const rollout = [...body.briefing.focus, ...body.briefing.rest].find(
      ({ id }) => id === "rollout",
    );
    const repository = body.briefing.repositories.rows.find(({ name }) => name === "osdu-spi");
    if (!fact || !rollout || !repository) throw new Error("Recorded Template fields missing");
    await mount(body);
    await openDetails();
    expect(parts()).toEqual(["fact", "rollout", "repository"]);
    const factNode = part("fact")?.querySelector(".inbox-fact");
    expect(factNode?.getAttribute("data-pointer")).toBe(`/briefing/facts/${factIndex}`);
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
    ).toEqual(rollout.more);
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
        expect(lines?.[index]?.getAttribute("data-selection-id")).toBe(line.id ?? null);
        expect(lines?.[index]?.getAttribute("data-tone")).toBe(line.tone);
        expect(lines?.[index]?.getAttribute("data-upstream")).toBe(line.upstream ? "true" : null);
        expect(lines?.[index]?.querySelector(".template-line-tag")?.textContent).toBe(line.tag);
        expect(lines?.[index]?.querySelector(".template-line-text")?.textContent).toBe(line.text);
        expect(lines?.[index]?.querySelector(".template-line-sub")?.textContent).toBe(line.sub);
      }
    }
  },
);

it("selects a template line as repository-line with fields and refreshes it on the next sweep", async () => {
  const body = snapshot();
  const { store, selection } = await mount(body);
  await openDetails();
  const id = "issue:Azure/osdu-spi:265";
  await click(`[data-part="repository"] [data-selection-id="${id}"]`);
  expect(selection.getState().row).toEqual(
    selectionRows(body).find((row) => row.id === id && row.kind === "repository-line"),
  );
  expect(container.querySelector("aside .inspector-kicker")?.textContent).toBe("repository line");
  expect(fields()).toEqual({
    Tag: "bug",
    Reading: "opened 16d ago · 0 comments",
    Id: id,
    Link: "https://github.com/Azure/osdu-spi/issues/265",
  });
  const next = snapshot();
  next.cursor += 1;
  const repo = next.briefing.repositories.rows.find(({ name }) => name === "osdu-spi");
  const line = repo?.sections[0]?.lines[0];
  if (!repo || !line) throw new Error("Recorded template line missing");
  line.tag = "updated";
  line.text = "Updated template issue";
  line.sub = "opened 16d ago · 1 comment";
  line.url = "https://github.com/Azure/osdu-spi/issues/265#issuecomment-1";
  // A sweep may move both the repository and the line without changing their identities.
  repo.sections[0]?.lines.reverse();
  next.briefing.repositories.rows.reverse();
  await act(async () =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: "next-sweep",
      kind: "event",
      type: "view.snapshot",
      payload: next,
    }),
  );
  expect(selection.getState().selected).toBe(id);
  expect(container.querySelector(".detail-title")?.textContent).toBe("Updated template issue");
  expect(fields()).toMatchObject({
    Tag: "updated",
    Reading: "opened 16d ago · 1 comment",
    Link: line.url,
  });
  await click(".detail-row-fields a");
  expect(window.spi.openExternal).toHaveBeenCalledWith(line.url);
});

it("keeps keyboard selection in rollout, repository, then identified-line order and opens line links", async () => {
  const body = snapshot();
  const { selection } = await mount(body);
  await openDetails();
  const repo = body.briefing.repositories.rows.find(({ name }) => name === "osdu-spi");
  if (!repo) throw new Error("Recorded template repository missing");
  const ids = [
    "rollout",
    repo.id,
    ...repo.sections.flatMap(({ lines }) => lines.flatMap(({ id }) => (id ? [id] : []))),
  ];
  const nodes = [
    ...container.querySelectorAll<HTMLElement>(".template-details [data-selection-id]"),
  ];
  expect(nodes.map((node) => node.dataset.selectionId)).toEqual(ids);
  nodes[0]?.focus();
  for (let index = 0; index < nodes.length - 1; index += 1) {
    await act(async () =>
      nodes[index]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(nodes[index + 1]);
    expect(selection.getState().selected).toBe(ids[index + 1]);
  }
  const last = nodes.at(-1);
  await act(async () =>
    last?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })),
  );
  expect(document.activeElement).toBe(nodes.at(-2));
  const lineNode = nodes[2];
  const line = repo.sections[0]?.lines[0];
  await act(async () =>
    lineNode?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(window.spi.openExternal).toHaveBeenCalledWith(line?.url);
  await act(async () => lineNode?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(window.spi.openExternal).toHaveBeenCalledTimes(2);
});

it("omits empty and unshipped parts, including before the first sweep", async () => {
  await render(<Template store={createWatchStore(vi.fn())} />);
  expect(container.querySelector("h1")?.textContent).toBe("Engineering system");
  expect(container.querySelector(".place-reading, details, [data-part]")).toBeNull();
  const empty = snapshot();
  empty.readings = [];
  empty.briefing.facts = [];
  empty.briefing.focus = [];
  empty.briefing.rest = [];
  empty.briefing.repositories.rows = [];
  empty.briefing.repositories.facts = [];
  await mount(empty);
  expect(container.querySelector(".place-reading, details, [data-part]")).toBeNull();
  expect(container.querySelector(".template")?.textContent).not.toMatch(
    /Threads|composer|not available yet|gate 3/,
  );
});

it("leaves unidentified lines static and omits missing facts, rollout details and empty sections", async () => {
  const body = snapshot();
  body.briefing.facts = [];
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
  expect(line?.hasAttribute("data-selection-id")).toBe(false);
});

it("opens the Engineering system through the existing Template route and selects line Detail", async () => {
  const body = snapshot();
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  window.location.hash = "#template";
  await render(<Shell />);
  expect(container.querySelector("main h1")?.textContent).toBe("Engineering system");
  await openDetails();
  await click('[data-part="repository"] [data-selection-id="issue:Azure/osdu-spi:265"]');
  expect(container.querySelectorAll("aside .detail-title")).toHaveLength(1);
  expect(container.querySelector("aside .inspector-kicker")?.textContent).toBe("repository line");
  expect(fields().Reading).toBe("opened 16d ago · 0 comments");
});

it("opens Details when a row inside it is selected from outside the place, until the reader closes it", async () => {
  const body = snapshot();
  const { selection } = await mount(body);
  const details = container.querySelector<HTMLDetailsElement>(".template-details");
  const row = (id: string, kind: string) => {
    const found = selectionRows(body).find((row) => row.id === id && row.kind === kind);
    if (!found) throw new Error(`Recorded ${kind} row ${id} missing`);
    return found;
  };
  const choose = (id: string, kind: string) =>
    act(async () => selection.getState().select(id, row(id, kind)));
  const id = "issue:Azure/osdu-spi:265";
  const line = () =>
    container.querySelector<HTMLElement>(`.template-lines li[data-selection-id="${id}"]`);
  await choose("rollout", "queue");
  expect(
    container.querySelector('.place-item[data-item-id="rollout"]')?.hasAttribute("data-selected"),
  ).toBe(true);
  expect(details?.open).toBe(false);
  await choose(id, "repository-line");
  expect(details?.open).toBe(true);
  expect(line()?.getAttribute("data-selected")).toBe("true");
  expect(line()?.getAttribute("aria-selected")).toBe("true");
  expect(line()?.closest("details")).toBe(details);
  await click(".template-details > summary");
  expect(details?.open).toBe(false);
  await choose(id, "repository-line");
  expect(details?.open).toBe(false);
  const repo = body.briefing.repositories.rows.find(({ name }) => name === "osdu-spi");
  if (!repo) throw new Error("Recorded template repository missing");
  await choose(repo.id, "repository");
  expect(details?.open).toBe(true);
  expect(container.querySelector(".template-repo-lead")?.getAttribute("data-selected")).toBe(
    "true",
  );
});
