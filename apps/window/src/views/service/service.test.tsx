// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, parseMessage, type ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import HALT from "../../../../../fixtures/rib-59d6895/oracle/inspect/HALT.json?raw";
import mixed from "../../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import { RightPanel } from "../../panels/RightPanel.js";
import { createSelectionStore, type SelectionStore } from "../../panels/selection.js";
import { selectionRows } from "../../panels/selection-rows.js";
import { inspectFromOracle, type OracleBoard } from "../../panels/test-inspect.js";
import { mixedSnapshot } from "../../store/test-snapshot.js";
import { createWatchStore, watchStore } from "../../store/watch.js";
import Environment from "../environment/index.js";
import ServicePage from "./index.js";

const SERVICE = "entitlements";
const container = document.createElement("div");
let root: ReturnType<typeof createRoot> | undefined;
let previous: Window["spi"];
const openExternal = vi.fn();

beforeEach(() => {
  previous = window.spi;
  window.spi = { proof: false, openExternal, postMessage: vi.fn(), onMessage: () => () => {} };
  openExternal.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  watchStore.getState().clear();
  watchStore.setState({ snapshot: null });
  window.spi = previous;
});

async function render(body: ViewSnapshot = mixedSnapshot(mixed), panel = false, id = SERVICE) {
  const postMessage = vi.fn();
  const selection = createSelectionStore({ postMessage });
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, selection: null });
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <ServicePage id={id} selection={selection} />
        {panel && <RightPanel store={selection} snapshot={body} />}
      </>,
    ),
  );
  const requested = () => {
    const parsed = parseMessage(postMessage.mock.lastCall?.[0]);
    if (!parsed.ok || parsed.message.type !== "inspect.request") return undefined;
    return parsed.message;
  };
  return { body, selection, postMessage, requested };
}

const section = (name: string) => container.querySelector<HTMLElement>(`[data-section="${name}"]`);
const click = (element: Element | null | undefined) =>
  act(async () => (element as HTMLElement | null)?.click());

it("draws stations, Attention, Threads, Upstream sync, Repository, Release and Runs in that order", async () => {
  await render();
  expect(container.querySelector("h1")?.textContent).toBe(SERVICE);
  expect(
    Array.from(container.querySelectorAll("[data-section]"), (el) =>
      el.getAttribute("data-section"),
    ),
  ).toEqual(["stations", "attention", "threads", "upstream", "repository", "release", "runs"]);
  expect(
    Array.from(container.querySelectorAll(".service-section h2"), (el) => el.textContent),
  ).toEqual(["Attention", "Threads", "Upstream sync", "Repository", "Release", "Runs"]);
  expect(section("threads")?.textContent).toBe("ThreadsThreads are not available yet.");
  expect(
    section("attention")?.querySelector("[data-selection-id]")?.getAttribute("data-selection-id"),
  ).toBe("halt:entitlements");
});

