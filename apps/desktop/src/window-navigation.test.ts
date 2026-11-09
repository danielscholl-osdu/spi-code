// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { showDestination, WINDOW_NAVIGATE_CHANNEL } from "./window-navigation.js";

function preload() {
  const handlers = new Map<string, (event: unknown, input: unknown) => void>();
  const exposeInMainWorld =
    vi.fn<
      (
        name: string,
        bridge: { onNavigate(listener: (destination: unknown) => void): () => void },
      ) => void
    >();
  runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: {
        invoke: vi.fn(),
        on: (channel: string, handler: (event: unknown, input: unknown) => void) =>
          handlers.set(channel, handler),
      },
    }),
    process: { argv: [] },
  });
  const bridge = exposeInMainWorld.mock.calls[0]?.[1];
  if (!bridge) throw new Error("Missing preload bridge");
  const contents = {
    isDestroyed: () => false,
    send: vi.fn((channel: string, input: unknown) => handlers.get(channel)?.({}, input)),
  };
  return {
    bridge,
    contents,
    deliver: (input: unknown) => contents.send(WINDOW_NAVIGATE_CHANNEL, input),
  };
}

it("shows the window and routes View sweep through the preload to the renderer", () => {
  const { bridge, contents } = preload();
  const listener = vi.fn();
  const unsubscribe = bridge.onNavigate(listener);
  const open = vi.fn();
  showDestination(open, contents, { to: "evidence" });
  expect(open.mock.invocationCallOrder[0]).toBeLessThan(
    contents.send.mock.invocationCallOrder[0] ?? 0,
  );
  expect(listener).toHaveBeenCalledExactlyOnceWith({ to: "evidence" });
  unsubscribe();
  showDestination(open, contents, { to: "evidence" });
  expect(listener).toHaveBeenCalledOnce();
});

it("rejects destinations outside the closed set before the renderer sees them", () => {
  const { bridge, deliver } = preload();
  const listener = vi.fn();
  bridge.onNavigate(listener);
  for (const input of [
    { to: "settings" },
    { to: "readiness" },
    { to: "constructor" },
    { to: "evidence", item: "conflict:entitlements:121" },
    { to: ["evidence"] },
    { route: "evidence" },
    ["evidence"],
    "evidence",
    null,
    undefined,
  ])
    deliver(input);
  expect(listener).not.toHaveBeenCalled();
});

it("holds the latest destination for a renderer that subscribes after the tray click", () => {
  const { bridge, deliver } = preload();
  deliver({ to: "evidence" });
  deliver({ to: "settings" });
  const listener = vi.fn();
  bridge.onNavigate(listener);
  expect(listener).toHaveBeenCalledExactlyOnceWith({ to: "evidence" });
  bridge.onNavigate(vi.fn());
  expect(listener).toHaveBeenCalledOnce();
});

it("skips the send when the window has gone", () => {
  const send = vi.fn();
  const open = vi.fn();
  showDestination(open, { isDestroyed: () => true, send }, { to: "evidence" });
  expect(open).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
});
