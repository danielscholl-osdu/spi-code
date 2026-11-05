// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot, WatchMessageSchema } from "@spi-code/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { Shell } from "../app/Shell.js";
import { createSelectionStore } from "../panels/selection.js";
import { testSnapshot as snapshotFromOracles } from "./test-snapshot.js";
import { createWatchStore, selectAreaEnvelopes, selectEnvelopes, watchStore } from "./watch.js";

const testSnapshot = (overrides: Partial<ViewSnapshot> = {}) =>
  snapshotFromOracles(briefing, releases, overrides);

const event = (type: string, payload: unknown) => ({
  version: PROTOCOL_VERSION,
  id: "host",
  kind: "event",
  type,
  payload,
});

it("selects every snapshot area's envelope and none before the first snapshot", () => {
  const store = createWatchStore(vi.fn());
  expect(selectAreaEnvelopes(store.getState())).toEqual([]);
  expect(selectEnvelopes(store.getState())).toEqual([]);
  const body = testSnapshot();
  store.getState().receive(event("view.snapshot", body));
  expect(selectAreaEnvelopes(store.getState())).toEqual(body.areas.map(({ envelope }) => envelope));
  expect(selectEnvelopes(store.getState())).toEqual(selectAreaEnvelopes(store.getState()));
});

it("selects supplemental envelopes alongside every area without inventing absent evidence", () => {
  const store = createWatchStore(vi.fn());
  const envelope = {
    source: "releases",
    state: "failed",
    completeness: { kind: "complete" },
  } as const;
  const body = testSnapshot({
    provenance: [
      { path: "/releases", areas: ["fleet"], envelope },
      { path: "/briefing", areas: ["github"] },
    ],
  });
  store.getState().receive(event("view.snapshot", body));
  expect(selectEnvelopes(store.getState())).toEqual([
    ...selectAreaEnvelopes(store.getState()),
    envelope,
  ]);
});

it("rejects git sign-in at the type and runtime boundaries", () => {
  const send = vi.fn();
  const store = createWatchStore(send);
  expect(() => {
    // @ts-expect-error git is installable but has no sign-in flow.
    store.getState().requestSetup("setup.signin", "git");
  }).toThrow("Invalid setup request");
  expect(send).not.toHaveBeenCalled();
});

it("keeps the newest full snapshot and ignores late and duplicate cursors", () => {
  const store = createWatchStore(vi.fn());
  const body = testSnapshot({ cursor: 9 });
  for (const payload of [testSnapshot({ cursor: 3 }), body]) {
    store.getState().receive(event("view.snapshot", payload));
  }
  expect(store.getState().snapshot).toEqual({ cursor: 9, body });
  const state = store.getState();
  const changed = vi.fn();
  store.subscribe(changed);
  for (const cursor of [4, 9]) {
    store.getState().receive(event("view.snapshot", testSnapshot({ cursor, tree: [] })));
  }
  expect(store.getState()).toBe(state);
  expect(changed).not.toHaveBeenCalled();
});

it.each([
  ["Briefing", (body: ReturnType<typeof testSnapshot>) => ({ ...body, briefing: {} })],
  [
    "read",
    (body: ReturnType<typeof testSnapshot>) => ({
      ...body,
      reads: [{ ...body.reads[0], observedAt: "not-a-date" }],
    }),
  ],
  [
    "station",
    (body: ReturnType<typeof testSnapshot>) => ({
      ...body,
      stations: [{ service: "legal", stations: [{ id: "upstream", state: "green", text: "" }] }],
    }),
  ],
])("rejects a malformed %s before any store mutation, even at a stale cursor", (_name, corrupt) => {
  const send = vi.fn();
  const store = createWatchStore(send);
  store.getState().receive(event("view.snapshot", testSnapshot({ cursor: 9 })));
  store.getState().select("halt:legal");
  send.mockClear();
  const state = store.getState();
  const changed = vi.fn();
  store.subscribe(changed);
  for (const cursor of [10, 8]) {
    expect(() =>
      store.getState().receive(event("view.snapshot", corrupt(testSnapshot({ cursor })))),
    ).toThrow("Invalid host message");
    expect(store.getState()).toBe(state);
  }
  expect(changed).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("sets, retains a vanished selection across snapshots and reset, and clears explicitly", () => {
  const store = createWatchStore(vi.fn());
  expect(store.getState().selection).toBeNull();
  const body = testSnapshot();
  const id = body.briefing.focus[0]?.id;
  expect(id).toBeDefined();
  if (id === undefined) throw new Error("Oracle must contain a focus item");
  store.getState().receive(event("view.snapshot", body));
  store.getState().select(id);
  expect(store.getState().selection).toEqual({ id });
  store.getState().receive(
    event(
      "view.snapshot",
      testSnapshot({
        cursor: 2,
        briefing: { ...body.briefing, focus: [], rest: [] },
        selection: "today",
      }),
    ),
  );
  expect(store.getState().selection).toEqual({ id });
  store.getState().receive(event("host.hello", { pid: 456 }));
  expect(store.getState().selection).toEqual({ id });
  store.getState().select("rollout");
  expect(store.getState().selection).toEqual({ id: "rollout" });
  store.getState().clear();
  expect(store.getState().selection).toBeNull();
  expect(store.getState().snapshot?.cursor).toBe(2);
});

it("forwards select and clear to the inspector selection, its one source", () => {
  const postMessage = vi.fn();
  const inspector = createSelectionStore({ postMessage });
  inspector.getState().select("halt:legal");
  const store = createWatchStore(vi.fn(), inspector);
  expect(store.getState().selection).toEqual({ id: "halt:legal" });
  store.getState().select("rollout");
  expect(inspector.getState().selected).toBe("rollout");
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "inspect.request", payload: { id: "rollout" } }),
  );
  inspector.getState().select("halt:entitlements");
  expect(store.getState().selection).toEqual({ id: "halt:entitlements" });
  store.getState().clear();
  expect(inspector.getState().selected).toBeNull();
  expect(store.getState().selection).toBeNull();
});

