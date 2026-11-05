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

export const PANEL_TABS = ["inspector", "log"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

export type InspectPort = { postMessage(message: Message): void };

export type SelectionState = {
  selected: string | null;
  request: string | null;
  result: InspectResult | null;
  error: string | null;
  tab: PanelTab;
  select(id: string): void;
  clear(): void;
  setTab(tab: PanelTab): void;
  receive(input: unknown): void;
};

export function createSelectionStore(port: InspectPort) {
  return createStore<SelectionState>((set, get) => ({
    selected: null,
    request: null,
    result: null,
    error: null,
    tab: "inspector",
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
      });
      port.postMessage(parsed.message);
    },
    clear() {
      set({ selected: null, request: null, result: null, error: null });
    },
    setTab(tab) {
      set({ tab });
    },
    receive(input) {
      const parsed = parseMessage(input);
      if (!parsed.ok) return;
      const message = parsed.message;
      const { request, selected } = get();
      if (request === null || message.id !== request) return;
      if (message.type === "inspect.result") {
        if (message.payload.id !== selected) return;
        set({ result: message.payload, request: null, error: null });
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
