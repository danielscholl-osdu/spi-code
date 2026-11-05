// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  type SetupState,
  type SweepStatus,
} from "@spi-code/contracts";
import { createStore } from "zustand/vanilla";

export type Snapshot = { cursor: number; body: unknown };
type WatchState = {
  snapshot: Snapshot | null;
  sweep: SweepStatus | null;
  setup: SetupState | null;
  receive(input: unknown): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createWatchStore(send: (message: Message) => void) {
  return createStore<WatchState>((set, get) => ({
    snapshot: null,
    sweep: null,
    setup: null,
    receive(input) {
      // BRIEFSCHEMA will replace this minimal boundary with the snapshot contract.
      if (isRecord(input) && input.type === "view.snapshot") {
        const payload = input.payload;
        if (
          input.version !== PROTOCOL_VERSION ||
          input.kind !== "event" ||
          typeof input.id !== "string" ||
          !input.id ||
          !isRecord(payload) ||
          typeof payload.cursor !== "number" ||
          !Number.isSafeInteger(payload.cursor) ||
          payload.cursor < 0
        )
          throw new Error("Invalid view.snapshot");
        const last = get().snapshot;
        if (!last || payload.cursor > last.cursor) {
          set({ snapshot: { cursor: payload.cursor, body: payload } });
        }
        return;
      }
      const parsed = parseMessage(input);
      if (!parsed.ok) throw new Error("Invalid host message");
      const message = parsed.message;
      if (message.type === "sweep.status") set({ sweep: message.payload });
      if (message.type === "setup.state") set({ setup: message.payload });
      if (message.type === "host.hello") {
        const outgoing = parseMessage({
          version: PROTOCOL_VERSION,
          id: crypto.randomUUID(),
          kind: "request",
          type: "view.subscribe",
          payload: { fromCursor: get().snapshot?.cursor ?? 0 },
        });
        if (!outgoing.ok) throw new Error("Invalid view.subscribe");
        send(outgoing.message);
      }
    },
  }));
}