it("makes each of the six station tiles a selection that asks for its inspect", async () => {
  const { body, requested, selection } = await render();
  const stations = body.stations.find(({ service }) => service === SERVICE)?.stations ?? [];
  const tiles = section("stations")?.querySelectorAll<HTMLElement>("li[data-station]") ?? [];
  expect(tiles).toHaveLength(6);
  for (const [index, station] of stations.entries()) {
    const tile = tiles[index];
    expect(tile?.getAttribute("data-selection-id")).toBe(`station:${SERVICE}:${station.id}`);
    await click(tile);
    expect(selection.getState().selected).toBe(`station:${SERVICE}:${station.id}`);
    expect(tile?.getAttribute("aria-selected")).toBe("true");
    expect(requested()?.payload.id).toBe(station.inspect ?? `upstream:${SERVICE}`);
  }
  expect(section("stations")?.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
});

it("selects the flow row and shows its reading", async () => {
  const { requested, selection } = await render();
  const row = section("upstream")?.querySelector<HTMLElement>("[data-selection-id]");
  expect(row?.getAttribute("data-selection-id")).toBe(`upstream:${SERVICE}`);
  expect(row?.textContent).toContain("schemathesis-tests");
  expect(row?.textContent).toContain("Sync PR halt");
  expect(section("upstream")?.textContent).toContain("halted · add a filter rule");
  await click(row);
  expect(selection.getState().selected).toBe(`upstream:${SERVICE}`);
  expect(selection.getState().row?.kind).toBe("flow");
  expect(row?.getAttribute("aria-selected")).toBe("true");
  expect(requested()?.payload.id).toBe(`upstream:${SERVICE}`);
});

it("draws Release and Runs from the service rows, runs newest first and openable", async () => {
  const { body, requested } = await render();
  const service = body.services?.find(({ service }) => service === SERVICE);
  const release = section("release");
  expect(
    Array.from(release?.querySelectorAll("[data-release]") ?? [], (el) =>
      el.getAttribute("data-release"),
    ),
  ).toEqual(["2026-10", "2026-09"]);
  expect(release?.querySelector('[data-release="2026-10"]')?.textContent).toContain(
    "gate idle · v1.2.0",
  );
  const runs = Array.from(
    section("runs")?.querySelectorAll<HTMLElement>("[data-selection-id]") ?? [],
  );
  expect(runs).toHaveLength(service?.runs.length ?? -1);
  const times = runs.map((run) => run.querySelector("time")?.getAttribute("datetime") ?? "");
  expect(times).toEqual([...times].sort().reverse());
  const first = runs[0];
  await click(first);
  expect(requested()?.payload.id).toBe(first?.getAttribute("data-selection-id"));
  await act(async () => first?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(openExternal).toHaveBeenCalledWith(
    service?.runs.find(({ id }) => id === first?.getAttribute("data-selection-id"))?.url,
  );
});

const hintOf = (month: string) =>
  section("release")?.querySelector(`[data-release="${month}"]`)?.querySelector("[data-gate-hint]")
    ?.textContent;

const UNTIMED =
  "The gate and this row can differ because they use separate reads: the GitHub read for the gate and the release history read for this row.";
const read = (source: string, object: string, observedAt: string) => ({
  source,
  object,
  observedAt,
  completeness: { kind: "complete" as const },
});

it("says which reads the gate and the release row come from when their versions differ", async () => {
  await render();
  const october = section("release")?.querySelector('[data-release="2026-10"]');
  expect(october?.textContent).toContain("new → v1.2.1");
  expect(october?.textContent).toContain("gate idle · v1.2.0");
  expect(hintOf("2026-10")).toBe(UNTIMED);
  expect(hintOf("2026-09")).toBeUndefined();
});

it("gives no hint when the gate agrees with the release row", async () => {
  await render(mixedSnapshot(mixed), false, "schema");
  const october = section("release")?.querySelector('[data-release="2026-10"]');
  expect(october?.textContent).toContain("new → v1.2.0");
  expect(october?.textContent).toContain("gate idle · v1.2.0");
  expect(hintOf("2026-10")).toBeUndefined();
});

it("does not stamp the gate with another repository's GitHub read from a split batch", async () => {
  const body = mixedSnapshot(mixed);
  const earliest = "2026-10-12T21:50:00.000Z";
  await render({
    ...body,
    reads: [
      ...body.reads,
      read("github", "Azure/osdu-spi-partition", earliest),
      read("github", "Azure/osdu-spi-entitlements", "2026-10-12T21:58:23.086Z"),
    ],
    areas: body.areas.map((entry) =>
      entry.area === "github" && entry.envelope.state !== "unread"
        ? { area: "github", envelope: { ...entry.envelope, observedAt: earliest } }
        : entry,
    ),
  });
  expect(hintOf("2026-10")).toBe(UNTIMED);
});

it("does not date the release history by a cached build pin", async () => {
  const body = mixedSnapshot(mixed);
  const pinned = "2026-10-01T08:00:00.000Z";
  await render({
    ...body,
    reads: [
      ...body.reads,
      read("github-releases", "Azure/osdu-spi-entitlements", "2026-10-21T15:10:40.718Z"),
      read("github-pins", "Azure/osdu-spi-entitlements@v1.2.1", pinned),
    ],
    provenance: body.provenance.map((source) =>
      source.path.endsWith("/releases") && source.envelope && source.envelope.state !== "unread"
        ? { ...source, envelope: { ...source.envelope, observedAt: pinned } }
        : source,
    ),
  });
  expect(hintOf("2026-10")).toBe(UNTIMED);
});

it("leaves Release, Runs and line selection out when the snapshot lacks those fields", async () => {
  const body = mixedSnapshot(mixed);
  const { services: _, ...rest } = body;
  const bare: ViewSnapshot = {
    ...rest,
    briefing: {
      ...rest.briefing,
      repositories: {
        ...rest.briefing.repositories,
        rows: rest.briefing.repositories.rows.map((row) => ({
          ...row,
          sections: row.sections.map((s) => ({
            ...s,
            lines: s.lines.map(({ id: _id, url: _url, ...line }) => line),
          })),
        })),
      },
    },
  };
  await render(bare);
  expect(section("release")).toBeNull();
  expect(section("runs")).toBeNull();
  expect(container.textContent).not.toMatch(/\bRuns\b|No runs|No release/);
  const repository = section("repository");
  const lines = repository?.querySelectorAll("[data-plain]") ?? [];
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expect(line.hasAttribute("data-selection-id")).toBe(false);
  expect(
    Array.from(repository?.querySelectorAll("[data-selection-id]") ?? [], (el) =>
      el.getAttribute("data-selection-id"),
    ),
  ).toEqual([`repo:${SERVICE}`]);
});

it("makes repository lines with ids selectable and openable", async () => {
  const { requested, selection } = await render();
  const line = section("repository")?.querySelector<HTMLElement>(
    `[data-selection-id="issue:Azure/osdu-spi-entitlements:47"]`,
  );
  expect(line?.textContent).toContain("Upstream Sync Failed");
  expect(section("repository")?.querySelector("[data-plain]")).toBeNull();
  await click(line);
  expect(selection.getState().row?.kind).toBe("repository-line");
  expect(requested()?.payload.id).toBe("issue:Azure/osdu-spi-entitlements:47");
  await act(async () => line?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(openExternal).toHaveBeenCalledWith(
    "https://github.com/Azure/osdu-spi-entitlements/issues/47",
  );
});

it("offers Detail and keeps Ask, Add to chat and + Thread disabled with the reason", async () => {
  const { selection } = await render();
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(".service-tool button"));
  expect(buttons.map((button) => [button.textContent, button.disabled])).toEqual([
    ["Detail", false],
    ["Ask", true],
    ["Add to chat", true],
    ["+ Thread", true],
  ]);
  for (const button of buttons.slice(1)) {
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe("Threads are not available yet.");
  }
  expect(buttons[0]?.hasAttribute("aria-describedby")).toBe(false);
  await act(async () => {
    selection.getState().setOpen(false);
    selection.getState().setTab("evidence");
  });
  await click(buttons[0]);
  expect(selection.getState().open).toBe(true);
  expect(selection.getState().tab).toBe("detail");
  expect(selection.getState().selected).toBe(`upstream:${SERVICE}`);
});

it("fills the right panel's Detail with the selected tile", async () => {
  const { selection, requested } = await render(undefined, true);
  const panel = () => container.querySelector<HTMLElement>("aside[aria-label='Detail']");
  expect(panel()?.textContent).toContain("No selection");
  await click(section("stations")?.querySelector('[data-station="sync"]'));
  expect(panel()?.querySelector(".inspector-kicker")?.textContent).toBe("station");
  expect(panel()?.querySelector(".detail-title")?.textContent).toBe(`Sync PR · ${SERVICE}`);
  expect(panel()?.querySelector(".detail-row-fields")?.textContent).toContain(
    "halted: UNKNOWN_TOP_LEVEL",
  );
  const request = requested();
  if (!request) throw new Error("No inspect request");
  const result = inspectFromOracle(JSON.parse(HALT) as OracleBoard, `upstream:${SERVICE}`);
  await act(async () =>
    selection.getState().receive({
      version: PROTOCOL_VERSION,
      id: request.id,
      kind: "response",
      type: "inspect.result",
      payload: result,
    }),
  );
  expect(panel()?.querySelector('[data-field="class"]')?.textContent).toBe("HALT");
  await click(section("runs")?.querySelector("[data-selection-id]"));
  expect(panel()?.querySelector(".inspector-kicker")?.textContent).toBe("run");
  expect(panel()?.querySelector(".detail-row-fields")?.textContent).toContain("Workflow");
  await click(
    section("repository")?.querySelector(
      '[data-selection-id="issue:Azure/osdu-spi-entitlements:47"]',
    ),
  );
  expect(panel()?.querySelector(".inspector-kicker")?.textContent).toBe("repository line");
  const fields = Array.from(
    panel()?.querySelectorAll(".detail-row-fields dt") ?? [],
    (term) => term.textContent,
  );
  expect(fields).toEqual(["Tag", "Reading", "Id", "Link"]);
  expect(panel()?.querySelector(".detail-row-fields")?.textContent).toContain(
    "https://github.com/Azure/osdu-spi-entitlements/issues/47",
  );
});

it("converts an offset run time to UTC before labelling it", async () => {
  const body = mixedSnapshot(mixed);
  const services = body.services?.map((entry) =>
    entry.service === SERVICE
      ? {
          ...entry,
          runs: entry.runs.map((run, index) =>
            index === 0 ? { ...run, time: "2026-10-13T10:15:00+02:00" } : run,
          ),
        }
      : entry,
  );
  const { selection } = await render({ ...body, services });
  const first = section("runs")?.querySelector<HTMLElement>("[data-selection-id]");
  expect(first?.querySelector("time")?.textContent).toBe("2026-10-13 08:15 UTC");
  await click(first);
  expect(selection.getState().row?.fields).toContainEqual({
    label: "When",
    value: "2026-10-13 08:15 UTC",
    dateTime: "2026-10-13T10:15:00+02:00",
  });
});

it("keeps repository lines in source order when only some carry an identity", async () => {
  const body = mixedSnapshot(mixed);
  const rows = body.briefing.repositories.rows.map((row) =>
    row.id !== `repo:${SERVICE}`
      ? row
      : {
          ...row,
          sections: row.sections.map((s) =>
            s.title !== "Vulnerabilities"
              ? s
              : {
                  ...s,
                  lines: s.lines.map(({ id, url, ...line }, index) =>
                    index === 0 ? line : { ...line, id, url },
                  ),
                },
          ),
        },
  );
  const bare: ViewSnapshot = {
    ...body,
    briefing: { ...body.briefing, repositories: { ...body.briefing.repositories, rows } },
  };
  await render(bare);
  const vulnerabilities = Array.from(
    section("repository")?.querySelectorAll(".service-repo-section") ?? [],
  ).find((el) =>
    el.querySelector(".repo-section-title")?.textContent?.startsWith("Vulnerabilities"),
  );
  const lines = Array.from(vulnerabilities?.querySelectorAll(".service-row") ?? []);
  expect(lines.map((line) => line.querySelector(".service-row-title")?.textContent)).toEqual([
    "log4j-core · 3 vulnerabilities",
    "log4j-api · 1 vulnerability",
  ]);
  expect(lines.map((line) => line.getAttribute("data-selection-id"))).toEqual([
    null,
    "alert:Azure/osdu-spi-entitlements:dep:pom.xml:org.apache.logging.log4j:log4j-api",
  ]);
  expect(lines[0]?.hasAttribute("data-plain")).toBe(true);
});

const STACK = "osdu-spi-stack";
const STACK_LINE = "issue:Azure/osdu-spi-stack:324";

type WatchStore = ReturnType<typeof createWatchStore>;

function LivePanel({ watch, selection }: { watch: WatchStore; selection: SelectionStore }) {
  const body = useStore(watch, (state) => state.snapshot?.body);
  return <RightPanel store={selection} {...(body ? { snapshot: body } : {})} />;
}

async function renderBoth(body: ViewSnapshot) {
  const selection = createSelectionStore({ postMessage: vi.fn() });
  const watch = createWatchStore(vi.fn(), selection);
  watch.setState({ snapshot: { cursor: body.cursor, body } });
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <>
        <ServicePage id={STACK} store={watch} selection={selection} />
        <Environment store={watch} inspector={selection} />
        <LivePanel watch={watch} selection={selection} />
      </>,
    ),
  );
  const page = {
    service: (id: string) =>
      section("repository")?.querySelector<HTMLElement>(`[data-selection-id="${id}"]`),
    environment: (id: string) =>
      container.querySelector<HTMLElement>(`.environment [data-selection-id="${id}"]`),
  };
  return { selection, watch, page };
}

