// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type Envelope,
  type LastSweep,
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  type SetupSigninProgress,
  type SetupState,
  type SweepProgress,
  type SweepStatus,
  type ViewSnapshot,
  type WatchMessage,
} from "@spi-code/contracts";
import { createStore } from "zustand/vanilla";
import { createSelectionStore, type SelectionStore, selectionStore } from "../panels/selection.js";

export type Snapshot = { cursor: number; body: ViewSnapshot };
type SweepRequest = {
  id: string;
  sweep: string | null;
  previousSweep: string | null;
  afterCursor: number;
  joined: boolean;
};
type WatchState = {
  snapshot: Snapshot | null;
  readonly selection: { readonly id: string } | null;
  select(id: string): void;
  clear(): void;
  sweep: SweepStatus | null;
  /** The latest sweep.progress, whole; never persisted. */
  progress: SweepProgress | null;
  /** The last sweep that committed, kept with each source's final state after hand-over. */
  completed: SweepProgress | null;
  /** Asks the host for a sweep through its non-forced path. */
  requestSweep(): void | Promise<void>;
  sweepRequest: SweepRequest | null;
  sweepRequestError: string | null;
  /** Requests all sources; follows a joined sweep without queuing a forced follow-up. */
  requestSweepNow(): void | Promise<void>;
  setup: SetupState | null;
  /** A recheck stays pending through the budget probe, until its correlated state or error. */
  setupCheckRequest: string | null;
  setupCheckError: string | null;
  signin: Partial<Record<SetupSigninProgress["tool"], SetupSigninProgress>>;
  signinOutcome: Partial<Record<SetupSigninProgress["tool"], SetupSigninProgress>>;
  /** Bumps when the host reconnects or gives up, invalidating views' connection-bound state. */
  epoch: number;
  /**
   * The setup.signin request each row waits on. Progress for any other request is dropped, and a
   * tool with a pending request sends no other until that request ends or the host reconnects.
   */
  signinRequest: Partial<Record<SetupSigninProgress["tool"], string>>;
  requestSetup(
    ...request:
      | [type: "setup.check", tool?: never, token?: never]
      | [type: "setup.signin.cancel", requestId: string, token?: never]
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

/** A committed snapshot is from this sweep or a later read, not an earlier retained brief. */
export function hasSweepSnapshot(snapshot: Snapshot | null, sweep: LastSweep): boolean {
  if (!snapshot) return false;
  const at = Date.parse(snapshot.body.sweptAt);
  return at >= Date.parse(sweep.startedAt);
}

function trackSweepRequest(state: WatchState): SweepRequest | null {
  let request = state.sweepRequest;
  if (!request) return null;
  const progress = state.progress;
  const last = state.sweep?.lastSweep;
  if (request.sweep === null) {
    const sweep =
      progress && progress.sweep !== request.previousSweep
        ? progress.sweep
        : last?.requested && last.sweep !== request.previousSweep
          ? last.sweep
          : null;
    request = { ...request, sweep };
  }
  if (
    last &&
    last.sweep === request.sweep &&
    progress?.sweep === request.sweep &&
    progress.outcome === last.outcome &&
    (!last.requested ||
      last.outcome !== "committed" ||
      (state.snapshot !== null &&
        (state.snapshot.cursor > request.afterCursor || request.joined) &&
        hasSweepSnapshot(state.snapshot, last)))
  ) {
    return null;
  }
  return request;
}

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
    progress: null,
    completed: null,
    sweepRequest: null,
    sweepRequestError: null,
    requestSweep() {
      const parsed = parseMessage({
        version: PROTOCOL_VERSION,
        id: crypto.randomUUID(),
        kind: "request",
        type: "sweep.request",
        payload: {},
      });
      if (!parsed.ok) throw new Error("Invalid sweep request");
      return send(parsed.message);
    },
    requestSweepNow() {
      if (get().sweepRequest !== null) return;
      const state = get();
      const id = crypto.randomUUID();
      const parsed = parseMessage({
        version: PROTOCOL_VERSION,
        id,
        kind: "request",
        type: "sweep.request",
        payload: { now: true },
      });
      if (!parsed.ok) throw new Error("Invalid sweep request");
      set({
        sweepRequest: {
          id,
          sweep: state.progress?.outcome === "running" ? state.progress.sweep : null,
          previousSweep: state.progress?.sweep ?? state.sweep?.lastSweep?.sweep ?? null,
          afterCursor: state.snapshot?.cursor ?? -1,
          joined: state.progress?.outcome === "running",
        },
        sweepRequestError: null,
      });
      const failed = (error: unknown): never => {
        if (get().sweepRequest?.id === id)
          set({
            sweepRequest: null,
            sweepRequestError: "Could not send the sweep request. Try again.",
          });
        throw error;
      };
      try {
        const sent = send(parsed.message);
        if (sent) return sent.catch(failed);
      } catch (error) {
        failed(error);
      }
    },
    setup: null,
    setupCheckRequest: null,
    setupCheckError: null,
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
        payload:
          type === "setup.check"
            ? {}
            : type === "setup.signin.cancel"
              ? { requestId: tool }
              : token === undefined
                ? { tool }
                : { tool, token },
      });
      if (!parsed.ok) throw new Error("Invalid setup request");
      if (type === "setup.check") {
        if (get().setupCheckRequest !== null) return;
        set({ setupCheckRequest: id, setupCheckError: null });
      }
      if (type === "setup.signin") {
        // One pending sign-in per tool: a second request would replace the id the host's flow reports.
        if (get().signinRequest[tool] !== undefined) return;
        set({ signinRequest: { ...get().signinRequest, [tool]: id } });
      }
      const failed = (error: unknown): never => {
        if (type === "setup.check" && get().setupCheckRequest === id)
          set({
            setupCheckRequest: null,
            setupCheckError: "Could not send the request to SPI Code.",
          });
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
      if (message.type === "error" && message.payload.code === "host_unavailable") {
        set({
          sweep: null,
          progress: null,
          sweepRequest: null,
          sweepRequestError: null,
          setupCheckRequest: null,
          setupCheckError: message.payload.message,
          signin: {},
          signinOutcome: {},
          signinRequest: {},
          epoch: get().epoch + 1,
        });
        throw new Error(message.payload.message);
      }
      if (message.type === "error" && message.id === get().sweepRequest?.id)
        set({
          sweepRequest: null,
          sweepRequestError: "Could not request a sweep. Try again.",
        });
      if (message.type === "error" && message.id === get().setupCheckRequest)
        set({
          setupCheckRequest: null,
          setupCheckError: "Could not check Watch tools. Try again.",
        });
      if (message.type === "view.snapshot") {
        const payload = message.payload;
        const last = get().snapshot;
        if (!last || payload.cursor > last.cursor) {
          updateSweep({ snapshot: { cursor: payload.cursor, body: payload } });
        }
        return;
      }
      if (message.type === "sweep.status") updateSweep({ sweep: message.payload });
      if (message.type === "sweep.progress") {
        const progress = message.payload;
        updateSweep(
          progress.outcome === "committed" ? { progress, completed: progress } : { progress },
        );
      }
      if (message.type === "setup.state") {
        const checked = message.id === get().setupCheckRequest;
        set({
          setup: message.payload,
          ...(checked ? { setupCheckRequest: null } : {}),
        });
      }
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
        set({
          sweep: null,
          progress: null,
          sweepRequest: null,
          sweepRequestError: null,
          signin: {},
          signinOutcome: {},
          signinRequest: {},
          setupCheckRequest: null,
          setupCheckError: null,
          epoch: get().epoch + 1,
        });
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
  function updateSweep(update: Partial<WatchState>) {
    store.setState((state) => {
      const next = { ...state, ...update };
      return { ...update, sweepRequest: trackSweepRequest(next) };
    });
  }
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
