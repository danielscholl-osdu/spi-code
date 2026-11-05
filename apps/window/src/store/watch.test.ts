// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot, WatchMessageSchema } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { testSnapshot as snapshotFromOracles } from "./test-snapshot.js";
import { createWatchStore } from "./watch.js";

const testSnapshot = (overrides: Partial<ViewSnapshot> = {}) =>
  snapshotFromOracles(briefing, releases, overrides);

const event = (type: string, payload: unknown) => ({
  version: PROTOCOL_VERSION,
  id: "host",
  kind: "event",
  type,
  payload,
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
