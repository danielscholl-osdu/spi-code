// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type InspectResult, PROTOCOL_VERSION, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import actions from "../../../../fixtures/rib-59d6895/oracle/inspect-actions.json?raw";
import recorded from "../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import { RightPanel } from "./RightPanel.js";
import { createSelectionStore } from "./selection.js";
import { type SelectionRow, selectionRows } from "./selection-rows.js";

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

it("shows station label/state/text and inspects its upstream or explicit Release/Stack id", async () => {
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
            payload: { id: stationId === "release" ? "release:2026-10" : `upstream:${serviceId}` },
          }),
        );
      }
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each(["flow", "repository"] as const)(
  "resolves a Related %s from its snapshot row",
  async (kind) => {
    const rows = selectionRows(snapshot);
    const parent = rows.find((row) => row.kind === "queue");
    const target = rows.find((row) => row.kind === kind);
    if (!parent || !target) throw new Error("Missing recorded selection rows");
    const postMessage = vi.fn();
    const store = createSelectionStore({ postMessage });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel store={store} snapshot={snapshot} />));
    try {
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
        container.querySelector<HTMLButtonElement>('ul[aria-label="Related"] button')?.click(),
      );
      expect(store.getState().row).toEqual(target);
      expect(container.querySelector("h2")?.textContent).toBe(target.title);
      for (const field of target.fields ?? []) expect(container.textContent).toContain(field.value);
      expect(postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "inspect.request", payload: { id: target.id } }),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
