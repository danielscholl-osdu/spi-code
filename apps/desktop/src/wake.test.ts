// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import {
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { readGenerated } from "../../../scripts/watch-generated.mjs";
import { trayChannel } from "./tray.js";
import { WAKE_DELAY_MS, wakeSweep } from "./wake.js";

const MINUTE = 60_000;
const START = new Date(2026, 10, 9, 8, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

function status(sweepMs: number, endedAt: number | null): Message {
  return {
    version: PROTOCOL_VERSION,
    id: "status",
    kind: "event",
    type: "sweep.status",
    payload: {
      remaining: null,
      resetAt: null,
      deferredAreas: [],
      nextSweepAt: null,
      schedule: {
        sweepMs,
        gitlabMs: 30 * MINUTE,
        securityMs: 30 * MINUTE,
        releasesMs: 60 * MINUTE,
      },
      lastSweep:
        endedAt === null
          ? null
          : {
              sweep: "s1",
              startedAt: iso(endedAt - MINUTE),
              endedAt: iso(endedAt),
              outcome: "committed",
              requested: false,
            },
    },
  };
}

function snapshot(sweptAt: number): Message {
  const fixture = ViewSnapshotSchema.parse(JSON.parse(readGenerated("snapshot-59d6895.json")));
  return {
    version: PROTOCOL_VERSION,
    id: "snapshot",
    kind: "event",
    type: "view.snapshot",
    payload: { ...fixture, sweptAt: iso(sweptAt) },
  };
}

function setup(watchReady: boolean): Message {
  return {
    version: PROTOCOL_VERSION,
    id: "setup",
    kind: "event",
    type: "setup.state",
    payload: {
      tools: [{ tool: "gh", state: watchReady ? "ready" : "signed-out", action: null }],
      watchReady,
      disabledReason: watchReady ? null : "GitHub CLI is not ready.",
    },
  } as Message;
}

function wake() {
  const power = new EventEmitter();
  const request = vi.fn((_message: Message) => true);
  const sweep = wakeSweep(power, request);
  return { power, request, sweep };
}

it("asks for one non-forced sweep 15 s after resume when the last sweep is older than the interval", () => {
  const { power, request, sweep } = wake();
  sweep.observe(status(5 * MINUTE, START - 20 * MINUTE));
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS - 1);
  expect(request).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(request).toHaveBeenCalledOnce();
  const message = request.mock.calls[0]?.[0];
  expect(parseMessage(message).ok).toBe(true);
  expect(message).toMatchObject({ kind: "request", type: "sweep.request", payload: {} });
  expect(message?.payload).toEqual({});
  vi.advanceTimersByTime(60 * MINUTE);
  expect(request).toHaveBeenCalledOnce();
});

it("reads the interval from sweep.status rather than a fixed one", () => {
  const { power, request, sweep } = wake();
  sweep.observe(status(30 * MINUTE, START - 20 * MINUTE));
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).not.toHaveBeenCalled();
  sweep.observe(status(10 * MINUTE, START - 20 * MINUTE));
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).toHaveBeenCalledOnce();
});

it("does not ask when the last sweep or the snapshot is recent", () => {
  const { power, request, sweep } = wake();
  sweep.observe(status(5 * MINUTE, START - 2 * MINUTE));
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).not.toHaveBeenCalled();
  sweep.observe(status(5 * MINUTE, null));
  sweep.observe(snapshot(START - MINUTE));
  power.emit("unlock-screen");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).not.toHaveBeenCalled();
});

it("uses an old snapshot's sweptAt when this host run has not finished a sweep", () => {
  const { power, request, sweep } = wake();
  sweep.observe(snapshot(START - 2 * 60 * MINUTE));
  sweep.observe(status(5 * MINUTE, null));
  power.emit("unlock-screen");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).toHaveBeenCalledOnce();
});

it("decides when the timer fires, so a sweep that lands within the 15 s is not repeated", () => {
  const { power, request, sweep } = wake();
  sweep.observe(status(5 * MINUTE, START - 20 * MINUTE));
  power.emit("resume");
  vi.advanceTimersByTime(5000);
  sweep.observe(status(5 * MINUTE, Date.now()));
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).not.toHaveBeenCalled();
});

it("does not ask before the interval and a last sweep are known: the first sweep is running", () => {
  const { power, request, sweep } = wake();
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  sweep.observe(status(5 * MINUTE, null));
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).not.toHaveBeenCalled();
});

it("fires once for resume then unlock within 15 s, and a second wake does not stack", () => {
  const { power, request, sweep } = wake();
  sweep.observe(status(5 * MINUTE, START - 20 * MINUTE));
  power.emit("resume");
  vi.advanceTimersByTime(10_000);
  power.emit("unlock-screen");
  power.emit("resume");
  vi.advanceTimersByTime(5000);
  expect(request).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(WAKE_DELAY_MS * 4);
  expect(request).toHaveBeenCalledOnce();
});

it("clears the pending timer on suspend and on dispose", () => {
  const { power, request, sweep } = wake();
  sweep.observe(status(5 * MINUTE, START - 20 * MINUTE));
  power.emit("resume");
  power.emit("suspend");
  expect(sweep.pending()).toBe(false);
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).not.toHaveBeenCalled();
  power.emit("unlock-screen");
  sweep.dispose();
  expect(sweep.pending()).toBe(false);
  expect(power.listenerCount("resume")).toBe(0);
  expect(power.listenerCount("unlock-screen")).toBe(0);
  expect(power.listenerCount("suspend")).toBe(0);
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).not.toHaveBeenCalled();
});

it("holds back while Watch is not ready, like the tray's Sweep now", () => {
  const { power, request, sweep } = wake();
  sweep.observe(status(5 * MINUTE, START - 20 * MINUTE));
  sweep.observe(setup(false));
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).not.toHaveBeenCalled();
  sweep.observe(setup(true));
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).toHaveBeenCalledOnce();
});

it("ignores invalid host messages", () => {
  const { power, request, sweep } = wake();
  sweep.observe({ type: "sweep.status", payload: { schedule: { sweepMs: 1 }, lastSweep: null } });
  sweep.observe(snapshot(START - 60 * MINUTE));
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(request).not.toHaveBeenCalled();
});

class FakePort extends EventEmitter {
  posted: unknown[] = [];
  postMessage(data: unknown) {
    this.posted.push(data);
  }
  start() {}
  close() {}
  override on(event: "message", listener: (event: { data: unknown; ports: FakePort[] }) => void) {
    return super.on(event, listener);
  }
}

it("posts through the tray's validated relay to the host port", () => {
  const power = new EventEmitter();
  const ports: FakePort[] = [];
  let sweep: ReturnType<typeof wakeSweep> | undefined;
  const relay = trayChannel(
    () => {
      const pair = { port1: new FakePort(), port2: new FakePort() };
      ports.push(pair.port1, pair.port2);
      return pair;
    },
    (message) => sweep?.observe(message),
  );
  sweep = wakeSweep(power, (message) => relay.request(message));
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  relay.connect();
  const host = ports[2];
  host?.emit("message", { data: status(5 * MINUTE, START - 20 * MINUTE), ports: [] });
  power.emit("resume");
  vi.advanceTimersByTime(WAKE_DELAY_MS);
  expect(host?.posted).toHaveLength(1);
  expect(host?.posted[0]).toMatchObject({ type: "sweep.request", payload: {} });
  relay.dispose();
  sweep.dispose();
});
