// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** Stack lanes do not stop a fork's line. */
export function isStoppedFork(stations: readonly { id: string; substate: string }[]): boolean {
  return stations.some(({ id, substate }) => id !== "lane" && substate === "stopped");
}
