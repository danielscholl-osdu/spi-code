// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { type InspectResult, PROTOCOL_VERSION, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import actions from "../../../../fixtures/rib-59d6895/oracle/inspect-actions.json?raw";
import legalStations from "../../../../fixtures/watch/inspect-stations-legal-59d6895.json?raw";
import projected from "../../../../fixtures/watch/snapshot-59d6895.json?raw";
import recorded from "../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import { widthBudget } from "../app/width-budget.js";
import { plainTitle, sentenceCase } from "../text.js";
import { clockTime } from "../time.js";
import { bridgeOpens } from "./detail-action.js";
import { RightPanel } from "./RightPanel.js";
import { RightPanelFrame } from "./RightPanelFrame.js";
import { createSelectionStore } from "./selection.js";
import { routeSelectionIds, type SelectionRow, selectionRows } from "./selection-rows.js";

const panelsCss = readFileSync("apps/window/src/panels/panels.css", "utf8");
const snapshot = ViewSnapshotSchema.parse(JSON.parse(recorded));
const steps: { steps: { id: string; board: { header: { status: { label: string } } } }[] } =
  JSON.parse(actions);
const bare = structuredClone(snapshot);
for (const theme of bare.briefing.themes) delete theme.inspect;
for (const lane of bare.briefing.environment.lanes)
  for (const event of lane.events) delete event.inspect;
const recordedRows: SelectionRow[] = [
  ...selectionRows(snapshot),
  ...selectionRows(bare).filter(({ kind }) => kind === "theme" || kind === "environment"),
  ...steps.steps
    .filter(({ id }) => id !== "step:gone")
    .map(
      ({ id, board }): SelectionRow => ({
        id,
        title: board.header.status.label,
        kind: "template-step",
      }),
    ),
];
const kinds = [
  "queue",
  "flow",
  "plan",
  "repository",
  "template-step",
  "theme",
  "environment",
  "release",
] as const;

