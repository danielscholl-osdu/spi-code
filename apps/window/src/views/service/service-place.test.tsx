// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { openSelection, setOpenSelection } from "../../app/navigation.js";
import { treeServices } from "../../app/queue.js";
import { DEFAULT_REGISTRY } from "../../app/routes.js";
import {
  createTitleStore,
  TitleEnd,
  TitleProvider,
  TitleRow,
  type TitleStore,
} from "../../app/title-row.js";
import { inScope } from "../../components/sidebar/attention.js";
import { createSelectionStore } from "../../panels/selection.js";
import { PINS_STORAGE_KEY, readPins, SEED_PINS } from "../../store/pins.js";
import { createWatchStore } from "../../store/watch.js";
import { plainTitle } from "../../text.js";
import { clockTime, timedText } from "../../time.js";
import { cellOpening } from "../line/cell-content.js";
import ServicePlace from "./index.js";
import { serviceOpening } from "./opening.js";

const popover = (container: HTMLElement) => container.querySelector<HTMLElement>(".popover");
const popoverFields = (container: HTMLElement) =>
  [...(popover(container)?.querySelectorAll(".popover-fields > div") ?? [])].map((field) => [
    field.querySelector("dt")?.textContent,
    field.querySelector("dd")?.textContent,
  ]);

// Pinned before any test formats a time, since the window caches its local-zone formatter.
const previousZone = process.env.TZ;
process.env.TZ = "America/Chicago";
afterAll(() => {
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});

const cleanups: (() => Promise<void>)[] = [];
const snapshot = () => ViewSnapshotSchema.parse(JSON.parse(recorded));

async function mount(body: ViewSnapshot = snapshot(), id = "legal", titles?: TitleStore) {
  const container = document.createElement("div");
  document.body.append(container);
  const selection = createSelectionStore({ postMessage: vi.fn() });
  const watch = createWatchStore(vi.fn(), selection);
  watch.setState({ snapshot: { cursor: body.cursor, body } });
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <TitleProvider value={titles ?? null}>
        {titles && (
          <>
            <div className="centre-title">
              <TitleRow store={titles} fallback="" />
            </div>
            <div className="centre-end">
              <TitleEnd store={titles} />
            </div>
          </>
        )}
        <ServicePlace id={id} store={watch} />
      </TitleProvider>,
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
  await act(async () => setOpenSelection(null));
  for (const cleanup of cleanups.splice(0)) await cleanup();
  localStorage.removeItem(PINS_STORAGE_KEY);
});

