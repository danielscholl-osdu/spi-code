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

it("routes the can't-read banner's Readiness through the preload to the renderer", () => {
  const { bridge, contents } = preload();
  const listener = vi.fn();
  bridge.onNavigate(listener);
  showDestination(vi.fn(), contents, { to: "readiness" });
  expect(listener).toHaveBeenCalledExactlyOnceWith({ to: "readiness" });
});

it("routes Today item identifiers through preload, never paths, URLs or extra fields", () => {
  const { bridge, contents, deliver } = preload();
  const listener = vi.fn();
  bridge.onNavigate(listener);
  showDestination(vi.fn(), contents, { to: "today", item: "conflict:entitlements:121" });
  expect(listener).toHaveBeenCalledExactlyOnceWith({
    to: "today",
    item: "conflict:entitlements:121",
  });
  for (const item of [
    "",
    "/tmp/file",
    "../file",
    "C:\\file",
    "https://example.com",
    " ",
    "private/file",
    "C:/file",
    "file:private",
    "data:payload",
    "javascript:alert(1)",
    "vbscript:msgbox",
    "a".repeat(257),
    "a".repeat(1024 * 1024),
    "__proto__",
    "constructor",
    "prototype",
    "a:../../etc/passwd",
    "a:repo/../file",
    "a:repo/..",
    "a:..",
    "%2e%2e",
    "a:%2E%2E/x",
    "a:x/%2e%2e",
    "a:..%2fetc",
    "a:x%2F..",
    "a:x..%2Fetc",
    "a:x/..suffix",
    "a:x../suffix",
    " javascript:",
    "halt:partition ",
    "\thalt:partition",
    "halt:partition\u00a0",
    "a:\u0000",
    "a:\n",
    "a:\u007f",
    "a:\u0085",
    "a:\u2028",
    "a:\u2029",
    null,
    3,
  ])
    deliver({ to: "today", item });
  deliver({ to: "today", item: "valid", url: "https://example.com" });
  deliver({ to: "today" });
  expect(listener).toHaveBeenCalledOnce();
  for (const item of [
    "access:owner/repository#12",
    "security:code:unsafe workflow",
    "a".repeat(256),
    "branch:v1..2",
    "campaign:toolchain:os-core-common%2010.0.0",
  ])
    deliver({ to: "today", item });
  expect(listener).toHaveBeenCalledTimes(6);
});

it("rejects destinations outside the closed set before the renderer sees them", () => {
  const { bridge, deliver } = preload();
  const listener = vi.fn();
  bridge.onNavigate(listener);
  for (const input of [
    { to: "settings" },
    { to: "readiness", section: "sweep" },
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
