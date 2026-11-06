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

export const PANEL_TABS = ["inspector", "evidence", "log"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export type InspectPort = { postMessage(message: Message): void };

export type SelectionState = {
  selected: string | null;
  request: string | null;
  result: InspectResult | null;
  error: string | null;
  // The host holds nothing under the selected id: a quiet state, not an error.
  missing: string | null;
  tab: PanelTab;
  /** Whose evidence the Evidence tab shows: the selection's, or the sweep's from the title bar. */
  evidenceScope: "selection" | "sweep";
  select(id: string): void;
  clear(): void;
  setTab(tab: PanelTab): void;
  openSweepEvidence(): void;
  receive(input: unknown): void;
};

export function createSelectionStore(port: InspectPort) {
  let hostPid: number | undefined;
  return createStore<SelectionState>((set, get) => ({
    selected: null,
    request: null,
    result: null,
    error: null,
    missing: null,
    tab: "inspector",
    evidenceScope: "selection",
    select(id) {
      const parsed = parseMessage({
        version: PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        kind: "request",
        type: "inspect.request",
        payload: { id },
      });
      if (!parsed.ok) throw new Error("Invalid inspect request");
      const result = get().result;
      set({
        selected: id,
        request: parsed.message.id,
        result: result?.id === id ? result : null,
        error: null,
        missing: null,
        evidenceScope: "selection",
      });
      port.postMessage(parsed.message);
    },
    clear() {
      set({ selected: null, request: null, result: null, error: null, missing: null });
    },
    setTab(tab) {
      set(tab === "evidence" ? { tab } : { tab, evidenceScope: "selection" });
    },
    openSweepEvidence() {
      set({ tab: "evidence", evidenceScope: "sweep" });
    },
    receive(input) {
      const parsed = parseMessage(input);
      if (!parsed.ok) return;
      const message = parsed.message;
      const { request, selected } = get();
      if (message.type === "host.hello") {
        const changed = message.payload.pid !== hostPid;
        hostPid = message.payload.pid;
        if (changed && request !== null && selected !== null) get().select(selected);
        return;
      }
      if (message.type === "error" && message.payload.code === "host_unavailable") {
        if (request !== null) set({ request: null, error: message.payload.message });
        return;
      }
      if (request === null || message.id !== request) return;
      if (message.type === "inspect.result") {
        if (message.payload.id !== selected) return;
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
