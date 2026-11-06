// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

interface QuitEvent {
  preventDefault(): void;
}

interface DesktopApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: "second-instance" | "activate", listener: () => void): unknown;
  on(event: "before-quit", listener: (event: QuitEvent) => void): unknown;
}

interface DesktopWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  hide(): void;
  on(event: "close", listener: (event: QuitEvent) => void): unknown;
}

export function createLifecycle(
  app: DesktopApp,
  options: { stopHost(): Promise<void>; dispose(): void; onError(error: unknown): void },
) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return undefined;
  }
  let window: DesktopWindow | undefined;
  let openRequested = false;
  let quitting = false;
  let stopped = false;
  let shutdown: Promise<void> | undefined;
  const open = () => {
    if (quitting) return;
    if (!window || window.isDestroyed()) {
      openRequested = true;
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const quit = () => {
    quitting = true;
    shutdown ??= Promise.resolve()
      .then(() => options.stopHost())
      .then(() => {
        options.dispose();
        stopped = true;
        app.quit();
      });
    return shutdown;
  };
  app.on("second-instance", open);
  app.on("activate", open);
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    void quit().catch(options.onError);
  });
  return {
    open,
    quit,
    setWindow(value: DesktopWindow) {
      window = value;
      window.on("close", (event) => {
        if (quitting) return;
        event.preventDefault();
        value.hide();
      });
      if (openRequested) {
        openRequested = false;
        open();
      }
    },
  };
}

export async function stopHostAndReleaseLeases(
  stop: () => Promise<void>,
  storePath: string | undefined,
): Promise<void> {
  await stop();
  if (!storePath || !existsSync(storePath)) return;
  // The single-instance lock still owns this store. Windows can terminate the
  // utility process without running its SIGTERM lease cleanup.
  const db = new DatabaseSync(storePath);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL");
    db.exec("UPDATE leases SET owner = NULL, expires_at = 0 WHERE owner IS NOT NULL");
  } finally {
    db.close();
  }
}
