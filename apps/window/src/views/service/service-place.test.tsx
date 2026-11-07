// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { DEFAULT_REGISTRY } from "../../app/routes.js";
import { inScope } from "../../components/sidebar/attention.js";
import { RightPanel } from "../../panels/RightPanel.js";
import { createSelectionStore } from "../../panels/selection.js";
import { utc } from "../../panels/selection-rows.js";
import { createWatchStore } from "../../store/watch.js";
import { treeServices } from "../inbox/queue.js";
import ServicePlace from "./index.js";

const cleanups: (() => Promise<void>)[] = [];
const snapshot = () => ViewSnapshotSchema.parse(JSON.parse(recorded));

async function mount(body: ViewSnapshot = snapshot(), id = "legal") {
  const container = document.createElement("div");
  document.body.append(container);
  const selection = createSelectionStore({ postMessage: vi.fn() });
  const watch = createWatchStore(vi.fn(), selection);
  watch.setState({ snapshot: { cursor: body.cursor, body } });
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <ServicePlace id={id} store={watch} selection={selection} />
        <RightPanel store={selection} snapshot={body} />
      </>,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const click = async (selector: string) => {
    const target = container.querySelector<HTMLElement>(selector);
    expect(target, `Missing one-click target ${selector}`).not.toBeNull();
    await act(async () => target?.click());
    if (target?.tagName === "SUMMARY") expect(target.closest("details")?.open).toBe(true);
  };
  return { container, selection, watch, click };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("renders legal's recorded service reading, including 17 incoming commits and Release #48 ready", async () => {
  const body = snapshot();
  const reading = body.readings.find(
    ({ anchor }) => anchor.kind === "service" && anchor.id === "legal",
  )?.content;
  expect(reading).toBeTruthy();
  const { container } = await mount(body);
  expect(container.querySelector(".place h1")?.textContent).toBe("legal");
  expect(DEFAULT_REGISTRY.views.service).toBeTypeOf("function");
  expect(container.querySelector(".place-headline")?.textContent).toBe(reading?.headline);
  const tiles = container.querySelectorAll(".place-tile");
  expect(tiles).toHaveLength(3);
  expect(tiles[0]?.querySelector(".place-tile-value")?.textContent).toBe("17");
  expect(tiles[0]?.querySelector(".place-tile-counts")?.textContent).toContain("commits behind");
  expect(tiles[2]?.querySelector("dt")?.textContent).toBe("Release review");
  expect(tiles[2]?.querySelector(".place-tile-value")?.textContent).toBe("PR #48");
  expect(tiles[2]?.querySelector(".place-tile-counts")?.textContent).toContain("checks pass");
  expect(container.querySelector(".place-item-title")?.textContent).toContain(
    "os-core-common 8.4.1-boot4-SNAPSHOT",
  );
  expect(container.querySelector('[data-service-detail="upstream"]')?.textContent).toContain(
    "hold · SNAPSHOT toolchain",
  );
  expect(container.querySelector(".place-folded")?.textContent).toBe(reading?.folded);
  const words = [
    ...container.querySelectorAll(
      ".place-reading h2, .place-reading p, .place-tile dt, .place-tile dd, .place-rank, .place-scope, .place-item-title, .place-item-sub, .place-item-meta, .place-item-next",
    ),
  ]
    .map((node) => node.textContent)
    .join(" ")
    .trim()
    .split(/\s+/).length;
  expect(words).toBeGreaterThan(70);
  expect(words).toBeLessThanOrEqual(140);
});

it("opens the SNAPSHOT hold and every upstream field in the right panel with one click", async () => {
  const { container, selection, click } = await mount();
  await click('[data-service-detail="upstream"]');
  expect(selection.getState().open).toBe(true);
  expect(selection.getState().tab).toBe("detail");
  const panel = container.querySelector("aside[aria-label='Detail']");
  expect(panel?.textContent).toContain("hold · SNAPSHOT toolchain");
  expect(panel?.textContent).toContain(
    "Held: upstream moved to os-core-common 8.4.1-boot4-SNAPSHOT",
  );
  expect(container.querySelector(".service-page .service-kv")).toBeNull();
});

it("selects a reading item into the right panel without opening a different route", async () => {
  const { selection, click } = await mount();
  const hash = window.location.hash;
  await click('.place-item-content[data-selection-id="radar:legal"]');
  expect(selection.getState().selected).toBe("radar:legal");
  expect(selection.getState().open).toBe(true);
  expect(selection.getState().tab).toBe("detail");
  expect(window.location.hash).toBe(hash);
});

it("selects the recorded repository-backed reading item into repository Detail", async () => {
  const { selection, click } = await mount();
  await click('.place-item-content[data-selection-id="repo:legal"]');
  expect(selection.getState().selected).toBe("repo:legal");
  expect(selection.getState().row?.kind).toBe("repository");
  expect(selection.getState().open).toBe(true);
  expect(selection.getState().tab).toBe("detail");
});

it("renders no empty or future parts on the recorded sweep or when optional facts are absent", async () => {
  const { container, click, watch } = await mount();
  expect(container.querySelector('[data-section="threads"], [data-section="composer"]')).toBeNull();
  expect(container.querySelectorAll("details[open]")).toHaveLength(0);
  expect(container.querySelector(".service-page")?.textContent).not.toMatch(
    /gate 3|Upstream MRs|not available yet|No runs|No release/,
  );
  expect(container.querySelectorAll(".service-repo-section")).toHaveLength(0);
  await click('[data-section="runs"] > summary');
  expect(container.querySelector('[data-section="runs"]')?.hasAttribute("open")).toBe(true);
  const empty = snapshot();
  empty.stations = [];
  empty.services = [];
  empty.briefing.focus = [];
  empty.briefing.rest = [];
  empty.briefing.flow.rows = [];
  empty.briefing.repositories.rows = [];
  empty.readings = empty.readings.map((reading) => ({ ...reading, content: null }));
  await act(async () => watch.setState({ snapshot: { cursor: empty.cursor, body: empty } }));
  expect(container.querySelector(".place h1")?.textContent).toBe("legal");
  expect(
    container.querySelector(".place-reading, .service-details, .service-station-actions"),
  ).toBeNull();
});

const stationLabels = ["Upstream", "Sync PR", "Cascade", "Main", "Release review", "Lane context"];
it.each([0, 1, 2, 3, 4, 5])(
  "keeps former station %i's state and text one click away in station Detail",
  async (index) => {
    const body = snapshot();
    const station = body.stations.find(({ service }) => service === "legal")?.stations[index];
    if (!station) throw new Error("Recorded legal station missing");
    const { container, selection, click } = await mount(body);
    await click(`[data-station="${station.id}"]`);
    const button = container.querySelector(`[data-station="${station.id}"]`);
    expect(button?.textContent).toBe(stationLabels[index]);
    expect(selection.getState().row?.kind).toBe("station");
    const panel = container.querySelector("aside[aria-label='Detail']");
    expect(panel?.querySelector(".detail-title")?.textContent).toContain("legal");
    const fields = Object.fromEntries(
      [...(panel?.querySelectorAll(".detail-row-fields > div") ?? [])].map((field) => [
        field.querySelector("dt")?.textContent,
        field.querySelector("dd")?.textContent,
      ]),
    );
    expect(fields.State).toBe(station.state);
    expect(fields.Reading).toBe(station.text);
  },
);

it.each([
  "Behind",
  "Carries",
  "Ready",
  "Plan",
  "Sync PR",
  "Cascade",
  "Sync to main",
  "Main run",
  "Next",
  "Detail",
])("keeps the former upstream %s field one click away", async (label) => {
  const body = snapshot();
  const flow = body.briefing.flow.rows.find(({ fork }) => fork === "legal");
  if (!flow) throw new Error("Recorded legal flow missing");
  const values: Record<string, string[]> = {
    Behind: [flow.behind],
    Carries: [flow.carries],
    Ready: [flow.ready.text],
    Plan: [flow.plan.text],
    "Sync PR": [flow.line[0]?.text ?? ""],
    Cascade: [flow.line[1]?.text ?? ""],
    "Sync to main": [flow.line[2]?.text ?? ""],
    "Main run": [flow.line[3]?.text ?? ""],
    Next: [flow.next.text],
    Detail: flow.detail.lines,
  };
  const { container, click } = await mount(body);
  await click('[data-service-detail="upstream"]');
  const fields = [...container.querySelectorAll(".detail-row-fields > div")].filter(
    (field) => field.querySelector("dt")?.textContent === label,
  );
  expect(fields.map((field) => field.querySelector("dd")?.textContent)).toEqual(
    values[label]?.map((value) => (value === "·" ? "" : value)),
  );
});

it("keeps every former attention field reachable through its nonempty disclosure", async () => {
  const body = snapshot();
  const { container, click } = await mount(body);
  await click('[data-section="attention"] > summary');
  const items = [...body.briefing.focus, ...body.briefing.rest].filter((item) =>
    inScope(item, "service:legal", treeServices(body.tree)),
  );
  expect(items.length).toBeGreaterThan(0);
  expect(
    container.querySelector('[data-section="attention"] > summary .service-section-count')
      ?.textContent,
  ).toBe(String(items.length));
  for (const item of items) {
    const row = container.querySelector(
      `[data-section="attention"] [data-selection-id="${item.id}"]`,
    );
    expect(row?.querySelector(".service-priority")?.textContent).toBe(`P${item.rung}`);
    expect(row?.querySelector(".service-row-title")?.textContent).toContain(item.title);
    expect(row?.querySelector(".service-class")?.textContent).toBe(item.cls);
    expect(row?.querySelector(".service-row-sub")?.textContent).toBe(item.sub);
  }
});

it("keeps the former repository title, reading and note one click away", async () => {
  const body = snapshot();
  const repo = body.briefing.repositories.rows.find(({ id }) => id === "repo:legal");
  if (!repo) throw new Error("Recorded legal repository missing");
  const { container, click } = await mount(body);
  await click('[data-section="repository"] > summary');
  const section = container.querySelector('[data-section="repository"]');
  expect(section?.textContent).toContain(repo.title);
  expect(section?.textContent).toContain(repo.sub);
  expect(section?.textContent).toContain(repo.note);
});

it("keeps repository section names, counts, remainder and every line's tag, title and reading one click away", async () => {
  const body = snapshot();
  const repo = body.briefing.repositories.rows.find(({ id }) => id === "repo:entitlements");
  if (!repo?.sections.length) throw new Error("Recorded repository sections missing");
  const { container, click } = await mount(body, "entitlements");
  await click('[data-section="repository"] > summary');
  for (const section of repo.sections) {
    const sectionNode = [...container.querySelectorAll(".service-repo-section")].find((node) =>
      node.querySelector(".repo-section-title")?.textContent?.startsWith(section.title),
    );
    expect(sectionNode?.querySelector(".repo-section-title")?.textContent).toContain(section.count);
    expect(sectionNode?.querySelector(".repo-section-title")?.textContent).toContain(section.rest);
    const lines = sectionNode?.querySelectorAll(".service-row") ?? [];
    expect(lines).toHaveLength(section.lines.length);
    for (const [index, line] of section.lines.entries()) {
      expect(lines[index]?.querySelector(".service-tag")?.textContent).toBe(line.tag);
      expect(lines[index]?.querySelector(".service-row-title")?.textContent).toBe(line.text);
      expect(lines[index]?.querySelector(".service-row-sub")?.textContent).toBe(line.sub);
    }
  }
});

it("keeps former release month, version, state, review and PR link one click away", async () => {
  const body = snapshot();
  const release = body.services?.find(({ service }) => service === "legal")?.releases[0];
  if (!release?.releasePr || !release.gate) throw new Error("Recorded legal release missing");
  const { container, click } = await mount(body);
  await click('[data-section="release"] > summary');
  expect(
    container.querySelector('[data-section="release"] > summary .service-section-count')
      ?.textContent,
  ).toBe("1");
  const row = container.querySelector(`[data-release="${release.month}"]`);
  expect(row?.querySelector(".service-month")?.textContent).toBe(release.month);
  expect(row?.querySelector(".service-row-title")?.textContent).toContain(release.version);
  expect(row?.querySelector(".service-class")?.textContent).toBe(release.state);
  expect(row?.querySelector("[data-gate]")?.textContent).toContain(release.gate.state);
  expect(row?.querySelector("[data-gate]")?.textContent).toContain(
    "release review waiting · PR #48",
  );
  expect(row?.querySelector("a")?.getAttribute("href")).toBe(release.releasePr.url);
  expect(row?.querySelector("a")?.textContent).toBe(
    `PR #${release.releasePr.number} ${release.releasePr.title}`,
  );
});

it("keeps every former run's workflow, result and UTC time one click away", async () => {
  const body = snapshot();
  const runs = body.services?.find(({ service }) => service === "legal")?.runs ?? [];
  expect(runs.length).toBeGreaterThan(0);
  const { container, click } = await mount(body);
  await click('[data-section="runs"] > summary');
  expect(
    container.querySelector('[data-section="runs"] > summary .service-section-count')?.textContent,
  ).toBe(String(runs.length));
  for (const run of runs) {
    const row = container.querySelector(`[data-section="runs"] [data-selection-id="${run.id}"]`);
    expect(row?.querySelector(".service-row-title")?.textContent).toBe(run.workflow);
    expect(row?.querySelector("[data-result]")?.textContent).toBe(run.result);
    expect(row?.querySelector("time")?.textContent).toBe(utc(run.time));
    expect(row?.querySelector("time")?.getAttribute("datetime")).toBe(run.time);
  }
});
