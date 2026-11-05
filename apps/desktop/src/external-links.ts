// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export function externalLinkHandlers(
  contents: { mainFrame: unknown },
  dependencies: {
    openExternal(url: string): Promise<void>;
    warn(message: string): void;
  },
) {
  async function open(input: unknown): Promise<boolean> {
    let url: URL;
    try {
      if (typeof input !== "string") throw new TypeError("Expected a URL string");
      url = new URL(input);
    } catch {
      dependencies.warn("Refused external link: invalid URL");
      return false;
    }
    if (url.origin !== "https://github.com" || url.username !== "" || url.password !== "") {
      dependencies.warn("Refused external link: URL is not allowlisted");
      return false;
    }
    try {
      await dependencies.openExternal(url.href);
      return true;
    } catch {
      dependencies.warn("Could not open GitHub link in the browser");
      return false;
    }
  }

  return {
    openFromRenderer(
      event: { sender: unknown; senderFrame: unknown },
      input: unknown,
    ): Promise<boolean> {
      if (event.sender !== contents || event.senderFrame !== contents.mainFrame) {
        dependencies.warn("Refused external link: untrusted sender");
        return Promise.resolve(false);
      }
      return open(input);
    },
    windowOpen({ url }: { url: string }): { action: "deny" } {
      void open(url);
      return { action: "deny" };
    },
  };
}