it("puts the service's pin control at the top row's end, and pins and unpins it there", async () => {
  const titles = createTitleStore();
  const { container } = await mount(snapshot(), "legal", titles);
  const control = () => container.querySelector<HTMLButtonElement>(".centre-end > .pin-control");
  expect(container.querySelector(".centre-title h1")?.textContent).toBe("legal");
  expect(container.querySelector(".centre-title .pin-control")).toBeNull();
  expect(control()?.getAttribute("aria-label")).toBe("Pin legal to sidebar (Ctrl+Shift+P)");
  await act(async () => control()?.click());
  expect(readPins()).toEqual([...SEED_PINS, "legal"]);
  expect(JSON.parse(localStorage.getItem(PINS_STORAGE_KEY) ?? "[]")).toEqual([
    ...SEED_PINS,
    "legal",
  ]);
  expect(control()?.getAttribute("aria-label")).toBe("Unpin legal from sidebar (Ctrl+Shift+P)");
  await act(async () => control()?.click());
  expect(readPins()).toEqual(SEED_PINS);
  expect(control()?.getAttribute("aria-label")).toBe("Pin legal to sidebar (Ctrl+Shift+P)");
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

it("opens the SNAPSHOT hold and every upstream field in a popover with one click", async () => {
  const { container, selection, click } = await mount();
  await click('[data-service-detail="upstream"]');
  expect(openSelection()).toEqual({ kind: "flow", id: "upstream:legal" });
  expect(selection.getState()).toMatchObject({ selected: null, open: false });
  expect(popover(container)?.querySelector("h3")?.textContent).toBe("legal · held");
  expect(popoverFields(container)).toContainEqual(["Ready", "hold · SNAPSHOT toolchain"]);
  expect(popover(container)?.textContent).toContain(
    "Held: upstream moved to os-core-common 8.4.1-boot4-SNAPSHOT",
  );
  expect(container.querySelector(".service-page .service-kv")).toBeNull();
});

it("opens a reading item's shared body without opening a different route", async () => {
  const { container, selection, click } = await mount();
  const hash = window.location.hash;
  await click('.place-item-content[data-selection-id="radar:legal"]');
  expect(openSelection()).toEqual({ kind: "item", id: "radar:legal" });
  expect(selection.getState()).toMatchObject({ selected: null, open: false });
  const body = popover(container)?.querySelector(".opened-body");
  expect(body?.querySelector(".opened-body-place")?.textContent).toBe(
    "On Today · Waiting on you ›",
  );
  expect(body?.querySelector("h3")?.textContent).toBe(
    "legal · upstream changes need a toolchain upgrade",
  );
  expect(window.location.hash).toBe(hash);
  await click('.place-item-content[data-selection-id="radar:legal"]');
  expect(popover(container)).toBeNull();
});

it("opens the recorded repository-backed reading item with its own reading", async () => {
  const body = snapshot();
  const item = body.readings
    .flatMap(({ content }) => content?.items ?? [])
    .find(({ id }) => id === "repo:legal");
  if (!item) throw new Error("Recorded repository item missing");
  const { container, click } = await mount(body);
  await click('.place-item-content[data-selection-id="repo:legal"]');
  expect(openSelection()).toEqual({ kind: "item", id: "repo:legal" });
  expect(popover(container)?.querySelector("h3")?.textContent).toBe(plainTitle(item.title));
});

it("renders no empty or future parts on the recorded sweep or when optional facts are absent", async () => {
  const { container, click, watch } = await mount();
  expect(container.querySelector('[data-section="threads"], [data-section="composer"]')).toBeNull();
  expect(container.querySelectorAll("details[open]")).toHaveLength(1);
  expect(container.querySelector("details[open]")?.getAttribute("data-section")).toBe("attention");
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

/** Read at the sweep, where core's 00:00 UTC deadline falls at 18:00 the same day in Chicago. */
async function pinned<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(snapshot().sweptAt));
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

const sources = (container: HTMLElement) =>
  [...(popover(container)?.querySelectorAll(".opened-body-sources a") ?? [])].map((a) =>
    a.getAttribute("href"),
  );

const stationLabels = ["Upstream", "Sync PR", "Cascade", "Main", "Release review", "Lane context"];
it.each([0, 1, 2, 3, 4, 5])(
  "opens station %i's Line cell, or its release review, with its reading",
  (index) =>
    pinned(async () => {
      const body = snapshot();
      const station = body.stations.find(({ service }) => service === "legal")?.stations[index];
      if (!station) throw new Error("Recorded legal station missing");
      const { container, click } = await mount(body);
      await click(`[data-station="${station.id}"]`);
      expect(container.querySelector(`[data-station="${station.id}"]`)?.textContent).toBe(
        stationLabels[index],
      );
      const title = popover(container)?.querySelector("h3")?.textContent;
      if (station.id === "release") {
        expect(openSelection()).toEqual({ kind: "station", id: "legal:release" });
        expect(title).toBe("legal · Release review");
        expect(popover(container)?.querySelector(".opened-body > p")?.textContent).toBe(
          `${station.text}. Not on Today.`,
        );
        expect(sources(container)).toEqual(["https://github.com/Azure/osdu-spi-legal/pull/48"]);
        return;
      }
      const cell = { kind: "cell", id: `legal:${station.id}` };
      expect(openSelection()).toEqual(cell);
      expect(title).toBe(cellOpening(body, cell)?.content.title);
      expect(popoverFields(container)).toEqual([
        [stationLabels[index]?.replace("Lane context", "Lane"), station.text],
      ]);
      if (station.id === "upstream")
        expect(popover(container)?.querySelector(".opened-body-deadline")?.textContent).toBe(
          "◷ Before the next upstream sync, 18:00",
        );
    }),
);

it.each([
  {
    name: "entitlements' release-red PR with its Today member's reading",
    service: "entitlements",
    unread: false,
    place: "On Today · Waiting on you ›",
    title: /^entitlements · /,
    cause: undefined,
    source: "https://github.com/Azure/osdu-spi-entitlements/pull/89",
  },
  {
    name: "an unread station as not read, with the release PR it knows",
    service: "legal",
    unread: true,
    place: undefined,
    title: /^legal · Release review$/,
    cause: "SPI Code didn't read this station.",
    source: "https://github.com/Azure/osdu-spi-legal/pull/48",
  },
])("opens $name", async ({ service, unread, place, title, cause, source }) => {
  const body = snapshot();
  const station = body.stations
    .find((row) => row.service === service)
    ?.stations.find(({ id }) => id === "release");
  if (!station) throw new Error("Recorded release station missing");
  if (unread) {
    station.state = "unknown";
    station.text = "";
  }
  const { container, click } = await mount(body, service);
  await click('[data-station="release"]');
  expect(popover(container)?.querySelector(".opened-body-place")?.textContent).toBe(place);
  expect(popover(container)?.querySelector("h3")?.textContent).toMatch(title);
  if (cause) expect(popover(container)?.querySelector(".opened-body > p")?.textContent).toBe(cause);
  expect(sources(container)).toContain(source);
});

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
  expect(
    popoverFields(container)
      .filter(([name]) => name === label)
      .map(([, value]) => value),
  ).toEqual(values[label]?.map((value) => (value === "·" ? "" : value)));
});

it("keeps every former attention field reachable through its nonempty disclosure", async () => {
  const body = snapshot();
  const { container } = await mount(body);
  expect(container.querySelector('[data-section="attention"]')?.hasAttribute("open")).toBe(true);
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
    expect(row?.querySelector(".service-row-sub")?.textContent).toBe(
      timedText(item.sub, { hint: false }),
    );
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
      expect(lines[index]?.querySelector(".service-row-title")?.textContent).toBe(
        plainTitle(line.text),
      );
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
    "release review waiting · #48 waiting on review",
  );
  expect(row?.querySelector("a")?.getAttribute("href")).toBe(release.releasePr.url);
  expect(row?.querySelector("a")?.textContent).toBe(
    `PR #${release.releasePr.number} ${release.releasePr.title}`,
  );
});

it("keeps every former run's workflow, result and local time one click away", async () => {
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
    expect(row?.querySelector("time")?.textContent).toBe(clockTime(run.time));
    expect(row?.querySelector("time")?.getAttribute("datetime")).toBe(run.time);
  }
});

it("release review uses only the newest month and keeps one sentence stop", () => {
  const body = snapshot();
  const service = body.services?.find(({ service }) => service === "legal");
  const station = body.stations
    .find(({ service }) => service === "legal")
    ?.stations.find(({ id }) => id === "release");
  const older = service?.releases.find(({ releasePr }) => releasePr);
  if (!service || !station || !older) throw new Error("Missing legal release");
  const newest = { ...older, month: "2026-12" };
  delete newest.releasePr;
  service.releases = [older, newest];
  station.text = "Release review waiting.";
  const content = serviceOpening(body, "legal", { kind: "station", id: "legal:release" })?.content;
  expect(content?.primary).toBeUndefined();
  expect(content?.links).toBeUndefined();
  expect(content?.cause).toBe("Release review waiting. Not on Today.");
  expect(service.releases.map(({ month }) => month)).toEqual([older.month, "2026-12"]);
});
