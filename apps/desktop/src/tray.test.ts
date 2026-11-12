// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { AREAS, type Message, PROTOCOL_VERSION, ViewSnapshotSchema } from "@spi-code/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  bitmap: vi.fn((buffer: Buffer) => buffer),
  menu: vi.fn((items) => items),
  trays: [] as (EventEmitter & {
    setImage: ReturnType<typeof vi.fn>;
    setToolTip: ReturnType<typeof vi.fn>;
    setContextMenu: ReturnType<typeof vi.fn>;
    setTitle: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
  })[],
}));
vi.mock("electron", () => ({
  nativeImage: { createFromBitmap: electron.bitmap },
  nativeTheme: { shouldUseDarkColors: false },
  Menu: { buildFromTemplate: electron.menu },
  Tray: class extends EventEmitter {
    setImage = vi.fn();
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    setTitle = vi.fn();
    destroy = vi.fn();
    isDestroyed = vi.fn(() => false);
    constructor() {
      super();
      electron.trays.push(this);
    }
  },
}));

import { createSweepTray, dockBadge, trayChannel } from "./tray.js";

const sweepSchedule = {
  sweepMs: 300_000,
  gitlabMs: 1_800_000,
  securityMs: 1_800_000,
  releasesMs: 3_600_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  electron.trays.length = 0;
});
afterEach(() => vi.useRealTimers());

type Item = { label?: string; type?: string; enabled?: boolean; click?: () => void };
const menu = (): Item[] => electron.menu.mock.calls.at(-1)?.[0] ?? [];
const item = (label: string) => menu().find((entry) => entry.label === label);
/** A local wall-clock time, so the tooltip reads the same HH:MM in every zone. */
const at = (hours: number, minutes: number) => new Date(2026, 10, 9, hours, minutes).toISOString();

it("provides a status line, Sweep now, View sweep, Open and Quit, no Pause, and opens from a tray click", () => {
  const open = vi.fn();
  const quit = vi.fn();
  const viewSweep = vi.fn();
  const tray = createSweepTray(open, quit, { viewSweep });
  expect(menu().map(({ label, type }) => label ?? type)).toEqual([
    "First sweep running",
    "Sweep now",
    "View sweep",
    "separator",
    "Open",
    "Quit",
  ]);
  expect(menu()[0]?.enabled).toBe(false);
  item("Open")?.click?.();
  item("Quit")?.click?.();
  item("View sweep")?.click?.();
  expect(viewSweep).toHaveBeenCalledOnce();
  electron.trays[0]?.emit("click");
  expect(open).toHaveBeenCalledTimes(2);
  expect(quit).toHaveBeenCalledOnce();
  expect(tray.present()).toBe(true);
  tray.dispose();
  expect(electron.trays[0]?.destroy).toHaveBeenCalledOnce();
});

function snapshot(
  states: ("fresh" | "stale" | "incomplete" | "failed" | "unread")[],
  { interrupts = 0, sweptAt = at(8, 2) }: { interrupts?: number; sweptAt?: string } = {},
): Message {
  return briefed(read(states, sweptAt), interrupts);
}

function read(
  states: ("fresh" | "stale" | "incomplete" | "failed" | "unread")[],
  sweptAt: string,
): Message {
  const fixture = ViewSnapshotSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../../fixtures/watch/snapshot-59d6895.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  return {
    version: PROTOCOL_VERSION,
    id: "snapshot",
    kind: "event",
    type: "view.snapshot",
    payload: {
      ...fixture,
      sweptAt,
      areas: AREAS.map((area, index) => {
        const state = states[index % states.length] ?? "unread";
        return {
          area,
          envelope:
            state === "unread"
              ? { source: area, state }
              : {
                  source: area,
                  state,
                  observedAt: sweptAt,
                  completeness:
                    state === "incomplete"
                      ? { kind: "cut", reason: "fixture", read: 1, total: 2 }
                      : { kind: "complete" },
                },
        };
      }),
    },
  };
}

