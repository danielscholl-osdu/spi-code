// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  type Message,
  MessageSchema,
  PROTOCOL_VERSION,
  type SweepProgress,
  type SweepStatus,
  ViewSnapshotSchema,
  type WatchItem,
} from "@spi-code/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  supported: true,
  notifications: [] as (EventEmitter & {
    options: { title: string; body: string };
    show: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  })[],
}));
vi.mock("electron", () => ({
  Notification: class extends EventEmitter {
    static isSupported = () => native.supported;
    show = vi.fn();
    close = vi.fn(() => this.emit("close"));
    constructor(public options: { title: string; body: string }) {
      super();
      native.notifications.push(this);
    }
  },
}));

import { createInterruptNotifications } from "./interrupts.js";
import { interruptions, trayChannel } from "./tray.js";
import { showDestination } from "./window-navigation.js";

const fixture = ViewSnapshotSchema.parse(
  JSON.parse(
    readFileSync(new URL("../../../fixtures/watch/snapshot-1106.json", import.meta.url), "utf8"),
  ),
);
const seed = fixture.briefing.focus[0];
if (!seed) throw new Error("Recorded fixture has no item");
const item = (overrides: Partial<WatchItem> = {}): WatchItem => ({
  ...seed,
  id: "halt:partition",
  ids: [overrides.id ?? "halt:partition"],
  scope: "partition",
  title: "Upstream sync is stopped",
  rung: 1,
  attention: "interrupt",
  owned: false,
  ...overrides,
});
const event = (type: string, payload: unknown) =>
  MessageSchema.parse({ version: PROTOCOL_VERSION, id: type, kind: "event", type, payload });
const snapshot = (cursor: number, items: WatchItem[] = [], since = items.map(({ id }) => id)) =>
  event("view.snapshot", {
    ...structuredClone(fixture),
    cursor,
    sweptAt: new Date().toISOString(),
    seen: { cursor: 0, since },
    briefing: { ...fixture.briefing, focus: items, rest: [] },
    provenance: [],
  });
const progress = (overrides: Partial<SweepProgress> = {}) =>
  event("sweep.progress", {
    sweep: "sweep",
    startedAt: new Date().toISOString(),
    first: false,
    usualMs: null,
    sources: [],
    outcome: "running",
    nextAttemptAt: null,
    ...overrides,
  });
const status = (overrides: Partial<SweepStatus> = {}) =>
  event("sweep.status", {
    remaining: 500,
    resetAt: null,
    deferredAreas: [],
    nextSweepAt: null,
    schedule: { sweepMs: 300000, gitlabMs: 1800000, securityMs: 1800000, releasesMs: 3600000 },
    lastSweep: null,
    ...overrides,
  });
const acknowledge = (cursor: number): Message => ({
  version: PROTOCOL_VERSION,
  id: `ack-${cursor}`,
  kind: "request",
  type: "view.acknowledge",
  payload: { cursor },
});
const opened: ReturnType<typeof createInterruptNotifications>[] = [];
function setup(focused = false) {
  const isFocused = vi.fn(() => focused);
  const open = vi.fn();
  const notifications = createInterruptNotifications({ focused: isFocused, open });
  opened.push(notifications);
  return { ...notifications, open, isFocused };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T14:00:00Z"));
  native.notifications.length = 0;
  native.supported = true;
});
afterEach(() => {
  for (const controller of opened.splice(0)) controller.dispose();
  vi.useRealTimers();
});

it("notifies one new Interrupt using its snapshot scope, rung and title", () => {
  const notifications = setup();
  notifications.observe(snapshot(1));
  vi.advanceTimersByTime(300000);
  notifications.observe(snapshot(2, [item({ rung: 0 })]));
  expect(native.notifications.map(({ options }) => options)).toEqual([
    { title: "Needs you · partition", body: "P0 Upstream sync is stopped" },
  ]);
  expect(native.notifications[0]?.show).toHaveBeenCalledOnce();
});

it("coalesces focus and rest into one banner per committed sweep with the first two titles", () => {
  const notifications = setup();
  notifications.observe(snapshot(1));
  const message = snapshot(2, [
    item(),
    item({ id: "main:legal", title: "Legal main is red" }),
    item({ id: "main:storage", title: "Storage main is red" }),
  ]);
  if (message.type !== "view.snapshot") throw new Error("Expected snapshot");
  message.payload.briefing.rest = message.payload.briefing.focus.splice(1);
  notifications.observe(message);
  notifications.observe(message);
  notifications.observe(progress({ outcome: "committed" }));
  expect(native.notifications.map(({ options }) => options)).toEqual([
    { title: "3 things need you", body: "Upstream sync is stopped; Legal main is red" },
  ]);
});

