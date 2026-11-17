// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it, vi } from "vitest";
import { bridgeOpens } from "./external-links.js";

type Bridge = {
  externalLinkHandlers(
    contents: { mainFrame: unknown },
    dependencies: { openExternal(url: string): Promise<void>; warn(message: string): void },
  ): {
    openFromRenderer(
      event: { sender: unknown; senderFrame: unknown },
      input: unknown,
    ): Promise<boolean>;
  };
};

/** The desktop's real link bridge, so an action it refuses cannot pass as opened. */
async function desktopBridge() {
  const path = "../../../desktop/src/external-links.ts";
  const { externalLinkHandlers } = (await import(/* @vite-ignore */ path)) as Bridge;
  const contents = { mainFrame: {} };
  const opened: string[] = [];
  const warn = vi.fn();
  const handlers = externalLinkHandlers(contents, {
    openExternal: async (url) => {
      opened.push(url);
    },
    warn,
  });
  const openExternal = (url: string) =>
    handlers.openFromRenderer({ sender: contents, senderFrame: contents.mainFrame }, url);
  return { opened, warn, openExternal };
}

it.each([
  "https://github.com/Azure/osdu-spi-legal/pull/31",
  "https://community.opengroup.org/osdu/platform/security-and-compliance/legal/-/commit/ba05b1c",
  "https://github.com:443/Azure/stack/actions/runs/123?check_suite_focus=true#jobs",
  "https://community.opengroup.org:443/osdu/legal/-/merge_requests/968",
  "http://community.opengroup.org/osdu/legal",
  "https://community.opengroup.org.evil.test/osdu/legal",
  "https://user@community.opengroup.org/osdu/legal",
  "https://:secret@community.opengroup.org/osdu/legal",
  "not a url",
])("decides %s by the desktop bridge's own allowlist", async (url) => {
  const bridge = await desktopBridge();
  expect(bridgeOpens(url)).toBe(await bridge.openExternal(url));
});