it("updates the dot and wording from validated host sweep evidence, including failure precedence", () => {
  const tray = createSweepTray(vi.fn(), vi.fn());
  const native = electron.trays[0];
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - First sweep running");
  tray.observe(snapshot(["fresh"]));
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - All fresh · swept 08:02");
  const fresh = electron.bitmap.mock.calls.at(-1)?.[0];
  tray.observe(snapshot(["stale", "incomplete"]));
  expect(native?.setToolTip).toHaveBeenLastCalledWith(
    "SPI Code - Areas cut or stale · swept 08:02",
  );
  expect(electron.bitmap.mock.calls.at(-1)?.[0]).not.toEqual(fresh);
  tray.observe(snapshot(["stale", "failed"]));
  tray.observe({
    version: PROTOCOL_VERSION,
    id: "budget",
    kind: "event",
    type: "sweep.status",
    payload: {
      remaining: 0,
      resetAt: null,
      deferredAreas: [{ area: "security", reason: "budget" }],
      nextSweepAt: null,
      schedule: sweepSchedule,
      lastSweep: null,
    },
  });
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - Read failed · swept 08:02");
  tray.disconnected();
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - Host reconnecting");
  tray.observe({
    version: PROTOCOL_VERSION,
    id: "host",
    kind: "response",
    type: "error",
    payload: { code: "host_unavailable", message: "Restart SPI Code to reconnect." },
  });
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - Host stopped");
});

function progress(
  outcome: "running" | "committed" | "failed",
  { first = true, settled = 9 }: { first?: boolean; settled?: number } = {},
): Message {
  const at = "2026-11-09T08:00:00Z";
  const sources = Array.from({ length: 12 }, (_, index) =>
    index < settled
      ? { source: `source-${index}`, state: "read" as const, startedAt: at, endedAt: at }
      : index === settled
        ? { source: `source-${index}`, state: "reading" as const, startedAt: at }
        : { source: `source-${index}`, state: "waiting" as const },
  );
  const common = { sweep: "sweep-1", startedAt: at, first, usualMs: null, sources };
  return {
    version: PROTOCOL_VERSION,
    id: `progress-${outcome}`,
    kind: "event",
    type: "sweep.progress",
    payload:
      outcome === "failed"
        ? {
            ...common,
            outcome,
            code: "save",
            failure: "The snapshot could not be saved.",
            nextAttemptAt: "2026-11-09T08:10:00Z",
          }
        : { ...common, outcome, nextAttemptAt: null },
  } as Message;
}

/** The fixture's brief with `interrupts` distinct interruptions, one of them carried twice under an alias. */
function briefed(message: Message, interrupts: number): Message {
  if (message.type !== "view.snapshot") throw new Error("expected a snapshot");
  const { briefing } = message.payload;
  let left = interrupts;
  const focus = briefing.focus.map((item) =>
    item.attention === "interrupt" && left-- > 0
      ? item
      : { ...item, attention: "surface" as const },
  );
  const first = focus.find(({ attention }) => attention === "interrupt");
  const rest = briefing.rest.map((item) =>
    first ? { ...item, attention: "interrupt" as const, ids: [...item.ids, first.id] } : item,
  );
  return {
    ...message,
    payload: { ...message.payload, briefing: { ...briefing, focus, rest } },
  } as Message;
}

it("counts the sweep's progress while the first sweep runs and paints failed when it stops outright", () => {
  const tray = createSweepTray(vi.fn(), vi.fn());
  const native = electron.trays[0];
  tray.observe(progress("running"));
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - First sweep running · 9 of 12");
  const running = electron.bitmap.mock.calls.at(-1)?.[0];
  tray.observe(progress("failed"));
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - First sweep stopped");
  expect(electron.bitmap.mock.calls.at(-1)?.[0]).not.toEqual(running);
  tray.observe(progress("running", { settled: 2 }));
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - First sweep running · 2 of 12");
  tray.observe(snapshot(["fresh"]));
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - Today is ready");
  tray.observe(status(false));
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - Today is ready");
  tray.observe(progress("running", { first: false }));
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - Sweeping 9 of 12 · last 08:02");
  tray.observe(progress("failed", { first: false }));
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - All fresh · swept 08:02");
  tray.observe(snapshot(["fresh"]));
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - All fresh · swept 08:02");
});