it("dedupes the same id and rung across sweeps and reconnect replay, but not a worsened rung", () => {
  const notifications = setup();
  notifications.observe(snapshot(1, [item({ rung: 1 })]));
  vi.advanceTimersByTime(300000);
  notifications.observe(snapshot(2, [item({ rung: 1, title: "Changed title" })]));
  notifications.observe(snapshot(1, [item({ rung: 0 })]));
  expect(native.notifications).toHaveLength(1);
  notifications.observe(snapshot(3, [item({ rung: 0 })]));
  expect(native.notifications).toHaveLength(2);
  expect(native.notifications[1]?.options.body).toBe("P0 Upstream sync is stopped");
  notifications.observe(snapshot(4, [item({ rung: 2 })]));
  notifications.observe(snapshot(5, [item({ rung: 0 })]));
  expect(native.notifications).toHaveLength(2);
});

it("skips a focused window; a later unfocused sweep can notify an item never notified or acknowledged", () => {
  const notifications = setup(true);
  notifications.observe(snapshot(1, [item()]));
  expect(native.notifications).toHaveLength(0);
  notifications.isFocused.mockReturnValue(false);
  vi.advanceTimersByTime(300000);
  notifications.observe(snapshot(2, [item()]));
  expect(native.notifications).toHaveLength(1);
  notifications.observe(snapshot(3, [item()]));
  expect(native.notifications).toHaveLength(1);
});

it("notifies a visible but unfocused window: visibility is not the focus rule", () => {
  const window = { isVisible: () => true, isFocused: () => false };
  const notifications = createInterruptNotifications({ focused: window.isFocused, open: vi.fn() });
  opened.push(notifications);
  expect(window.isVisible()).toBe(true);
  notifications.observe(snapshot(1, [item()]));
  expect(native.notifications).toHaveLength(1);
});

it("summarizes only unacknowledged Interrupts on the first snapshot of each run, once", () => {
  const unacknowledged = item();
  const acknowledged = item({ id: "main:legal" });
  const message = snapshot(
    10,
    [unacknowledged, acknowledged, item({ id: "surface", attention: "surface" })],
    [unacknowledged.id, "surface"],
  );
  const first = setup();
  first.observe(message);
  first.observe(message);
  first.observe(snapshot(11, [unacknowledged]));
  expect(native.notifications).toHaveLength(1);
  first.dispose();
  vi.advanceTimersByTime(86400000);
  const relaunched = setup();
  relaunched.observe(message);
  relaunched.observe(message);
  expect(native.notifications).toHaveLength(2);
  const quiet = setup();
  quiet.observe(snapshot(12, [acknowledged], []));
  quiet.observe(snapshot(13, [acknowledged], []));
  expect(native.notifications).toHaveLength(2);
});

it("leaves the first sweep's Today is ready hand-over to the existing tray", () => {
  const notifications = setup();
  notifications.observe(progress({ first: true }));
  notifications.observe(snapshot(1, [item()]));
  notifications.observe(progress({ first: true, outcome: "committed" }));
  expect(native.notifications).toHaveLength(0);
  notifications.observe(snapshot(2, [item(), item({ id: "main:legal" })], ["main:legal"]));
  expect(native.notifications).toHaveLength(1);
  expect(native.notifications[0]?.options.title).toBe("Needs you · partition");
});

it("observes outgoing acknowledgement on the real relay, closing covered banners without changing Today's count", () => {
  class Port extends EventEmitter {
    postMessage = vi.fn();
    start = vi.fn();
    close = vi.fn();
  }
  const channels: { port1: Port; port2: Port }[] = [];
  const notifications = setup();
  const relay = trayChannel(
    () => {
      const channel = { port1: new Port(), port2: new Port() };
      channels.push(channel);
      return channel;
    },
    notifications.observe,
    notifications.outgoing,
  );
  relay.connect();
  const first = snapshot(1, [item()]);
  const second = snapshot(2, [item(), item({ id: "main:legal" })]);
  const before = structuredClone(second);
  try {
    for (const message of [first, second])
      channels[1]?.port1.emit("message", { data: message, ports: [] });
    channels[0]?.port2.emit("message", { data: acknowledge(1000), ports: [] });
    expect(native.notifications[0]?.close).not.toHaveBeenCalled();
    expect(native.notifications[1]?.close).not.toHaveBeenCalled();
    channels[0]?.port2.emit("message", { data: acknowledge(1), ports: [] });
    expect(channels[1]?.port1.postMessage).toHaveBeenCalledWith(acknowledge(1), []);
    expect(native.notifications[0]?.close).toHaveBeenCalledOnce();
    expect(native.notifications[1]?.close).not.toHaveBeenCalled();
    channels[0]?.port2.emit("message", { data: acknowledge(2), ports: [] });
    expect(native.notifications[1]?.close).toHaveBeenCalledOnce();
    expect(second).toEqual(before);
    if (second.type !== "view.snapshot") throw new Error("Expected snapshot");
    expect(interruptions(second.payload.briefing)).toBe(2);
    notifications.observe(snapshot(3, [item(), item({ id: "main:legal" })], []));
    expect(native.notifications).toHaveLength(2);
  } finally {
    relay.dispose();
  }
});

