// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";

export type PinWord = { text: "stopped"; tone: "bad" } | { text: "waiting"; tone: "warn" };

/**
 * The one word a pinned service carries: only when every station on its line is read and one is
 * stopped or waiting on a person. Unread, empty or missing stations give none.
 */
export function pinWord(snapshot: ViewSnapshot | undefined, service: string): PinWord | undefined {
  const line =
    snapshot?.stations
      .find((row) => row.service === service)
      ?.stations.filter(({ id }) => id !== "lane") ?? [];
  if (line.some(({ state }) => state === "unknown")) return undefined;
  if (line.some(({ substate }) => substate === "stopped")) return { text: "stopped", tone: "bad" };
  if (line.some(({ substate }) => substate === "waiting-on-person"))
    return { text: "waiting", tone: "warn" };
  return undefined;
}