const detailFields = () =>
  Array.from(
    container.querySelectorAll("aside[aria-label='Detail'] .detail-row-fields > div"),
    (pair) => [pair.querySelector("dt")?.textContent, pair.querySelector("dd")?.textContent],
  );

const stackLine = (body: ViewSnapshot, id: string) => {
  const line = body.briefing.repositories.rows
    .find(({ name }) => name === STACK)
    ?.sections.flatMap(({ lines }) => lines)
    .find((line) => line.id === id);
  if (!line) throw new Error(`Recorded stack needs ${id}`);
  return line;
};

it("shows the same Detail fields for a stack line selected on its service page or on Environment", async () => {
  const body = mixedSnapshot(mixed);
  const line = stackLine(body, STACK_LINE);
  const { selection, page } = await renderBoth(body);
  const expected = selectionRows(body).find(({ id }) => id === STACK_LINE);

  await click(page.service(STACK_LINE));
  expect(selection.getState().row).toEqual(expected);
  const fromService = detailFields();
  expect(fromService).toEqual([
    ["Tag", line.tag],
    ["Reading", line.sub],
    ["Id", STACK_LINE],
    ["Link", line.url],
  ]);

  await act(async () => selection.getState().clear());
  expect(detailFields()).toEqual([]);
  await click(page.environment(STACK_LINE));
  expect(selection.getState().row).toEqual(expected);
  expect(detailFields()).toEqual(fromService);
});

