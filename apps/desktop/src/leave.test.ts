// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import { WINDOW_LEAVE_CHANNEL, WINDOW_LEAVE_ID, windowLeave, windowLeaveSignal } from "./leave.js";

function preloadLeave() {
  const handlers = new Map<string, () => void>();
  const exposeInMainWorld =
    vi.fn<(name: string, bridge: { onLeave(listener: () => void): () => void }) => void>();
  runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: {
        invoke: vi.fn(),
        on: (channel: string, handler: () => void) => handlers.set(channel, handler),
      },
    }),
    process: { argv: [] },
  });
  const bridge = exposeInMainWorld.mock.calls[0]?.[1];
  if (!bridge) throw new Error("Missing preload bridge");
  return { bridge, send: (channel: string) => handlers.get(channel)?.() };
}

const pong = (id: string) => ({
  version: PROTOCOL_VERSION,
  id,
  kind: "response",
  type: "pong",
  payload: {},
});

it("signals the window through preload and settles only at the host's leave pong", async () => {
  const { bridge, send } = preloadLeave();
  const listener = vi.fn();
  bridge.onLeave(listener);
  const leaving = windowLeave(() => {
    send(WINDOW_LEAVE_CHANNEL);
    return true;
  });
  let settled = false;
  const left = leaving.leave().then(() => {
    settled = true;
  });
  expect(listener).toHaveBeenCalledOnce();
  leaving.observe(pong("connect"));
  await Promise.resolve();
  expect(settled).toBe(false);
  leaving.observe(pong(WINDOW_LEAVE_ID));
  await left;
  expect(settled).toBe(true);
});

it("settles at once when the window or host cannot take the signal", async () => {
  await expect(windowLeave(() => false).leave()).resolves.toBeUndefined();
});

it("signals only a live, loaded window with a connected host, never touching a destroyed one", () => {
  const state = { destroyed: false, loading: false, connected: true };
  const send = vi.fn();
  const window = {
    isDestroyed: () => state.destroyed,
    get webContents() {
      if (state.destroyed) throw new Error("Object has been destroyed");
      return { isLoadingMainFrame: () => state.loading, send };
    },
  };
  const signal = windowLeaveSignal(window, () => state.connected);
  expect(signal()).toBe(true);
  expect(send).toHaveBeenCalledExactlyOnceWith(WINDOW_LEAVE_CHANNEL);
  for (const blocked of [{ loading: true }, { connected: false }, { destroyed: true }]) {
    Object.assign(state, { destroyed: false, loading: false, connected: true }, blocked);
    expect(signal()).toBe(false);
  }
  expect(send).toHaveBeenCalledOnce();
});
