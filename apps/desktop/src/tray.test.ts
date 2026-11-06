// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { AREAS, type Message, PROTOCOL_VERSION, ViewSnapshotSchema } from "@spi-code/contracts";
import { beforeEach, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  bitmap: vi.fn((buffer: Buffer) => buffer),
  menu: vi.fn((items) => items),
  trays: [] as (EventEmitter & {
    setImage: ReturnType<typeof vi.fn>;
    setToolTip: ReturnType<typeof vi.fn>;
    setContextMenu: ReturnType<typeof vi.fn>;
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
    destroy = vi.fn();
    isDestroyed = vi.fn(() => false);
    constructor() {
      super();
      electron.trays.push(this);
    }
  },
}));

import { createSweepTray, trayChannel } from "./tray.js";

beforeEach(() => {
  vi.clearAllMocks();
  electron.trays.length = 0;
});

it("provides Open and Quit, no Pause, and opens from a tray click on either platform", () => {
  const open = vi.fn();
  const quit = vi.fn();
  const tray = createSweepTray(open, quit);
  const menu = electron.menu.mock.calls[0]?.[0];
  expect(menu.map(({ label }: { label: string }) => label)).toEqual(["Open", "Quit"]);
  menu[0].click();
  menu[1].click();
  electron.trays[0]?.emit("click");
  expect(open).toHaveBeenCalledTimes(2);
  expect(quit).toHaveBeenCalledOnce();
  expect(tray.present()).toBe(true);
  tray.dispose();
  expect(electron.trays[0]?.destroy).toHaveBeenCalledOnce();
});

function snapshot(states: ("fresh" | "stale" | "incomplete" | "failed" | "unread")[]): Message {
  const sweptAt = "2026-01-01T00:00:00Z";
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
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - All fresh");
  const fresh = electron.bitmap.mock.calls.at(-1)?.[0];
  tray.observe(snapshot(["stale", "incomplete"]));
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - Areas cut or stale");
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
    },
  });
  expect(native?.setToolTip).toHaveBeenLastCalledWith("SPI Code - Read failed");
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
