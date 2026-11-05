// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type Envelope,
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  type SetupSigninProgress,
  type SetupState,
  type SweepStatus,
  type ViewSnapshot,
  type WatchMessage,
} from "@spi-code/contracts";
import { createStore } from "zustand/vanilla";
import { createSelectionStore, type SelectionStore, selectionStore } from "../panels/selection.js";

export type Snapshot = { cursor: number; body: ViewSnapshot };
type WatchState = {
  snapshot: Snapshot | null;
  readonly selection: { readonly id: string } | null;
  select(id: string): void;
  clear(): void;
  sweep: SweepStatus | null;
  setup: SetupState | null;
  signin: Partial<Record<SetupSigninProgress["tool"], SetupSigninProgress>>;
  signinOutcome: Partial<Record<SetupSigninProgress["tool"], SetupSigninProgress>>;
  requestSetup(
    ...request: {
      [T in "setup.install" | "setup.signin"]: [
        type: T,
        tool: Extract<WatchMessage, { type: T }>["payload"]["tool"],
      ];
    }["setup.install" | "setup.signin"]
  ): void;
  receive(input: unknown): void;
};

const selectionOf = (selected: string | null) => (selected === null ? null : { id: selected });

export function selectAreaEnvelopes(state: Pick<WatchState, "snapshot">): Envelope[] {
  return state.snapshot?.body.areas.map(({ envelope }) => envelope) ?? [];
}

export function createWatchStore(
  send: (message: Message) => void,
  inspector: SelectionStore = createSelectionStore({ postMessage: send }),
) {
  const store = createStore<WatchState>((set, get) => ({
    snapshot: null,
    selection: selectionOf(inspector.getState().selected),
    select(id) {
      inspector.getState().select(id);
    },
    clear() {
      inspector.getState().clear();
    },
    sweep: null,
    setup: null,
    signin: {},
    signinOutcome: {},
    requestSetup(type, tool) {
      const parsed = parseMessage({
        version: PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        kind: "request",
        type,
        payload: { tool },
      });
      if (!parsed.ok) throw new Error("Invalid setup request");
      send(parsed.message);
    },
    receive(input) {
      const parsed = parseMessage(input);
      if (!parsed.ok) throw new Error("Invalid host message");
      const message = parsed.message;
      if (message.type === "view.snapshot") {
        const payload = message.payload;
        const last = get().snapshot;
        if (!last || payload.cursor > last.cursor) {
          set({ snapshot: { cursor: payload.cursor, body: payload } });
        }
        return;
      }
      if (message.type === "sweep.status") set({ sweep: message.payload });
      if (message.type === "setup.state") set({ setup: message.payload });
      if (message.type === "setup.signin.progress") {
        const progress = message.payload;
        const previous = get().signin[progress.tool];
        const signin = { ...get().signin };
        const signinOutcome = { ...get().signinOutcome };
        if (progress.state === "completed" || progress.state === "failed") {
          delete signin[progress.tool];
          signinOutcome[progress.tool] = progress;
        } else {
          delete signinOutcome[progress.tool];
          if (progress.state !== "waiting" || previous?.state !== "device-code") {
            signin[progress.tool] = progress;
          }
        }
        set({ signin, signinOutcome });
      }
      if (message.type === "host.hello") {
        set({ signin: {}, signinOutcome: {} });
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
  inspector.subscribe(({ selected }) => {
    if (store.getState().selection?.id !== (selected ?? undefined))
      store.setState({ selection: selectionOf(selected) });
  });
  return store;
}

export const watchStore = createWatchStore(
  (message) => window.spi.postMessage(message),
  selectionStore,
);
