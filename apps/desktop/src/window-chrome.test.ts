// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import {
  bindTitleBarAppearance,
  TITLEBAR_HEIGHT,
  WINDOW_APPEARANCE_CHANNEL,
  windowTitleBarOptions,
} from "./window-chrome.js";

it("insets the macOS traffic lights in the middle of the title bar, with no overlay", () => {
  for (const dark of [true, false])
    expect(windowTitleBarOptions(dark, "darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 13 },
    });
});

it("hides the Windows title bar and draws its caption buttons over the 40 px row", () => {
  expect(windowTitleBarOptions(true, "win32")).toEqual({
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#01000000", height: 40, symbolColor: "#f8fafc" },
  });
  expect(windowTitleBarOptions(false, "win32").titleBarOverlay).toEqual({
    color: "#01000000",
    height: 40,
    symbolColor: "#1f2937",
  });
});

it("matches the overlay height to the row the window draws its title bar in", () => {
  const css = readFileSync(new URL("../../window/src/style.css", import.meta.url), "utf8");
  expect(css).toMatch(new RegExp(`grid-template-rows: ${TITLEBAR_HEIGHT}px `));
});

it.each(["darwin", "win32"])(
  "sets a 740 px content minimum on the actual %s BrowserWindow",
  (platform) => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const construction = source.slice(
      source.indexOf("const window = new BrowserWindow("),
      source.indexOf("lifecycle.setWindow(window)"),
    );
    const options: Record<string, unknown>[] = [];
    runInNewContext(construction, {
      BrowserWindow: class {
        constructor(value: Record<string, unknown>) {
          options.push(value);
        }
      },
      smoke: false,
      proof: false,
      nativeTheme: { shouldUseDarkColors: false },
      process: { platform },
      windowTitleBarOptions,
      app: { isPackaged: false },
      desktopDir: "/desktop",
      join: (...parts: string[]) => parts.join("/"),
    });
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ minWidth: 740, useContentSize: true });
  },
);

function appearanceHarness(platform: NodeJS.Platform) {
  const handlers = new Map<string, (event: unknown, theme: unknown) => boolean>();
  const ipc = {
    handle: vi.fn((channel: string, listener: (event: never, theme: unknown) => boolean) => {
      handlers.set(channel, listener as (event: unknown, theme: unknown) => boolean);
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const closed: (() => void)[] = [];
  const contents = { mainFrame: {} };
  const window = {
    destroyed: false,
    webContents: contents,
    isDestroyed: () => window.destroyed,
    once: (_event: "closed", listener: () => void) => closed.push(listener),
    setTitleBarOverlay: vi.fn(),
  };
  const dispose = bindTitleBarAppearance(ipc, window, platform);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const send = (theme: unknown, from: unknown = event) =>
    handlers.get(WINDOW_APPEARANCE_CHANNEL)?.(from, theme);
  const symbols = () =>
    window.setTitleBarOverlay.mock.calls.map(([options]) => options.symbolColor);
  return { ipc, handlers, closed, window, dispose, send, symbols };
}

it("redraws the Windows caption symbols in each theme the renderer shows", () => {
  const harness = appearanceHarness("win32");
  expect(harness.send("dark")).toBe(true);
  expect(harness.send("light")).toBe(true);
  expect(harness.send("dark")).toBe(true);
  expect(harness.window.setTitleBarOverlay.mock.calls).toEqual([
    [{ color: "#01000000", height: 40, symbolColor: "#f8fafc" }],
    [{ color: "#01000000", height: 40, symbolColor: "#1f2937" }],
    [{ color: "#01000000", height: 40, symbolColor: "#f8fafc" }],
  ]);
});

it("ignores another sender, a subframe and anything but light or dark", () => {
  const harness = appearanceHarness("win32");
  const contents = harness.window.webContents;
  expect(harness.send("dark", { sender: {}, senderFrame: contents.mainFrame })).toBe(false);
  expect(harness.send("dark", { sender: contents, senderFrame: {} })).toBe(false);
  for (const theme of ["system", "Dark", "", null, { theme: "dark" }])
    expect(harness.send(theme)).toBe(false);
  expect(harness.window.setTitleBarOverlay).not.toHaveBeenCalled();
});

it("leaves a destroyed window alone and removes its handler once the window closes", () => {
  const harness = appearanceHarness("win32");
  harness.window.destroyed = true;
  expect(harness.send("dark")).toBe(false);
  expect(harness.window.setTitleBarOverlay).not.toHaveBeenCalled();
  for (const listener of harness.closed) listener();
  expect(harness.ipc.removeHandler).toHaveBeenCalledExactlyOnceWith(WINDOW_APPEARANCE_CHANNEL);
  expect(harness.handlers.size).toBe(0);
  harness.dispose();
  expect(harness.ipc.removeHandler).toHaveBeenCalledOnce();
});

it("keeps the macOS traffic lights as they are when the renderer changes theme", () => {
  const harness = appearanceHarness("darwin");
  expect(harness.send("dark")).toBe(false);
  expect(harness.send("light")).toBe(false);
  expect(harness.window.setTitleBarOverlay).not.toHaveBeenCalled();
});

it("carries the renderer's theme through the preload bridge to the caption overlay", async () => {
  const harness = appearanceHarness("win32");
  const event = {
    sender: harness.window.webContents,
    senderFrame: harness.window.webContents.mainFrame,
  };
  const invoke = vi.fn(async (channel: string, theme: unknown) =>
    harness.handlers.get(channel)?.(event, theme),
  );
  const exposeInMainWorld =
    vi.fn<(name: string, bridge: { setAppearance(theme: string): Promise<boolean> }) => void>();
  runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on: vi.fn() },
    }),
    process: { argv: [] },
  });
  const bridge = exposeInMainWorld.mock.calls[0]?.[1];
  if (!bridge) throw new Error("Missing preload bridge");
  await expect(bridge.setAppearance("dark")).resolves.toBe(true);
  await expect(bridge.setAppearance("light")).resolves.toBe(true);
  expect(invoke.mock.calls).toEqual([
    [WINDOW_APPEARANCE_CHANNEL, "dark"],
    [WINDOW_APPEARANCE_CHANNEL, "light"],
  ]);
  expect(harness.symbols()).toEqual(["#f8fafc", "#1f2937"]);
});
