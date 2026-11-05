// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { externalLinkHandlers } from "./external-links.js";

function harness() {
  const contents = { mainFrame: {} };
  const openExternal = vi.fn(async (_url: string) => {});
  const warn = vi.fn();
  const handlers = externalLinkHandlers(contents, { openExternal, warn });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { ...handlers, contents, openExternal, warn, event };
}

it("opens GitHub evidence through the narrow preload call", async () => {
  const host = harness();
  const invoke = vi.fn((_channel: string, url: unknown) => host.openFromRenderer(host.event, url));
  const exposeInMainWorld =
    vi.fn<(name: string, bridge: { openExternal(url: string): Promise<boolean> }) => void>();
  runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on: vi.fn() },
    }),
    process: { argv: [] },
  });
  const bridge = exposeInMainWorld.mock.calls[0]?.[1];
  if (!bridge) throw new Error("Missing preload bridge");
  const url = "https://github.com/Azure/stack/actions/runs/123?check_suite_focus=true";
  await expect(bridge.openExternal(url)).resolves.toBe(true);
  expect(invoke).toHaveBeenCalledWith("external:open", url);
  expect(host.openExternal).toHaveBeenCalledExactlyOnceWith(url);
});

it.each([
  "http://github.com/Azure/stack",
  "https://api.github.com/Azure/stack",
  "https://github.com.example.com/?secret=hidden",
  "https://example.com/?secret=hidden",
  "https://user:password@github.com/Azure/stack",
  "https://user@github.com/Azure/stack",
  "https://github.com:8443/Azure/stack?secret=hidden",
  "javascript:alert(1)",
  "file:///tmp/test",
  "//github.com/Azure/stack",
  "not a URL?secret=hidden",
  null,
  { url: "https://github.com/Azure/stack" },
])("refuses non-allowlisted input without logging URL secrets: %j", async (input) => {
  const host = harness();
  await expect(host.openFromRenderer(host.event, input)).resolves.toBe(false);
  expect(host.openExternal).not.toHaveBeenCalled();
  expect(host.warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(host.warn.mock.calls)).not.toMatch(/hidden|password|secret/);
});

it("refuses calls from another window or a subframe", async () => {
  const host = harness();
  const url = "https://github.com/Azure/stack";
  await expect(host.openFromRenderer({ ...host.event, sender: {} }, url)).resolves.toBe(false);
  await expect(host.openFromRenderer({ ...host.event, senderFrame: {} }, url)).resolves.toBe(false);
  expect(host.openExternal).not.toHaveBeenCalled();
  expect(host.warn).toHaveBeenCalledTimes(2);
});

it("always denies Electron windows while routing only allowlisted URLs externally", async () => {
  const host = harness();
  const url = "https://github.com/Azure/stack/actions/runs/123";
  expect(host.windowOpen({ url })).toEqual({ action: "deny" });
  expect(host.windowOpen({ url: "https://example.com/?secret=hidden" })).toEqual({
    action: "deny",
  });
  await vi.waitFor(() => expect(host.openExternal).toHaveBeenCalledExactlyOnceWith(url));
  expect(host.warn).toHaveBeenCalledOnce();
});

it("reports browser launch failures without leaking the URL from the error", async () => {
  const host = harness();
  host.openExternal.mockRejectedValue(new Error("Failed URL ?secret=hidden"));
  await expect(
    host.openFromRenderer(host.event, "https://github.com/Azure/stack?secret=hidden"),
  ).resolves.toBe(false);
  expect(JSON.stringify(host.warn.mock.calls)).not.toContain("hidden");
  expect(host.warn).toHaveBeenCalledExactlyOnceWith("Could not open GitHub link in the browser");
});