it("releases a clicked handle without closing it again on acknowledgement, OS close or dispose", () => {
  const notifications = setup();
  notifications.observe(snapshot(1, [item()]));
  notifications.observe(snapshot(2, [item({ id: "main:legal" })]));
  native.notifications[0]?.emit("click");
  expect(notifications.open).toHaveBeenCalledExactlyOnceWith({
    to: "today",
    item: "halt:partition",
  });
  notifications.outgoing(acknowledge(2));
  notifications.dispose();
  expect(native.notifications[0]?.close).not.toHaveBeenCalled();
  expect(native.notifications[1]?.close).toHaveBeenCalledOnce();
  native.notifications[0]?.emit("close");
  notifications.outgoing(acknowledge(2));
  notifications.dispose();
  expect(native.notifications[0]?.close).not.toHaveBeenCalled();
  expect(native.notifications[1]?.close).toHaveBeenCalledOnce();
});

it("clicks through showDestination and the real preload's validated Today route", () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => void>();
  const navigated = vi.fn();
  runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (
          _name: string,
          bridge: { onNavigate(listener: typeof navigated): void },
        ) => bridge.onNavigate(navigated),
      },
      ipcRenderer: {
        on: (channel: string, handler: (event: unknown, input: unknown) => void) =>
          handlers.set(channel, handler),
      },
    }),
    process: { argv: [] },
  });
  const show = vi.fn();
  const notifications = createInterruptNotifications({
    focused: () => false,
    open: (destination) =>
      showDestination(
        show,
        {
          isDestroyed: () => false,
          send: (channel, input) => handlers.get(channel)?.({}, input),
        },
        destination,
      ),
  });
  opened.push(notifications);
  notifications.observe(snapshot(1, [item()]));
  native.notifications[0]?.emit("click");
  expect(show).toHaveBeenCalledOnce();
  expect(navigated).toHaveBeenCalledExactlyOnceWith({ to: "today", item: "halt:partition" });
});

const now = "2026-11-09T14:00:00Z";
it.each([
  ["routine sweep starting", () => progress()],
  ["routine sweep finishing", () => progress({ outcome: "committed" })],
  [
    "Sweep now finishing",
    () =>
      status({
        lastSweep: {
          sweep: "forced",
          startedAt: now,
          endedAt: now,
          outcome: "committed",
          requested: true,
        },
      }),
  ],
  ["Surface item", () => snapshot(2, [item({ attention: "surface", rung: 0 })])],
  ["Ambient item", () => snapshot(2, [item({ attention: "ambient", rung: 0 })])],
  [
    "cut source",
    () =>
      progress({
        sources: [
          {
            source: "security",
            state: "cut",
            startedAt: now,
            endedAt: now,
            incomplete: { count: 1, total: 2 },
          },
        ],
      }),
  ],
  [
    "put-off source",
    () =>
      progress({
        sources: [{ source: "security", state: "deferred", code: "budget", reason: "fixture" }],
      }),
  ],
  [
    "throttled source",
    () =>
      progress({
        sources: [
          {
            source: "security",
            state: "throttled",
            startedAt: now,
            resumeAt: now,
            code: "budget",
            reason: "fixture",
          },
        ],
      }),
  ],
  [
    "single failed sweep",
    () => progress({ outcome: "failed", code: "save", failure: "fixture", nextAttemptAt: null }),
  ],
  [
    "budget changes",
    () => status({ remaining: 0, deferredAreas: [{ area: "security", reason: "budget" }] }),
  ],
  [
    "upstream fork sync",
    () => {
      const message = snapshot(2);
      if (message.type === "view.snapshot") message.payload.briefing.nextSyncAt = now;
      return message;
    },
  ],
  [
    "glab never signed in",
    () =>
      event("setup.state", {
        watchReady: true,
        disabledReason: null,
        tools: [
          { tool: "gh", state: "ready", action: null },
          { tool: "glab", state: "signed-out", action: "signin" },
        ],
      }),
  ],
  ["same item twice at the same rung", () => snapshot(2, [item()])],
] as const)("keeps %s silent", (_name, message) => {
  const notifications = setup();
  notifications.observe(snapshot(1, [item()]));
  const count = native.notifications.length;
  vi.advanceTimersByTime(300000);
  notifications.observe(message());
  expect(native.notifications).toHaveLength(count);
});

