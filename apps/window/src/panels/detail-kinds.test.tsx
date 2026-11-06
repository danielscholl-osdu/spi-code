// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type InspectResult, PROTOCOL_VERSION, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import actions from "../../../../fixtures/rib-59d6895/oracle/inspect-actions.json?raw";
import recorded from "../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import { NARROW_LAYOUT_MEDIA_QUERY } from "../components/sidebar/ui-sidebar.js";
import { RightPanel } from "./RightPanel.js";
import { RightPanelFrame } from "./RightPanelFrame.js";
import { createSelectionStore } from "./selection.js";
import { routeSelectionIds, type SelectionRow, selectionRows } from "./selection-rows.js";

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

async function mountRelated(kind: "flow" | "repository", width = 1280) {
  const media = window.matchMedia(NARROW_LAYOUT_MEDIA_QUERY);
  const matches = vi.spyOn(media, "matches", "get").mockReturnValue(width < 980);
  const matchMedia = vi.spyOn(window, "matchMedia").mockReturnValue(media);
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
      root.render(<RightPanelFrame store={store} snapshot={body} />);
      store.getState().visit("#inbox", routeSelectionIds(body, { kind: "inbox" }), 0);
    });
  };
  await refresh(snapshot);
  expect(routeSelectionIds(snapshot, { kind: "inbox" })).not.toContain(target.id);
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
  return {
    store,
    postMessage,
    container,
    target,
    refresh,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      matchMedia.mockRestore();
      matches.mockRestore();
    },
  };
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
      const next = structuredClone(snapshot);
      next.cursor++;
      next.provenance = [];
      const fork = next.briefing.flow.rows.find(({ inspect }) => inspect === view.target.id)?.fork;
      next.briefing.flow.rows = next.briefing.flow.rows.filter(
        ({ inspect }) => inspect !== view.target.id,
      );
      next.stations = next.stations.filter(({ service }) => service !== fork);
      next.briefing.repositories.rows = next.briefing.repositories.rows.filter(
        ({ id }) => id !== view.target.id,
      );
      expect(JSON.stringify(next)).not.toContain(JSON.stringify(view.target.id));
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
      if (kind === "repository")
        next.briefing.flow.also.push({ text: "Related repository", inspect: view.target.id });
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