it("notifies 'Today is ready' once, when hidden, from the first snapshot with its interruption count", () => {
  const notify = vi.fn();
  let hidden = true;
  const tray = createSweepTray(vi.fn(), vi.fn(), { hidden: () => hidden, notify });
  tray.observe(progress("running"));
  tray.observe(progress("committed", { settled: 12 }));
  expect(notify).not.toHaveBeenCalled();
  tray.observe(snapshot(["fresh"], { interrupts: 2 }));
  expect(notify).toHaveBeenCalledExactlyOnceWith("Today is ready", "2 interruptions need you.");
  tray.disconnected();
  tray.observe(progress("running"));
  tray.observe(snapshot(["fresh"], { interrupts: 1 }));
  tray.observe(progress("running", { first: false }));
  tray.observe(snapshot(["fresh"], { interrupts: 1 }));
  expect(notify).toHaveBeenCalledOnce();

  hidden = false;
  const shown = vi.fn();
  const visible = createSweepTray(vi.fn(), vi.fn(), { hidden: () => hidden, notify: shown });
  visible.observe(progress("running"));
  visible.observe(snapshot(["fresh"], { interrupts: 1 }));
  hidden = true;
  visible.observe(snapshot(["fresh"], { interrupts: 1 }));
  expect(shown).not.toHaveBeenCalled();
  expect(electron.trays[1]?.setToolTip).toHaveBeenCalledWith("SPI Code - Today is ready");
});

it("names one interruption or none in the hand-over notification, and stays quiet over a kept snapshot", () => {
  const one = vi.fn();
  const single = createSweepTray(vi.fn(), vi.fn(), { hidden: () => true, notify: one });
  single.observe(progress("running"));
  single.observe(snapshot(["fresh"], { interrupts: 1 }));
  expect(one).toHaveBeenCalledExactlyOnceWith("Today is ready", "1 interruption needs you.");

  const none = vi.fn();
  const quiet = createSweepTray(vi.fn(), vi.fn(), { hidden: () => true, notify: none });
  quiet.observe(progress("running"));
  quiet.observe(snapshot(["fresh"], { interrupts: 0 }));
  expect(none).toHaveBeenCalledExactlyOnceWith("Today is ready", undefined);

  const kept = vi.fn();
  const replay = createSweepTray(vi.fn(), vi.fn(), { hidden: () => true, notify: kept });
  replay.observe(snapshot(["fresh"]));
  replay.observe(progress("running", { first: false }));
  replay.observe(snapshot(["fresh"]));
  expect(kept).not.toHaveBeenCalled();
});

function status(deferred: boolean): Message {
  return {
    version: PROTOCOL_VERSION,
    id: "budget",
    kind: "event",
    type: "sweep.status",
    payload: {
      remaining: deferred ? 0 : 40,
      resetAt: null,
      deferredAreas: deferred ? [{ area: "security", reason: "budget" }] : [],
      nextSweepAt: null,
      schedule: sweepSchedule,
      lastSweep: null,
    },
  } as Message;
}

it("keeps the first sweep's stopped and ready text when budget status arrives", () => {
  const bitmap = () => electron.bitmap.mock.calls.at(-1)?.[0];
  const stopped = createSweepTray(vi.fn(), vi.fn());
  stopped.observe(progress("running"));
  const unread = bitmap();
  stopped.observe(progress("failed"));
  const failed = bitmap();
  stopped.observe(status(false));
  expect(electron.trays[0]?.setToolTip).toHaveBeenLastCalledWith("SPI Code - First sweep stopped");
  expect(bitmap()).toEqual(failed);
  expect(bitmap()).not.toEqual(unread);

  const ready = createSweepTray(vi.fn(), vi.fn());
  ready.observe(progress("running"));
  ready.observe(snapshot(["stale", "failed"]));
  expect(electron.trays[1]?.setToolTip).toHaveBeenLastCalledWith("SPI Code - Today is ready");
  expect(bitmap()).toEqual(failed);
  ready.observe(status(true));
  expect(electron.trays[1]?.setToolTip).toHaveBeenLastCalledWith("SPI Code - Today is ready");
  expect(bitmap()).toEqual(failed);
  ready.observe(snapshot(["fresh"]));
  ready.observe(status(true));
  expect(electron.trays[1]?.setToolTip).toHaveBeenLastCalledWith(
    "SPI Code - Areas cut or stale · swept 08:02",
  );
});

class Port extends EventEmitter {
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();
}

