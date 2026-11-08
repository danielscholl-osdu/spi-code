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
  /** Bumps on every host.hello, so views can drop state tied to the previous connection. */
  epoch: number;
  /**
   * The setup.signin request each row waits on. Progress for any other request is dropped, and a
   * tool with a pending request sends no other until that request ends or the host reconnects.
   */
  signinRequest: Partial<Record<SetupSigninProgress["tool"], string>>;
  requestSetup(
    ...request:
      | [type: "setup.check", tool?: never, token?: never]
      | [
          type: "setup.install",
          tool: Extract<WatchMessage, { type: "setup.install" }>["payload"]["tool"],
          token?: never,
        ]
      | [
          type: "setup.signin",
          tool: Exclude<Extract<WatchMessage, { type: "setup.signin" }>["payload"]["tool"], "glab">,
          token?: never,
        ]
      | [type: "setup.signin", tool: "glab", token: string]
  ): void | Promise<void>;
  receive(input: unknown): void;
};

const selectionOf = (selected: string | null) => (selected === null ? null : { id: selected });

export function selectAreaEnvelopes(state: Pick<WatchState, "snapshot">): Envelope[] {
  return state.snapshot?.body.areas.map(({ envelope }) => envelope) ?? [];
}

/** All evidence feeding the title bar, including collectors outside Facts areas. */
export function selectEnvelopes(state: Pick<WatchState, "snapshot">): Envelope[] {
  const body = state.snapshot?.body;
  return body
    ? [
        ...selectAreaEnvelopes(state),
        ...body.provenance.flatMap(({ envelope }) => (envelope ? [envelope] : [])),
      ]
    : [];
}

export function createWatchStore(
  send: (message: Message) => void | Promise<void>,
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
    epoch: 0,
    signinRequest: {},
    requestSetup(...request) {
      const [type, tool, token] = request;
      const id = crypto.randomUUID();
      const parsed = parseMessage({
        version: PROTOCOL_VERSION,
        id,
        kind: "request",
        type,
        payload: type === "setup.check" ? {} : token === undefined ? { tool } : { tool, token },
      });
      if (!parsed.ok) throw new Error("Invalid setup request");
      if (type === "setup.signin") {
        // One pending sign-in per tool: a second request would replace the id the host's flow reports.
        if (get().signinRequest[tool] !== undefined) return;
        set({ signinRequest: { ...get().signinRequest, [tool]: id } });
      }
      const failed = (error: unknown): never => {
        if (type === "setup.signin" && get().signinRequest[tool] === id) {
          const signinRequest = { ...get().signinRequest };
          delete signinRequest[tool];
          set({ signinRequest });
        }
        throw error;
      };
      try {
        const sent = send(parsed.message);
        if (sent) return sent.catch(failed);
      } catch (error) {
        failed(error);
      }
    },
    receive(input) {
      const parsed = parseMessage(input);
      if (!parsed.ok) throw new Error("Invalid host message");
      const message = parsed.message;
      if (message.type === "error" && message.payload.code === "host_unavailable")
        throw new Error(message.payload.message);
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
        if (progress.requestId !== get().signinRequest[progress.tool]) return;
        const previous = get().signin[progress.tool];
        const signin = { ...get().signin };
        const signinOutcome = { ...get().signinOutcome };
        if (progress.state === "completed" || progress.state === "failed") {
          const signinRequest = { ...get().signinRequest };
          delete signinRequest[progress.tool];
          delete signin[progress.tool];
          signinOutcome[progress.tool] = progress;
          set({ signin, signinOutcome, signinRequest });
          return;
        }
        delete signinOutcome[progress.tool];
        if (progress.state !== "waiting" || previous?.state !== "device-code") {
          signin[progress.tool] = progress;
        }
        set({ signin, signinOutcome });
      }
      if (message.type === "host.hello") {
        set({ signin: {}, signinOutcome: {}, signinRequest: {}, epoch: get().epoch + 1 });
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
