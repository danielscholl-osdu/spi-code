// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { parseMessage } from "@spi-code/contracts";

/** The IPC channel that tells the window it is going away; preload.cjs holds the same name. */
export const WINDOW_LEAVE_CHANNEL = "window:leave";
/** The ping id the window sends after its acknowledgement; apps/window navigation holds the same. */
export const WINDOW_LEAVE_ID = "window-leave";

/**
 * Asks the window to acknowledge what Today showed, then waits for the pong to the ping it sends
 * next. The pong follows the write: each port message is its own task, and the acknowledge route
 * writes synchronously in the microtask its message queued.
 */
export function windowLeave(signal: () => boolean) {
  const waiting = new Set<() => void>();
  return {
    /** Settles at the host's pong, or at once when the window or host cannot take the signal. */
    leave(): Promise<void> {
      if (!signal()) return Promise.resolve();
      return new Promise<void>((resolve) => waiting.add(resolve));
    },
    /** Watches host messages on the window relay for the window's leave pong. */
    observe(input: unknown) {
      const parsed = parseMessage(input);
      if (!parsed.ok || parsed.message.type !== "pong" || parsed.message.id !== WINDOW_LEAVE_ID)
        return;
      for (const resolve of waiting) resolve();
      waiting.clear();
    },
  };
}

export interface LeavingWindow {
  isDestroyed(): boolean;
  readonly webContents: { isLoadingMainFrame(): boolean; send(channel: string): void };
}

/** Signals the window to leave only when it is alive, loaded and the host relay is connected. */
export function windowLeaveSignal(window: LeavingWindow, connected: () => boolean) {
  return () => {
    if (window.isDestroyed() || window.webContents.isLoadingMainFrame() || !connected())
      return false;
    window.webContents.send(WINDOW_LEAVE_CHANNEL);
    return true;
  };
}