it("observes host messages while forwarding both directions and closes old relays on reconnect", () => {
  const channels: { port1: Port; port2: Port }[] = [];
  const makeChannel = () => {
    const channel = { port1: new Port(), port2: new Port() };
    channels.push(channel);
    return channel;
  };
  const observe = vi.fn();
  const bridge = trayChannel(makeChannel, observe);
  const transferred = bridge.connect();
  expect(transferred.port1).toBe(channels[0]?.port1);
  expect(transferred.port2).toBe(channels[1]?.port2);
  const message = snapshot(["fresh"]);
  channels[1]?.port1.emit("message", { data: message, ports: [] });
  expect(observe).toHaveBeenCalledWith(message);
  expect(channels[0]?.port2.postMessage).toHaveBeenCalledWith(message, []);
  const request = { malformed: true };
  channels[0]?.port2.emit("message", { data: request, ports: [] });
  expect(channels[1]?.port1.postMessage).toHaveBeenCalledWith(request, []);
  bridge.connect();
  expect(channels[0]?.port2.close).toHaveBeenCalledOnce();
  expect(channels[1]?.port1.close).toHaveBeenCalledOnce();
  bridge.dispose();
  expect(channels[2]?.port2.close).toHaveBeenCalledOnce();
  expect(channels[3]?.port1.close).toHaveBeenCalledOnce();
});

it("forwards each host message before observing it, even when the observer throws", () => {
  const channels: { port1: Port; port2: Port }[] = [];
  const observe = vi.fn(() => {
    throw new Error("observer broke");
  });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  trayChannel(() => {
    const channel = { port1: new Port(), port2: new Port() };
    channels.push(channel);
    return channel;
  }, observe).connect();
  const first = snapshot(["fresh"]);
  const second = snapshot(["failed"]);
  expect(() => {
    channels[1]?.port1.emit("message", { data: first, ports: [] });
    channels[1]?.port1.emit("message", { data: second, ports: [] });
  }).not.toThrow();
  const forwarded = channels[0]?.port2.postMessage;
  expect(forwarded?.mock.calls).toEqual([
    [first, []],
    [second, []],
  ]);
  expect(forwarded?.mock.invocationCallOrder[0]).toBeLessThan(
    observe.mock.invocationCallOrder[0] ?? 0,
  );
  expect(logged).toHaveBeenCalledTimes(2);
  logged.mockRestore();
});

/** A snapshot whose brief carries `count` distinct interruptions. */
function interrupting(count: number): Message {
  const message = snapshot(["fresh"]);
  if (message.type !== "view.snapshot") throw new Error("expected a snapshot");
  const { focus: listed } = message.payload.briefing;
  const [lead] = listed;
  if (!lead) throw new Error("fixture has no focus item");
  const extra = Array.from({ length: Math.max(0, count - listed.length) }, (_, index) => ({
    ...lead,
    id: `interrupt-${index}`,
    ids: [`interrupt-${index}`],
  }));
  const focus = [...listed, ...extra].map((item, index) => ({
    ...item,
    attention: index < count ? ("interrupt" as const) : ("surface" as const),
  }));
  return {
    ...message,
    payload: { ...message.payload, briefing: { ...message.payload.briefing, focus } },
  } as Message;
}

/** A later sweep that finished with one source failed for want of a sign-in. */
function signedOut(source: string, outcome: "committed" | "running" = "committed"): Message {
  const message = progress(outcome, { first: false, settled: 12 });
  if (message.type !== "sweep.progress") throw new Error("expected progress");
  const sources = message.payload.sources.map((entry, index) =>
    index === 0
      ? {
          source,
          state: "failed" as const,
          code: "signin" as const,
          reason: "The tool is not signed in.",
          startedAt: at(8, 0),
          endedAt: at(8, 0),
        }
      : entry,
  );
  return { ...message, payload: { ...message.payload, sources } } as Message;
}

function setup(
  gh: "ready" | "signed-out" | "missing",
  glab: "ready" | "signed-out" = "ready",
): Message {
  const ready = gh === "ready";
  return {
    version: PROTOCOL_VERSION,
    id: "setup",
    kind: "event",
    type: "setup.state",
    payload: {
      tools: [
        { tool: "git", state: "ready", action: null },
        {
          tool: "gh",
          state: gh,
          action: ready ? null : gh === "missing" ? "install" : "signin",
        },
        { tool: "glab", state: glab, action: glab === "ready" ? null : "signin" },
      ],
      watchReady: ready,
      disabledReason: ready ? null : "GitHub CLI is not ready.",
    },
  } as Message;
}

function scheduled(nextSweepAt: string | null): Message {
  const message = status(false);
  if (message.type !== "sweep.status") throw new Error("expected status");
  return { ...message, payload: { ...message.payload, nextSweepAt } } as Message;
}

