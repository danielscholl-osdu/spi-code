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
  on(event: "query-session-end" | "session-end", listener: () => void): unknown;
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
  const quitForOs = () => void quit().catch(options.onError);
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    quitForOs();
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
      window.on("query-session-end", quitForOs);
      window.on("session-end", quitForOs);
      if (openRequested) {
        openRequested = false;
        open();
      }
    },
  };
}

export const HOST_STOP_GRACE_MS = 3000;
export const HOST_KILL_WAIT_MS = 1000;

interface StopBound {
  graceMs?: number;
  killWaitMs?: number;
  schedule?(ms: number, callback: () => void): () => void;
  log?(message: string): void;
}

function wait(ms: number, schedule: NonNullable<StopBound["schedule"]>) {
  let cancel = () => {};
  const elapsed = new Promise<"timeout">((resolve) => {
    cancel = schedule(ms, () => resolve("timeout"));
  });
  return { elapsed, cancel };
}

export async function stopWithin(
  stop: () => Promise<void>,
  hardKill: () => void,
  {
    graceMs = HOST_STOP_GRACE_MS,
    killWaitMs = HOST_KILL_WAIT_MS,
    schedule = (ms, callback) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    log = console.warn,
  }: StopBound = {},
): Promise<void> {
  const exited = stop().then(() => "exited" as const);
  const grace = wait(graceMs, schedule);
  try {
    if ((await Promise.race([exited, grace.elapsed])) === "exited") return;
  } finally {
    grace.cancel();
  }
  log(`Host did not stop within ${graceMs} ms; killing it`);
  hardKill();
  const killed = wait(killWaitMs, schedule);
  try {
    if ((await Promise.race([exited, killed.elapsed])) === "exited") return;
  } finally {
    killed.cancel();
  }
  throw new Error(`Host did not exit within ${killWaitMs} ms of a hard kill`);
}

export async function stopHostAndReleaseLeases(
  stop: () => Promise<void>,
  storePath: string | undefined,
  log: (message: string) => void = console.warn,
): Promise<void> {
  await stop();
  if (!storePath || !existsSync(storePath)) return;
  // The single-instance lock still owns this store. Windows can terminate the
  // utility process without running its SIGTERM lease cleanup.
  const db = new DatabaseSync(storePath);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'leases'").get()) {
      log("Run store has no leases table; nothing to release");
      return;
    }
    db.exec("UPDATE leases SET owner = NULL, expires_at = 0 WHERE owner IS NOT NULL");
  } finally {
    db.close();
  }
}