it.each(["service", "environment"] as const)(
  "refreshes a stack line's Detail in place after a sweep changes it (selected on %s)",
  async (from) => {
    const body = mixedSnapshot(mixed);
    const { watch, page } = await renderBoth(body);
    await click(page[from](STACK_LINE));
    const next = structuredClone(body);
    next.cursor = body.cursor + 1;
    Object.assign(stackLine(next, STACK_LINE), {
      text: "Refreshed issue title",
      tag: "regression",
      sub: "reopened 1h ago",
    });
    await act(async () => watch.setState({ snapshot: { cursor: next.cursor, body: next } }));
    const panel = container.querySelector("aside[aria-label='Detail']");
    expect(panel?.querySelector(".detail-title")?.textContent).toBe("Refreshed issue title");
    expect(detailFields()).toEqual([
      ["Tag", "regression"],
      ["Reading", "reopened 1h ago"],
      ["Id", STACK_LINE],
      ["Link", stackLine(body, STACK_LINE).url],
    ]);
  },
);

it("refreshes a selected service line's Detail after a sweep inserts a line before it", async () => {
  const body = mixedSnapshot(mixed);
  const { watch, page } = await renderBoth(body);
  await click(page.service(STACK_LINE));
  const next = structuredClone(body);
  next.cursor = body.cursor + 1;
  const issues = next.briefing.repositories.rows
    .find(({ name }) => name === STACK)
    ?.sections.find(({ title }) => title === "Issues");
  if (!issues) throw new Error("Recorded stack needs Issues");
  issues.lines.unshift({
    ...stackLine(body, STACK_LINE),
    id: "issue:Azure/osdu-spi-stack:330",
    url: "https://github.com/Azure/osdu-spi-stack/issues/330",
    text: "A newer issue",
  });
  Object.assign(stackLine(next, STACK_LINE), {
    text: "Refreshed issue title",
    tag: "regression",
    sub: "reopened 1h ago",
  });
  await act(async () => watch.setState({ snapshot: { cursor: next.cursor, body: next } }));
  const panel = container.querySelector("aside[aria-label='Detail']");
  expect(panel?.querySelector(".detail-title")?.textContent).toBe("Refreshed issue title");
  expect(detailFields()).toEqual([
    ["Tag", "regression"],
    ["Reading", "reopened 1h ago"],
    ["Id", STACK_LINE],
    ["Link", stackLine(body, STACK_LINE).url],
  ]);
});