it("reads each designed tooltip after the first sweep, keeping the committed dot while sweeping", () => {
  const tray = createSweepTray(vi.fn(), vi.fn());
  const native = electron.trays[0];
  const tip = () => native?.setToolTip.mock.calls.at(-1)?.[0];
  const dot = () => electron.bitmap.mock.calls.at(-1)?.[0];
  tray.observe(snapshot(["fresh"]));
  expect(tip()).toBe("SPI Code - All fresh · swept 08:02");
  const fresh = dot();
  tray.observe(progress("running", { first: false, settled: 4 }));
  expect(tip()).toBe("SPI Code - Sweeping 4 of 12 · last 08:02");
  expect(dot()).toEqual(fresh);
  tray.observe(snapshot(["fresh"], { interrupts: 2, sweptAt: at(8, 7) }));
  tray.observe(progress("committed", { first: false, settled: 12 }));
  expect(tip()).toBe("SPI Code - 2 need you · swept 08:07");
  tray.observe(snapshot(["fresh"], { interrupts: 1, sweptAt: at(8, 7) }));
  expect(tip()).toBe("SPI Code - 1 needs you · swept 08:07");

  tray.observe(signedOut("upstream"));
  expect(tip()).toBe("SPI Code - Can't read: glab signed out");
  expect(dot()).not.toEqual(fresh);
  tray.observe(progress("failed", { first: false }));
  expect(tip()).toBe("SPI Code - Can't read: glab signed out");
  tray.observe(progress("committed", { first: false, settled: 12 }));
  expect(tip()).toBe("SPI Code - 1 needs you · swept 08:07");
  // auth checks both tools, so its sign-in failure names no tool until setup says which.
  tray.observe(signedOut("auth"));
  expect(tip()).toBe("SPI Code - 1 needs you · swept 08:07");

  tray.observe(setup("signed-out"));
  expect(tip()).toBe("SPI Code - Can't read: gh signed out");
  tray.observe(setup("missing"));
  expect(tip()).toBe("SPI Code - Watch is off");
  tray.observe(setup("ready"));
  tray.observe(snapshot(["fresh"]));
  expect(tip()).toBe("SPI Code - All fresh · swept 08:02");
});

it("shows the next sweep in the menu's status line only while it is ahead, and Sweeping while one runs", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date(2026, 10, 9, 8, 4));
  const tray = createSweepTray(vi.fn(), vi.fn());
  tray.observe(snapshot(["fresh"]));
  tray.observe(scheduled(at(8, 7)));
  expect(menu()[0]).toMatchObject({ label: "Swept 08:02 · next 08:07", enabled: false });
  expect(item("Sweep now")?.enabled).toBe(true);
  const built = electron.menu.mock.calls.length;
  tray.observe(scheduled(at(8, 7)));
  expect(electron.menu.mock.calls.length).toBe(built);
  vi.advanceTimersByTime(3 * 60_000 + 1);
  expect(menu()[0]?.label).toBe("Swept 08:02");
  tray.observe(scheduled(at(8, 1)));
  expect(menu()[0]?.label).toBe("Swept 08:02");

  tray.observe(scheduled(null));
  tray.observe(progress("running", { first: false, settled: 4 }));
  expect(menu()[0]?.label).toBe("Sweeping · 4 of 12");
  expect(item("Sweep now")?.enabled).toBe(false);
  expect(item("View sweep")?.enabled).not.toBe(false);
  tray.observe(progress("committed", { first: false, settled: 12 }));
  expect(item("Sweep now")?.enabled).toBe(true);
  tray.observe(setup("missing"));
  expect(menu()[0]?.label).toBe("Watch is off");
  expect(item("Sweep now")?.enabled).toBe(false);
  tray.observe(setup("ready"));
  expect(item("Sweep now")?.enabled).toBe(true);
  tray.disconnected();
  expect(menu()[0]?.label).toBe("Host reconnecting");
  expect(item("Sweep now")?.enabled).toBe(false);
  tray.dispose();
});

it("badges the dock with the Today count, 9+ past nine, and clears it when the count goes", () => {
  expect([0, 1, 9, 10, 42].map(dockBadge)).toEqual(["", "1", "9", "9+", "9+"]);
  const badge = vi.fn();
  const tray = createSweepTray(vi.fn(), vi.fn(), { badge });
  tray.observe(snapshot(["fresh"]));
  expect(badge).not.toHaveBeenCalled();
  tray.observe(interrupting(2));
  tray.observe(interrupting(2));
  tray.observe(interrupting(9));
  tray.observe(interrupting(12));
  expect(electron.trays[0]?.setToolTip).toHaveBeenLastCalledWith(
    "SPI Code - 12 need you · swept 08:02",
  );
  tray.disconnected();
  expect(badge.mock.calls).toEqual([["2"], ["9"], ["9+"], [""]]);
  expect(electron.trays[0]?.setTitle).not.toHaveBeenCalled();
});