it.each(kinds)(
  "inspects every recorded %s id and renders the host's reading in Detail",
  async (kind) => {
    const rows = recordedRows.filter((row) => row.kind === kind);
    expect(rows.length).toBeGreaterThan(0);
    const postMessage = vi.fn();
    const store = createSelectionStore({ postMessage });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel store={store} snapshot={snapshot} />));
    try {
      for (const row of rows) {
        await act(async () => store.getState().select(row.id, row));
        const request = postMessage.mock.lastCall?.[0];
        expect(request).toMatchObject({
          type: "inspect.request",
          payload: { id: row.inspectId ?? row.id },
        });
        const result: InspectResult = {
          id: row.inspectId ?? row.id,
          title: "Host title does not replace the row's own title",
          class: "READY",
          cause: `Host cause for ${row.id}`,
          effect: `Host effect for ${row.id}`,
          next: `Host next for ${row.id}`,
          why: `Host why for ${row.id}`,
          related: [{ text: "Host related reading", state: "read" }],
          evidence: [],
          actions: [],
          approval: null,
        };
        await act(async () =>
          store.getState().receive({
            version: PROTOCOL_VERSION,
            id: request.id,
            kind: "response",
            type: "inspect.result",
            payload: result,
          }),
        );
        expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
          "Detail",
        );
        expect(container.querySelector("h2")?.textContent).toBe(row.title);
        for (const field of ["cause", "effect", "next", "why"] as const) {
          expect(container.querySelector(`[data-field="${field}"]`)?.textContent).toBe(
            result[field],
          );
        }
        expect(container.textContent).toContain("Host related reading");
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it("derives theme, hold and run ids when a row has no explicit inspect id", () => {
  const rows = selectionRows(bare);
  for (const theme of bare.briefing.themes) {
    expect(rows.some((row) => row.id === `theme:${theme.id}`)).toBe(true);
  }
  for (const lane of bare.briefing.environment.lanes) {
    for (const event of lane.events) {
      expect(
        rows.some((row) => row.id === `${lane.id === "holds" ? "hold" : "run"}:${event.id}`),
      ).toBe(true);
    }
  }
});

it.each(["fresh", "stale", "inferred", "release-stale"] as const)(
  "shows a clickable %s selection chip only when needed",
  async (state) => {
    const body = structuredClone(snapshot);
    body.areas = body.areas.map(({ area }) => ({
      area,
      envelope: {
        source: area,
        state: state === "stale" || state === "release-stale" ? "stale" : "fresh",
        observedAt: body.sweptAt,
        completeness: { kind: "complete" },
        ...(state === "inferred" ? { inferred: true } : {}),
      },
    }));
    const row = selectionRows(body).find(
      ({ kind }) => kind === (state === "release-stale" ? "release" : "flow"),
    );
    if (!row) throw new Error("Missing recorded Flow row");
    const store = createSelectionStore({ postMessage: vi.fn() });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel store={store} snapshot={body} />));
    try {
      await act(async () => store.getState().select(row.id, row));
      await act(async () =>
        store.getState().receive({
          version: PROTOCOL_VERSION,
          id: store.getState().request,
          kind: "response",
          type: "inspect.result",
          payload: {
            id: row.id,
            class: "READY",
            cause: "",
            effect: "",
            next: "",
            why: "",
            related: [],
            evidence: [],
            actions: [],
            approval: null,
            areas: body.areas,
            provenance: [
              { path: "/cause", areas: [state === "release-stale" ? "fleet" : "github"] },
            ],
          },
        }),
      );
      const chip = container.querySelector<HTMLButtonElement>("[data-selection-evidence]");
      if (state === "fresh") expect(chip).toBeNull();
      else {
        expect(container.querySelectorAll("[data-selection-evidence]")).toHaveLength(1);
        expect(container.querySelector(".detail-title")?.nextElementSibling).toBe(chip);
        expect(chip?.textContent?.toLowerCase()).toContain(
          state === "release-stale" ? "stale" : state,
        );
        await act(async () => chip?.click());
        expect(container.querySelector('[data-evidence="selection"]')).not.toBeNull();
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it("shows station label/state/text and inspects its own station or explicit Release/Stack id", async () => {
  const body = structuredClone(snapshot);
  for (const strip of body.stations) for (const station of strip.stations) delete station.inspect;
  const service = body.stations[0];
  if (!service) throw new Error("Missing recorded station strip");
  const release = service.stations.find(({ id }) => id === "release");
  if (!release) throw new Error("Missing Release station");
  release.inspect = "release:2026-10";
  const postMessage = vi.fn();
  const store = createSelectionStore({ postMessage });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RightPanel store={store} snapshot={body} />));
  try {
    for (const row of selectionRows(body).filter(({ kind }) => kind === "station")) {
      postMessage.mockClear();
      await act(async () => store.getState().select(row.id, row));
      for (const field of row.fields ?? []) expect(container.textContent).toContain(field.value);
      const stationId = row.id.split(":").at(-1);
      if (
        stationId === "lane" ||
        (stationId === "release" && !row.id.startsWith(`station:${service.service}:`))
      ) {
        expect(postMessage).not.toHaveBeenCalled();
        expect(container.textContent).not.toContain("Reading ");
      } else {
        const serviceId = row.id.split(":")[1];
        expect(postMessage).toHaveBeenLastCalledWith(
          expect.objectContaining({
            type: "inspect.request",
            payload: {
              id: stationId === "release" ? "release:2026-10" : `station:${serviceId}:${stationId}`,
            },
          }),
        );
      }
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

afterEach(() => {
  window.location.hash = "";
});

const lineStations = [
  ["upstream", "Upstream", "Open legal"],
  ["sync", "Sync PR", "Open on GitHub"],
  ["cascade", "Cascade", "Open on GitHub"],
  ["main", "Sync to main", "Open on GitHub"],
] as const;

type Bridge = {
  externalLinkHandlers(
    contents: { mainFrame: unknown },
    dependencies: { openExternal(url: string): Promise<void>; warn(message: string): void },
  ): {
    openFromRenderer(
      event: { sender: unknown; senderFrame: unknown },
      input: unknown,
    ): Promise<boolean>;
  };
};

/** The desktop's real link bridge, so an action it refuses cannot pass as opened. */
async function desktopBridge() {
  const path = "../../../desktop/src/external-links.ts";
  const { externalLinkHandlers } = (await import(/* @vite-ignore */ path)) as Bridge;
  const contents = { mainFrame: {} };
  const opened: string[] = [];
  const warn = vi.fn();
  const handlers = externalLinkHandlers(contents, {
    openExternal: async (url) => {
      opened.push(url);
    },
    warn,
  });
  const openExternal = (url: string) =>
    handlers.openFromRenderer({ sender: contents, senderFrame: contents.mainFrame }, url);
  return { opened, warn, openExternal };
}

it.each([
  "https://github.com/Azure/osdu-spi-legal/pull/31",
  "https://community.opengroup.org/osdu/platform/security-and-compliance/legal/-/commit/ba05b1c",
  "https://gitlab.com/osdu/legal",
  "http://github.com/Azure/osdu-spi-legal",
  "https://user:secret@github.com/Azure/osdu-spi-legal",
  "https://github.com.example.com/Azure",
  "not a url",
])("decides %s by the desktop bridge's own allowlist", async (url) => {
  const bridge = await desktopBridge();
  expect(bridgeOpens(url)).toBe(await bridge.openExternal(url));
});

async function mountStation(stationId: string) {
  const body = ViewSnapshotSchema.parse(JSON.parse(projected));
  const station = body.stations
    .find(({ service }) => service === "legal")
    ?.stations.find(({ id }) => id === stationId);
  const row = selectionRows(body).find(({ id }) => id === `station:legal:${stationId}`);
  const result = (JSON.parse(legalStations) as InspectResult[]).find(
    ({ id }) => id === `station:legal:${stationId}`,
  );
  if (!station || !row || !result) throw new Error(`Missing recorded legal ${stationId}`);
  const postMessage = vi.fn();
  const store = createSelectionStore({ postMessage });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RightPanel store={store} snapshot={body} />));
  await act(async () => store.getState().select(row.id, row));
  const request = postMessage.mock.lastCall?.[0];
  expect(request).toMatchObject({ type: "inspect.request", payload: { id: result.id } });
  await act(async () =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: request.id,
      kind: "response",
      type: "inspect.result",
      payload: result,
    }),
  );
  return {
    station,
    result,
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it.each(lineStations)(
  "leads the recorded legal %s station's Detail with its own reading and offers one action",
  async (stationId, label, verb) => {
    const view = await mountStation(stationId);
    const previous = window.spi;
    const bridge = await desktopBridge();
    window.spi = { ...previous, openExternal: bridge.openExternal };
    try {
      const { container, station, result } = view;
      expect(container.querySelector("h2")?.textContent).toBe(`${label} · legal`);
      const reading = container.querySelector('dl[aria-label="Row reading"]');
      const inspector = container.querySelector(".inspector");
      if (!reading || !inspector) throw new Error("Missing the station's reading");
      expect(
        reading.compareDocumentPosition(inspector) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect([...reading.querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual([
        label,
        station.state,
        station.text,
      ]);
      expect(container.querySelector('[data-field="cause"]')?.textContent).toBe(station.text);
      expect(result.related).toContainEqual(
        expect.objectContaining({ state: "Upstream", inspect: "upstream:legal" }),
      );
      const actions = container.querySelectorAll<HTMLButtonElement>("[data-detail-action]");
      expect(actions).toHaveLength(1);
      expect(actions[0]?.textContent).toBe(verb);
      expect(actions[0]?.disabled).toBe(false);
      await act(async () => actions[0]?.click());
      const own = result.related.find(
        (related) => related.url?.startsWith("https://github.com/") && !related.inspect,
      )?.url;
      expect(bridge.warn).not.toHaveBeenCalled();
      if (own) expect(bridge.opened).toEqual([own]);
      else {
        expect(bridge.opened).toEqual([]);
        expect(window.location.hash).toBe("#service/legal");
      }
    } finally {
      window.spi = previous;
      await view.cleanup();
    }
  },
);

it("offers the place, never a GitLab link the bridge would refuse, for a GitLab-only station", async () => {
  const view = await mountStation("upstream");
  try {
    const { container, result } = view;
    const urls = result.related.flatMap(({ url, inspect }) => (url && !inspect ? [url] : []));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/community\.opengroup\.org\//);
    const actions = container.querySelectorAll<HTMLButtonElement>("[data-detail-action]");
    expect([...actions].map((action) => [action.dataset.detailAction, action.textContent])).toEqual(
      [["place", "Open legal"]],
    );
    expect(container.querySelector(".detail-action")?.textContent).not.toMatch(/GitLab/);
  } finally {
    await view.cleanup();
  }
});

async function mountResult(result: InspectResult) {
  const row = recordedRows.find(({ kind }) => kind === "queue");
  if (!row) throw new Error("Missing recorded queue row");
  const postMessage = vi.fn();
  const store = createSelectionStore({ postMessage });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RightPanel store={store} snapshot={snapshot} />));
  await act(async () => store.getState().select(row.id, row));
  const request = postMessage.mock.lastCall?.[0];
  await act(async () =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: request.id,
      kind: "response",
      type: "inspect.result",
      payload: { ...result, id: row.inspectId ?? row.id },
    }),
  );
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const hostResult = (over: Partial<InspectResult>): InspectResult => ({
  id: "x",
  title: "x",
  class: "ROLLOUT",
  cause: "",
  effect: "",
  next: "",
  why: "",
  related: [],
  evidence: [],
  actions: [],
  approval: null,
  ...over,
});

it("renders Related as label and value rows, never one paragraph", async () => {
  const view = await mountStation("sync");
  try {
    const { container, result } = view;
    const related = container.querySelector('dl[aria-label="Related"]');
    if (!related) throw new Error("Missing Related table");
    expect(container.querySelector('ul[aria-label="Related"], p[aria-label="Related"]')).toBeNull();
    const rows = [...related.children];
    expect(rows).toHaveLength(result.related.length);
    for (const [index, entry] of result.related.entries()) {
      const row = rows[index];
      expect(row?.querySelector("dt")?.textContent ?? "").toBe(
        sentenceCase(plainTitle(entry.state)),
      );
      const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g;
      expect(row?.querySelector("dd")?.textContent).toBe(
        sentenceCase(plainTitle(entry.text)).replace(iso, (at) => clockTime(at)),
      );
      expect([...(row?.querySelectorAll("time") ?? [])].map((time) => time.dateTime)).toEqual(
        entry.text.match(iso) ?? [],
      );
      if (entry.state) expect(row?.querySelector("dd")?.textContent).not.toContain(entry.state);
    }
  } finally {
    await view.cleanup();
  }
});

it("stacks each Related label above its value and draws no label for an empty one", async () => {
  const long = "What the next sync carries · 29 commits behind upstream and a port owed";
  const view = await mountResult(
    hostResult({
      effect: "29 upstream commits queued",
      related: [
        { text: "os-core-common 8.5.0 · 29 commits", state: long },
        { text: "Back to the upstream plan", state: "", inspect: "upstream" },
        { text: "#58 · waits for review", state: "Sync PR" },
      ],
    }),
  );
  try {
    const related = view.container.querySelector('dl[aria-label="Related"]');
    if (!related) throw new Error("Missing Related list");
    const entries = [...related.children].map((entry) =>
      [...entry.children].map((child) => [child.tagName, child.textContent]),
    );
    expect(entries).toEqual([
      [
        ["DT", long],
        ["DD", "os-core-common 8.5.0 · 29 commits"],
      ],
      [["DD", "Back to the upstream plan"]],
      [
        ["DT", "Sync PR"],
        ["DD", "#58 · waits for review"],
      ],
    ]);
    const rules = panelsCss.match(/[^{}]*inspector-related[^{}]*\{[^}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).not.toMatch(/grid-template-columns|display:\s*(grid|contents)/);
    }
  } finally {
    await view.cleanup();
  }
});

it("renders an all-caps host state word in sentence case and leaves the host text alone", async () => {
  const result = hostResult({
    why: "PREPARED",
    effect: "P1 · CASCADE STOPPED",
    next: "Review PR #58 on GitHub",
    cause: "SPI CI",
    related: [{ text: "IN_PROGRESS", state: "SYNC TO MAIN" }],
  });
  const view = await mountResult(result);
  try {
    const field = (name: string) =>
      view.container.querySelector(`[data-field="${name}"]`)?.textContent;
    expect(field("why")).toBe("Prepared");
    expect(field("effect")).toBe("P1 · Cascade stopped");
    expect(field("next")).toBe("Review PR #58 on GitHub");
    expect(field("cause")).toBe("SPI CI");
    const entry = view.container.querySelector('dl[aria-label="Related"] > div');
    expect(entry?.querySelector("dt")?.textContent).toBe("Sync to main");
    expect(entry?.querySelector("dd")?.textContent).toBe("In progress");
    expect(result.why).toBe("PREPARED");
  } finally {
    await view.cleanup();
  }
});

it.each([
  ["PREPARED · SPI CI · PR #58", "Prepared · SPI CI · PR #58"],
  ["OSDU SPI", "OSDU SPI"],
  ["CONFLICT", "CONFLICT"],
  ["v0.35.5", "v0.35.5"],
  ["8.4.1-BOOT4-SNAPSHOT", "8.4.1-BOOT4-SNAPSHOT"],
  ["Azure/osdu-spi-entitlements#89", "Azure/osdu-spi-entitlements#89"],
  ["P1 · CASCADE STOPPED", "P1 · Cascade stopped"],
  ["UPSTREAM PLAN PAUSED", "Upstream plan paused"],
])("sentence-cases only the host's state words in %j", (value, shown) => {
  expect(sentenceCase(value)).toBe(shown);
});

it("knows every all-caps status the host's inspect boards emit", () => {
  const boards = ["upstream-fork", "upstream-plan", "mr", "step", "repo"];
  const labels = boards.flatMap((board) =>
    [
      ...readFileSync(`packages/core/src/inspect/${board}.ts`, "utf8").matchAll(
        /"([A-Z][A-Z0-9 ·_]{2,})"/g,
      ),
    ].map((match) => match[1] ?? ""),
  );
  expect(labels).toContain("PREPARED");
  for (const label of labels) {
    for (const part of label.split(" · ").filter((part) => !/\d/.test(part))) {
      expect(sentenceCase(part), label).not.toBe(part);
    }
  }
});

it("opens the fork's place as the one action for an upstream sync row", async () => {
  const body = ViewSnapshotSchema.parse(JSON.parse(projected));
  const row = selectionRows(body).find(({ id }) => id === "upstream:legal");
  if (!row) throw new Error("Missing recorded legal Flow row");
  const store = createSelectionStore({ postMessage: vi.fn() });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RightPanel store={store} snapshot={body} />));
  try {
    await act(async () => store.getState().select(row.id, row));
    const actions = container.querySelectorAll<HTMLButtonElement>("[data-detail-action]");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.textContent).toBe("Open legal");
    await act(async () => actions[0]?.click());
    expect(window.location.hash).toBe("#service/legal");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

async function mountRelated(kind: "flow" | "repository", width = 1280) {
  const budget = widthBudget({
    windowWidth: width,
    open: { sidebar: true, rightPanel: true, lineSheet: false },
  });
  const rows = selectionRows(snapshot);
  const parent = rows.find((row) => row.kind === "queue");
  const target = rows.find((row) => row.kind === kind);
  if (!parent || !target) throw new Error("Missing recorded selection rows");
  const postMessage = vi.fn();
  const store = createSelectionStore({ postMessage });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const refresh = async (body: typeof snapshot) => {
    await act(async () => {
      store.getState().receive({
        version: PROTOCOL_VERSION,
        id: `snapshot-${body.cursor}`,
        kind: "event",
        type: "view.snapshot",
        payload: body,
      });
      root.render(
        <RightPanelFrame
          store={store}
          presentation={budget.rightPanel.presentation}
          snapshot={body}
          sweepEvidence={<p data-sweep-evidence="">Sweep evidence {body.cursor}</p>}
        />,
      );
      store.getState().visit("#today", routeSelectionIds(body, { kind: "today" }), 0);
    });
  };
  await refresh(snapshot);
  expect(routeSelectionIds(snapshot, { kind: "today" })).not.toContain(target.id);
  await act(async () => store.getState().select(parent.id, parent));
  await act(async () =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: store.getState().request,
      kind: "response",
      type: "inspect.result",
      payload: {
        id: parent.id,
        class: "READY",
        cause: "Recorded queue reading",
        effect: "",
        next: "",
        why: "",
        actions: [],
        evidence: [],
        approval: null,
        related: [{ text: "Related alias", state: "read", inspect: target.id }],
      },
    }),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('dl[aria-label="Related"] button')?.click(),
  );
  return {
    store,
    postMessage,
    container,
    target,
    refresh,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function withoutRelatedTarget(target: SelectionRow) {
  const next = structuredClone(snapshot);
  next.cursor++;
  next.provenance = [];
  const fork = next.briefing.flow.rows.find(({ inspect }) => inspect === target.id)?.fork;
  next.briefing.flow.rows = next.briefing.flow.rows.filter(({ inspect }) => inspect !== target.id);
  next.stations = next.stations.filter(({ service }) => service !== fork);
  next.briefing.repositories.rows = next.briefing.repositories.rows.filter(
    ({ id }) => id !== target.id,
  );
  expect(JSON.stringify(next)).not.toContain(JSON.stringify(target.id));
  return ViewSnapshotSchema.parse(next);
}

it.each(["flow", "repository"] as const)(
  "resolves a Related %s from its snapshot row",
  async (kind) => {
    const view = await mountRelated(kind);
    try {
      expect(view.store.getState().row).toEqual(view.target);
      expect(view.container.querySelector("h2")?.textContent).toBe(view.target.title);
      for (const field of view.target.fields ?? [])
        expect(view.container.textContent).toContain(field.value);
      expect(view.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "inspect.request", payload: { id: view.target.id } }),
      );
    } finally {
      await view.cleanup();
    }
  },
);

it.each(
  (["flow", "repository"] as const).flatMap((kind) =>
    [900, 1280].map((width) => ({ kind, width })),
  ),
)(
  "clears a Related $kind and closes its panel at $width px when the id disappears from the whole snapshot",
  async ({ kind, width }) => {
    const view = await mountRelated(kind, width);
    try {
      await act(async () =>
        view.store.getState().receive({
          version: PROTOCOL_VERSION,
          id: view.store.getState().request,
          kind: "response",
          type: "inspect.result",
          payload: {
            id: view.target.id,
            class: "READY",
            cause: "Completed reading from the old sweep",
            effect: "",
            next: "",
            why: "",
            actions: [],
            evidence: [],
            approval: null,
            related: [],
          },
        }),
      );
      await act(async () => view.store.getState().select(view.target.id, view.target));
      const request = view.store.getState().request;
      expect(view.store.getState().result?.cause).toBe("Completed reading from the old sweep");
      expect(view.store.getState().selected).toBe(view.target.id);
      expect(view.container.querySelector("#app-right-panel")).not.toBeNull();
      const next = withoutRelatedTarget(view.target);
      await act(async () =>
        view.store.getState().receive({
          version: PROTOCOL_VERSION,
          id: "replayed-snapshot",
          kind: "event",
          type: "view.snapshot",
          payload: { ...next, cursor: snapshot.cursor },
        }),
      );
      expect(view.store.getState().selected).toBe(view.target.id);
      await view.refresh(ViewSnapshotSchema.parse(next));
      expect(view.store.getState()).toMatchObject({
        selected: null,
        row: null,
        open: false,
        request: null,
        result: null,
      });
      expect(view.container.querySelector("#app-right-panel")).toBeNull();
      expect(view.container.querySelector(".detail-backdrop")).toBeNull();
      expect(view.container.textContent).not.toContain(view.target.title);
      await act(async () =>
        view.store.getState().receive({
          version: PROTOCOL_VERSION,
          id: request,
          kind: "response",
          type: "inspect.result",
          payload: {
            id: view.target.id,
            class: "READY",
            cause: "Late reply from the old sweep",
            effect: "",
            next: "",
            why: "",
            actions: [],
            evidence: [],
            approval: null,
            related: [],
          },
        }),
      );
      expect(view.store.getState().result).toBeNull();
      await view.refresh(ViewSnapshotSchema.parse({ ...next, cursor: next.cursor + 1 }));
      expect(view.store.getState().selected).toBeNull();
      expect(view.container.querySelector("#app-right-panel")).toBeNull();
    } finally {
      await view.cleanup();
    }
  },
);

it.each(["flow", "repository"] as const)(
  "keeps sweep Evidence open at 1280 px when the Related %s disappears",
  async (kind) => {
    const view = await mountRelated(kind, 1280);
    try {
      await act(async () => view.store.getState().openSweepEvidence());
      expect(view.store.getState()).toMatchObject({
        selected: view.target.id,
        open: true,
        tab: "evidence",
        evidenceScope: "sweep",
      });
      expect(view.container.querySelector("[data-sweep-evidence]")?.textContent).toBe(
        `Sweep evidence ${snapshot.cursor}`,
      );
      const next = withoutRelatedTarget(view.target);
      await view.refresh(next);
      expect(view.store.getState()).toMatchObject({
        selected: null,
        row: null,
        request: null,
        result: null,
        open: true,
        tab: "evidence",
        evidenceScope: "sweep",
      });
      expect(view.container.querySelector("#app-right-panel")).not.toBeNull();
      expect(view.container.querySelector("[data-sweep-evidence]")?.textContent).toBe(
        `Sweep evidence ${next.cursor}`,
      );
      expect(view.container.querySelector(".detail-title")).toBeNull();
    } finally {
      await view.cleanup();
    }
  },
);

it.each(["flow", "repository"] as const)(
  "keeps a Related %s when only a reference elsewhere in the snapshot remains",
  async (kind) => {
    const view = await mountRelated(kind);
    try {
      const request = view.store.getState().request;
      const next = structuredClone(snapshot);
      next.cursor++;
      next.provenance = [];
      next.briefing.flow.rows = next.briefing.flow.rows.filter(
        ({ inspect }) => inspect !== view.target.id,
      );
      next.briefing.repositories.rows = next.briefing.repositories.rows.filter(
        ({ id }) => id !== view.target.id,
      );
      next.briefing.flow.also.push({ text: `Related ${kind}`, inspect: view.target.id });
      await view.refresh(ViewSnapshotSchema.parse(next));
      expect(view.store.getState()).toMatchObject({
        selected: view.target.id,
        open: true,
        request,
      });
      expect(view.container.querySelector("#app-right-panel")).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  },
);

it.each(["flow", "repository"] as const)(
  "keeps a Related %s off the current route and refreshes its row after it moves",
  async (kind) => {
    const view = await mountRelated(kind);
    try {
      const request = view.store.getState().request;
      const next = structuredClone(snapshot);
      next.cursor++;
      next.provenance = [];
      const currentTitle = "Reading from the latest sweep";
      if (kind === "flow") {
        const row = next.briefing.flow.rows.find(({ inspect }) => inspect === view.target.id);
        if (!row) throw new Error("Missing recorded flow row");
        row.detail.title = currentTitle;
        row.behind = "Latest behind count";
        next.briefing.flow.rows.reverse();
      } else {
        const row = next.briefing.repositories.rows.find(({ id }) => id === view.target.id);
        if (!row) throw new Error("Missing recorded repository row");
        row.title = currentTitle;
        next.briefing.repositories.rows.reverse();
      }
      await view.refresh(ViewSnapshotSchema.parse(next));
      expect(view.store.getState()).toMatchObject({
        selected: view.target.id,
        open: true,
        request,
      });
      expect(view.container.querySelector("#app-right-panel")).not.toBeNull();
      expect(view.container.querySelector("h2")?.textContent).toBe(currentTitle);
      if (kind === "flow") expect(view.container.textContent).toContain("Latest behind count");
    } finally {
      await view.cleanup();
    }
  },
);
