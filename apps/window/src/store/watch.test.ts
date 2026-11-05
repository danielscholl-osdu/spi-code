// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, WatchMessageSchema } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import { createWatchStore } from "./watch.js";

const event = (type: string, payload: unknown) => ({
  version: PROTOCOL_VERSION,
  id: "host",
  kind: "event",
  type,
  payload,
});

it("keeps the newest cursor, ignores late and duplicate snapshots, and retains opaque data", () => {
  const store = createWatchStore(vi.fn());
  const body = { cursor: 9, briefing: { future: ["opaque"] } };
  for (const payload of [{ cursor: 3 }, body, { cursor: 4 }, { cursor: 9 }]) {
    store.getState().receive(event("view.snapshot", payload));
  }
  expect(store.getState().snapshot).toEqual({ cursor: 9, body });
  expect(store.getState().snapshot?.body).toBe(body);
});

it("subscribes on every hello with zero initially and the last cursor after reset", () => {
  const send = vi.fn();
  const store = createWatchStore(send);
  store.getState().receive(event("host.hello", { pid: 123 }));
  store.getState().receive(event("view.snapshot", { cursor: 0 }));
  store.getState().receive(event("view.snapshot", { cursor: 12 }));
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
  store.getState().receive(event("view.snapshot", { cursor: 9 }));
  store.getState().receive(event("sweep.status", sweep));
  store.getState().receive(event("setup.state", setup));
  store.getState().receive(event("view.snapshot", { cursor: 1 }));
  expect(store.getState()).toMatchObject({ sweep, setup, snapshot: { cursor: 9 } });
  expect(() => store.getState().receive(event("sweep.status", {}))).toThrow("Invalid host");
  expect(() => store.getState().receive(event("view.snapshot", { cursor: -1 }))).toThrow(
    "Invalid view",
  );
});