it("sends Sweep now from the tray through the real relay to the host's sweep.request route", async () => {
  const { MessageChannel } = await import("node:worker_threads");
  const { attachHostPort } = await import("../../../packages/host/src/process/port.js");
  const { WatchRoutes } = await import("../../../packages/host/src/process/routes.js");
  type NodePort = InstanceType<typeof MessageChannel>["port1"];
  const adapt = (port: NodePort) => {
    const adapted = {
      on(_event: "message", listener: (event: { data: unknown; ports: never[] }) => void) {
        port.on("message", (data: unknown) => listener({ data, ports: [] }));
        return adapted;
      },
      postMessage: (data: unknown) => port.postMessage(data),
      start: () => port.start(),
      close: () => port.close(),
    };
    return adapted;
  };
  const opened: NodePort[] = [];
  const relay = trayChannel(
    () => {
      const channel = new MessageChannel();
      opened.push(channel.port1, channel.port2);
      return { port1: adapt(channel.port1), port2: adapt(channel.port2) };
    },
    (message) => tray.observe(message),
  );
  const tray = createSweepTray(vi.fn(), vi.fn(), { request: (message) => relay.request(message) });
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  item("Sweep now")?.click?.();
  expect(warned).toHaveBeenCalledExactlyOnceWith("Sweep now could not reach the host");
  warned.mockRestore();
  try {
    const requested = new Promise<unknown>((resolve) => {
      const watch = new WatchRoutes({
        db: () => {
          throw new Error("Sweep now must not open the store");
        },
        fleet: "fleet",
        ctx: {} as ConstructorParameters<typeof WatchRoutes>[0]["ctx"],
        appData: "",
        exec: {
          runJSON: async () => {
            throw new Error("Sweep now must not read");
          },
          runText: async () => {
            throw new Error("Sweep now must not read");
          },
        },
        onError: (error) => {
          throw error;
        },
        requestSweep: async (request) => {
          resolve(request);
          return true;
        },
      });
      const { port2 } = relay.connect();
      attachHostPort(port2, process.pid, watch.routes);
    });
    item("Sweep now")?.click?.();
    await expect(requested).resolves.toEqual({ now: true });
  } finally {
    relay.dispose();
    for (const port of opened) port.close();
    tray.dispose();
  }
});

it("names glab, never gh, when only glab is signed out", () => {
  const tray = createSweepTray(vi.fn(), vi.fn());
  const tip = () => electron.trays[0]?.setToolTip.mock.calls.at(-1)?.[0];
  tray.observe(setup("ready", "signed-out"));
  tray.observe(snapshot(["fresh"]));
  tray.observe(signedOut("auth"));
  expect(tip()).toBe("SPI Code - Can't read: glab signed out");
  tray.observe(signedOut("radar"));
  expect(tip()).toBe("SPI Code - Can't read: glab signed out");
  tray.observe(setup("ready", "ready"));
  expect(tip()).toBe("SPI Code - Can't read: glab signed out");
  tray.observe(signedOut("auth"));
  expect(tip()).toBe("SPI Code - All fresh · swept 08:02");
  expect(electron.trays[0]?.setToolTip.mock.calls.flat()).not.toContain(
    "SPI Code - Can't read: gh signed out",
  );
});

it("keeps the committed signed-out red while a routine sweep runs", () => {
  const tray = createSweepTray(vi.fn(), vi.fn());
  const tip = () => electron.trays[0]?.setToolTip.mock.calls.at(-1)?.[0];
  const dot = () => electron.bitmap.mock.calls.at(-1)?.[0];
  tray.observe(snapshot(["fresh"]));
  const fresh = dot();
  tray.observe(signedOut("upstream"));
  expect(tip()).toBe("SPI Code - Can't read: glab signed out");
  const red = dot();
  expect(red).not.toEqual(fresh);
  tray.observe(progress("running", { first: false, settled: 4 }));
  expect(tip()).toBe("SPI Code - Sweeping 4 of 12 · last 08:02");
  expect(dot()).toEqual(red);
  tray.observe(progress("committed", { first: false, settled: 12 }));
  expect(tip()).toBe("SPI Code - All fresh · swept 08:02");
  expect(dot()).toEqual(fresh);
});