it("keeps a selected upgrade's Detail when a refresh drops it and leaves its same-id hold", async () => {
  const body = mixedSnapshot(mixed);
  const { watch } = await renderBoth(body);
  const upgrade = container.querySelector<HTMLElement>(
    '.environment [data-lane="upgrade"] [data-event]',
  );
  const hold = container.querySelector<HTMLElement>(
    '.environment [data-lane="holds"] [data-event]',
  );
  if (!upgrade || !hold) throw new Error("Recorded fixture needs upgrade and hold events");
  expect(hold.dataset.selectionId).toBe(upgrade.dataset.selectionId);
  await click(upgrade);
  const title = () => container.querySelector("aside[aria-label='Detail'] .detail-title");
  expect(title()?.textContent).toBe("v0.28.2");
  const next = structuredClone(body);
  next.cursor = body.cursor + 1;
  const lane = next.briefing.environment.lanes.find(({ id }) => id === "upgrade");
  if (!lane) throw new Error("Recorded fixture needs an upgrade lane");
  lane.events = [];
  await act(async () => watch.setState({ snapshot: { cursor: next.cursor, body: next } }));
  expect(title()?.textContent).toBe("v0.28.2");
});

it("keeps unidentified stack lines unselectable in source order on both pages, and arrows past them", async () => {
  const body = mixedSnapshot(mixed);
  const issues = body.briefing.repositories.rows
    .find(({ name }) => name === STACK)
    ?.sections.find(({ title }) => title === "Issues");
  const [first, middle, last] = issues?.lines ?? [];
  if (!first?.id || !middle || !last?.id) throw new Error("Recorded stack needs three issues");
  delete middle.id;
  delete middle.url;
  const { selection, page } = await renderBoth(body);

  const service = Array.from(
    section("repository")
      ?.querySelector(".service-repo-section")
      ?.querySelectorAll(".service-row") ?? [],
  );
  const environment = Array.from(
    container.querySelector(".environment .env-repo-section")?.querySelectorAll(".env-repo-line") ??
      [],
  );
  for (const rows of [service, environment]) {
    expect(rows.map((row) => row.textContent?.includes(middle.text))).toEqual([false, true, false]);
    expect(rows.map((row) => row.getAttribute("data-selection-id"))).toEqual([
      first.id,
      null,
      last.id,
    ]);
  }
  expect(selectionRows(body).some(({ title }) => title === middle.text)).toBe(false);

  for (const option of [page.service(first.id), page.environment(first.id)]) {
    await click(option);
    option?.focus();
    await act(async () =>
      option?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    expect(selection.getState().selected).toBe(last.id);
    expect(document.activeElement?.getAttribute("data-selection-id")).toBe(last.id);
  }
});
