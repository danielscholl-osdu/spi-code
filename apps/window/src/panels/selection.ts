// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import {
  type InspectResult,
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
} from "@spi-code/contracts";
import { createStore } from "zustand/vanilla";
import { type SelectionRow, snapshotHasSelection } from "./selection-rows.js";

export const PANEL_TABS = ["detail", "evidence"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export type InspectPort = { postMessage(message: Message): void };

export type SelectionState = {
  selected: string | null;
  row: SelectionRow | null;
  open: boolean;
  request: string | null;
  result: InspectResult | null;
  error: string | null;
  // The host holds nothing under the selected id: a quiet state, not an error.
  missing: string | null;
  tab: PanelTab;
  /** Whose evidence the Evidence tab shows: the selection's, or the sweep's from the title bar. */
  evidenceScope: "selection" | "sweep";
  /** Existing id-only callers work; lists should also supply their row's own title and kind. */
  select(id: string, row?: SelectionRow): void;
  clear(): void;
  setOpen(open: boolean): void;
  /** Called by the route frame; returns that route's saved scroll offset. */
  visit(route: string, ids: readonly string[], scrollTop: number): number;
  setTab(tab: PanelTab): void;
  openSweepEvidence(): void;
  receive(input: unknown): void;
};

export function createSelectionStore(port: InspectPort) {
  let hostPid: number | undefined;
  let snapshotCursor = -1;
  let route: string | undefined;
  let listedIds = new Set<string>();
  const positions = new Map<
    string,
    { selected: string | null; row: SelectionRow | null; top: number }
  >();
  return createStore<SelectionState>((set, get) => ({
    selected: null,
    row: null,
    // PS-11: the panel is context for the centre, so it starts closed with nothing to show.
    open: false,
    request: null,
    result: null,
    error: null,
    missing: null,
    tab: "detail",
    evidenceScope: "selection",
    select(id, row) {
      if (row && row.id !== id) throw new Error("Selection row does not match its id");
      if (row?.inspectId === null) {
        set({
          selected: id,
          row,
          open: true,
          request: null,
          result: null,
          error: null,
          missing: null,
          tab: "detail",
          evidenceScope: "selection",
        });
        return;
      }
      const parsed = parseMessage({
        version: PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        kind: "request",
        type: "inspect.request",
        payload: { id: row?.inspectId ?? id },
      });
      if (!parsed.ok) throw new Error("Invalid inspect request");
      const result = get().result;
      set({
        selected: id,
        row: row ?? null,
        open: true,
        request: parsed.message.id,
        result: result?.id === (row?.inspectId ?? id) ? result : null,
        error: null,
        missing: null,
        tab: "detail",
        evidenceScope: "selection",
      });
      port.postMessage(parsed.message);
    },
    clear() {
      const { open, tab, evidenceScope } = get();
      set({
        selected: null,
        row: null,
        // Only the sweep's Evidence still has something to show once the selection is gone.
        open: open && tab === "evidence" && evidenceScope === "sweep",
        request: null,
        result: null,
        error: null,
        missing: null,
      });
    },
    setOpen(open) {
      if (!open) set({ open });
      else if (get().selected === null) set({ open, tab: "evidence", evidenceScope: "sweep" });
      else set({ open, tab: "detail", evidenceScope: "selection" });
    },
    visit(nextRoute, ids, scrollTop) {
      const current = get();
      const previouslyListed = listedIds;
      listedIds = new Set(ids);
      if (route === nextRoute) {
        if (
          current.selected !== null &&
          previouslyListed.has(current.selected) &&
          !listedIds.has(current.selected)
        )
          get().clear();
        return scrollTop;
      }
      if (route !== undefined)
        positions.set(route, { selected: current.selected, row: current.row, top: scrollTop });
      route = nextRoute;
      const saved = positions.get(nextRoute);
      if (current.selected !== null && ids.includes(current.selected)) return saved?.top ?? 0;
      if (saved?.selected && ids.includes(saved.selected))
        get().select(saved.selected, saved.row ?? undefined);
      else if (current.selected !== null) get().clear();
      return saved?.top ?? 0;
    },
    setTab(tab) {
      if (tab === "evidence") set({ tab });
      // PS-11: Detail with nothing selected has nothing to show, so the panel closes.
      else
        set({
          tab,
          evidenceScope: "selection",
          ...(get().selected === null ? { open: false } : {}),
        });
    },
    openSweepEvidence() {
      set({ tab: "evidence", evidenceScope: "sweep", open: true });
    },
    receive(input) {
      const parsed = parseMessage(input);
      if (!parsed.ok) return;
      const message = parsed.message;
      const { request, selected } = get();
      if (message.type === "view.snapshot") {
        if (message.payload.cursor <= snapshotCursor) return;
        snapshotCursor = message.payload.cursor;
        const row = get().row;
        if (
          selected !== null &&
          (row?.kind === "flow" || row?.kind === "repository") &&
          !snapshotHasSelection(message.payload, selected)
        ) {
          get().clear();
          if (get().evidenceScope !== "sweep") set({ open: false });
        }
        return;
      }
      if (message.type === "host.hello") {
        const changed = message.payload.pid !== hostPid;
        hostPid = message.payload.pid;
        if (changed && request !== null && selected !== null)
          get().select(selected, get().row ?? undefined);
        return;
      }
      if (message.type === "error" && message.payload.code === "host_unavailable") {
        if (request !== null) set({ request: null, error: message.payload.message });
        return;
      }
      if (request === null || message.id !== request) return;
      if (message.type === "inspect.result") {
        if (message.payload.id !== (get().row?.inspectId ?? selected)) return;
        set({ result: message.payload, request: null, error: null, missing: null });
      } else if (message.type === "error" && message.payload.code === "not_found") {
        set({ request: null, result: null, missing: message.payload.message });
      } else if (message.type === "error") {
        set({ request: null, error: message.payload.message });
      }
    },
  }));
}

export type SelectionStore = ReturnType<typeof createSelectionStore>;

export const selectionStore = createSelectionStore({
  postMessage: (message) => window.spi.postMessage(message),
});
