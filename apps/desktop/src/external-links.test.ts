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

it.each([
  "https://github.com/",
  "https://github.com/login/device",
  "https://github.com/Azure/stack/pull/123",
  "https://github.com/Azure/stack/issues/123#issuecomment-456",
  "https://github.com/Azure/stack/commit/ba05b1c",
  "https://github.com/Azure/stack/compare/main...release?expand=1",
  "https://github.com/Azure/stack/actions/runs/123?check_suite_focus=true",
  "https://github.com:443/Azure/stack/deployments",
  "https://community.opengroup.org/osdu/platform/security-and-compliance/entitlements/-/merge_requests/968",
])("opens allowlisted evidence through the narrow preload call: %s", async (url) => {
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
  await expect(bridge.openExternal(url)).resolves.toBe(true);
  expect(invoke).toHaveBeenCalledWith("external:open", url);
  expect(host.openExternal).toHaveBeenCalledExactlyOnceWith(new URL(url).href);
});

it("opens only the identified GitHub deployment through the API origin", async () => {
  const host = harness();
  const url = "https://api.github.com/repos/Azure/osdu-spi-indexer/deployments/42";
  await expect(host.openFromRenderer(host.event, url)).resolves.toBe(true);
  expect(host.openExternal).toHaveBeenCalledExactlyOnceWith(url);
});

it.each([
  "http://github.com/Azure/stack",
  "http://community.opengroup.org/osdu/legal",
  "https://community.opengroup.org.evil.test/osdu/legal",
  "https://opengroup.org/osdu/legal",
  "https://gitlab.com/osdu/legal",
  "https://user:password@community.opengroup.org/osdu/legal",
  "https://user@community.opengroup.org/osdu/legal",
  "https://:password@community.opengroup.org/osdu/legal",
  "https://community.opengroup.org:8443/osdu/legal",
  "ftp://community.opengroup.org/osdu/legal",
  "blob:https://community.opengroup.org/id",
  "blob:https://github.com/id",
  "https://api.github.com/Azure/stack",
  "https://api.github.com/repos/Azure/osdu-spi-indexer/deployments",
  "https://api.github.com/repos/Azure/osdu-spi-indexer/deployments/42/statuses",
  "https://api.github.com/repos/Azure/osdu-spi-indexer/deployments/42?next=external",
  "https://user@api.github.com/repos/Azure/osdu-spi-indexer/deployments/42",
  "https://github.com.example.com/?secret=hidden",
  "https://example.com/?secret=hidden",
  "https://user:password@github.com/Azure/stack",
  "https://user@github.com/Azure/stack",
  "https://:password@github.com/Azure/stack",
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

it.each(["https://github.com/Azure/stack"])(
  "refuses calls from another window or a subframe: %s",
  async (url) => {
    const host = harness();
    await expect(host.openFromRenderer({ ...host.event, sender: {} }, url)).resolves.toBe(false);
    await expect(host.openFromRenderer({ ...host.event, senderFrame: {} }, url)).resolves.toBe(
      false,
    );
    expect(host.openExternal).not.toHaveBeenCalled();
    expect(host.warn).toHaveBeenCalledTimes(2);
  },
);

it.each(["https://github.com/Azure/stack/actions/runs/123"])(
  "always denies Electron windows while routing allowlisted URLs externally: %s",
  async (url) => {
    const host = harness();
    expect(host.windowOpen({ url })).toEqual({ action: "deny" });
    expect(host.windowOpen({ url: "https://example.com/?secret=hidden" })).toEqual({
      action: "deny",
    });
    await vi.waitFor(() => expect(host.openExternal).toHaveBeenCalledExactlyOnceWith(url));
    expect(host.warn).toHaveBeenCalledOnce();
  },
);

it.each(["https://github.com", "https://community.opengroup.org"])(
  "reports browser launch failures without leaking the URL from the error: %s",
  async (origin) => {
    const host = harness();
    host.openExternal.mockRejectedValue(new Error("Failed URL ?secret=hidden"));
    await expect(
      host.openFromRenderer(host.event, `${origin}/osdu/legal?secret=hidden`),
    ).resolves.toBe(false);
    expect(JSON.stringify(host.warn.mock.calls)).not.toContain("hidden");
    expect(host.warn).toHaveBeenCalledExactlyOnceWith("Could not open link in the browser");
  },
);
