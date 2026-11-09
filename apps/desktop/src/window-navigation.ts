// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** The IPC channel desktop main sends a window destination on; preload.cjs holds the same name. */
export const WINDOW_NAVIGATE_CHANNEL = "window:navigate";

/** The closed set of places desktop main can send the window to. preload.cjs rejects the rest. */
export type WindowDestination = { to: "evidence" } | { to: "today"; item: string };

/** Shows the window, then sends it to a destination its preload accepts. */
export function showDestination(
  open: () => void,
  contents: { isDestroyed(): boolean; send(channel: string, destination: WindowDestination): void },
  destination: WindowDestination,
) {
  open();
  if (!contents.isDestroyed()) contents.send(WINDOW_NAVIGATE_CHANNEL, destination);
}