it("subscribes on every hello with zero initially and the last cursor after reset", () => {
  const send = vi.fn();
  const store = createWatchStore(send);
  store.getState().receive(event("host.hello", { pid: 123 }));
  store.getState().receive(event("view.snapshot", testSnapshot({ cursor: 0 })));
  store.getState().receive(event("view.snapshot", testSnapshot({ cursor: 12 })));
  store.getState().receive(event("host.hello", { pid: 456 }));
  expect(send.mock.calls.map(([message]) => WatchMessageSchema.parse(message).payload)).toEqual([
    { fromCursor: 0 },
    { fromCursor: 12 },
  ]);
  expect(send.mock.calls[0]?.[0].id).not.toBe(send.mock.calls[1]?.[0].id);
});

it("keeps the mounted snapshot across reconnect and shows the supervisor's schema-valid give-up error", async () => {
  const previous = window.spi;
  const previousState = watchStore.getState();
  const listeners = new Set<(message: unknown) => void>();
  const postMessage = vi.fn();
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage,
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  watchStore.setState({ snapshot: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const receive = async (message: unknown) =>
    act(async () => {
      for (const listener of listeners) listener(message);
    });
  try {
    await act(async () => root.render(createElement(Shell)));
    await receive(event("view.snapshot", testSnapshot({ cursor: 12 })));
    const mountedView = container.querySelector("main h1");
    expect(mountedView).not.toBeNull();
    await receive(event("host.hello", { pid: 456 }));
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "view.subscribe", payload: { fromCursor: 12 } }),
    );
    expect(watchStore.getState().snapshot?.cursor).toBe(12);
    expect(container.querySelector("main h1")).toBe(mountedView);
    await receive({
      version: PROTOCOL_VERSION,
      id: "host-supervisor",
      kind: "response",
      type: "error",
      payload: {
        code: "host_unavailable",
        message: "Host stopped after repeated crashes. Restart SPI Code to reconnect.",
      },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Host stopped after repeated crashes. Restart SPI Code to reconnect.",
    );
    expect(watchStore.getState().snapshot?.cursor).toBe(12);
    expect(container.querySelector("main h1")).toBe(mountedView);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    watchStore.setState(previousState);
    window.spi = previous;
  }
});

it("keeps the latest cursorless sweep and setup states independently of snapshots", () => {
  const store = createWatchStore(vi.fn());
  const sweep = { remaining: 500, resetAt: null, deferredAreas: [] };
  const setup = { tools: [], watchReady: false, disabledReason: "Install git" };
  store.getState().receive(event("sweep.status", { ...sweep, remaining: 1000 }));
  store
    .getState()
    .receive(event("setup.state", { ...setup, watchReady: true, disabledReason: null }));
  store.getState().receive(event("view.snapshot", testSnapshot({ cursor: 9 })));
  store.getState().receive(event("sweep.status", sweep));
  store.getState().receive(event("setup.state", setup));
  store.getState().receive(event("view.snapshot", testSnapshot({ cursor: 1 })));
  expect(store.getState()).toMatchObject({ sweep, setup, snapshot: { cursor: 9 } });
  expect(() => store.getState().receive(event("sweep.status", {}))).toThrow("Invalid host");
  expect(() => store.getState().receive(event("view.snapshot", { cursor: -1 }))).toThrow(
    "Invalid host",
  );
});