it("uses only bounded, single-line item titles, redacting tokens and paths, never diagnostics", () => {
  const notifications = setup();
  notifications.observe(
    snapshot(1, [
      item({
        title:
          "Blocked ghp_fixtureSecret /Users/operator/private.txt C:\\private\\file TOKEN=fixture-secret Authorization: Bearer fixture-secret\ncommand output",
        scope: "partition /private/path",
        sub: "Never display diagnostic output",
        cause: "Never display command output",
      }),
    ]),
  );
  const options = native.notifications[0]?.options;
  expect(options?.body).toBe("P1 Blocked [redacted] [redacted] [redacted] [redacted] [redacted]");
  expect(options?.title).toBe("Needs you · partition [redacted]");
  notifications.observe(
    snapshot(2, [item({ id: "long", title: "A".repeat(20).concat(" ").repeat(30) })]),
  );
  expect(native.notifications[1]?.options.body.length).toBeLessThanOrEqual(163);
  expect(native.notifications[1]?.options.body.endsWith("...")).toBe(true);
  notifications.observe(snapshot(3, [item({ id: "output", title: "$ gh api commands" })]));
  expect(native.notifications[2]?.options.body).toBe("P1 [redacted]");
});

it.each([
  ["scoped package", "Bump @types/node from 1.2 to 1.3", "Bump @types/node from 1.2 to 1.3"],
  ["repository reference", "Blocked owner/repo#12", "Blocked owner/repo#12"],
  ["relative path", "Changed packages/core/src/index.ts", "Changed packages/core/src/index.ts"],
  ["tab", "tab\tand", "tab and"],
  ["standalone slash", "Node 22.x / pnpm 10", "Node 22.x / pnpm 10"],
  ["HTTPS prefix", "Read https://example.test/private", "Read https:[redacted]"],
  ["absolute path", "Blocked /opt/spi/file", "Blocked [redacted]"],
  ["quoted absolute path", 'Blocked "/opt/spi/file"', "Blocked [redacted]"],
  ["Linux home", "Blocked /home/operator/private", "Blocked [redacted]"],
  ["macOS home", "Blocked /Users/operator/private", "Blocked [redacted]"],
  ["tilde home", "Blocked ~/private", "Blocked [redacted]"],
  ["named home", "Blocked ~operator/private", "Blocked [redacted]"],
  ["Windows home", "Blocked C:\\Users\\operator\\private", "Blocked [redacted]"],
  ["AWS key", "Blocked AKIA1234567890ABCDEF", "Blocked [redacted]"],
  ["API key header", "Blocked x-api-key: fixture-value", "Blocked [redacted]"],
  ["Unicode line separator", "A title\u2028command output", "A title"],
  ["Unicode paragraph separator", "A title\u2029command output", "A title"],
  ["Unicode next line", "A title\u0085command output", "A title"],
  ["leading newline", "\nA title", "A title"],
  ["leading Unicode line separator", "\u2028A title", "A title"],
  ["leading Unicode paragraph separator", "\u2029A title", "A title"],
  ["leading Unicode next line", "\u0085A title", "A title"],
  ["blank title", "\n \t ", ""],
])("formats %s without exposing or erasing title content", (_label, title, expected) => {
  const notifications = setup();
  notifications.observe(snapshot(1, [item({ title })]));
  expect(native.notifications[0]?.options.body).toBe(`P1 ${expected}`.trimEnd());
});

it("truncates by code point without splitting an emoji's surrogate pair", () => {
  const notifications = setup();
  const prefix = "x ".repeat(78);
  const emoji = "\u{1f680}";
  notifications.observe(snapshot(1, [item({ title: `${prefix}${emoji} extra` })]));
  expect(native.notifications[0]?.options.body).toBe(`P1 ${prefix}${emoji}...`);
  expect(Array.from(native.notifications[0]?.options.body ?? "")).toHaveLength(163);
});

it("does not keep closed or disposed native handles, and supports platforms without notifications", () => {
  const notifications = setup();
  notifications.observe(snapshot(1, [item()]));
  native.notifications[0]?.emit("close");
  notifications.outgoing(acknowledge(1));
  expect(native.notifications[0]?.close).not.toHaveBeenCalled();
  native.supported = false;
  notifications.observe(snapshot(2, [item({ id: "unsupported" })]));
  expect(native.notifications).toHaveLength(1);
  native.supported = true;
  notifications.observe(snapshot(3, [item({ id: "supported" })]));
  notifications.dispose();
  expect(native.notifications[1]?.close).toHaveBeenCalledOnce();
});

it("reports native delivery failure without diagnostic text and releases its handle", () => {
  const notifications = setup();
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    notifications.observe(snapshot(1, [item()]));
    native.notifications[0]?.emit("failed", {}, "/private/diagnostic-output");
    notifications.outgoing(acknowledge(1));
    expect(native.notifications[0]?.close).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledExactlyOnceWith(
      "An Interrupt notification could not be displayed",
    );
  } finally {
    warned.mockRestore();
  }
});
