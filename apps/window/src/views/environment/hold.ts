// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";

/** The environment's open maintenance hold, as the Held lane core sends it. */
export type OpenHold = {
  /** The hold's length so far, as core words it; absent when core could not word it. */
  label?: string;
  start: string;
  /** The item the hold folds into, when core names one. */
  inspect?: string;
};

/** The one open hold in the Held lane, or nothing when the lane holds none. */
export function openHold(snapshot: Pick<ViewSnapshot, "briefing">): OpenHold | undefined {
  const lane = snapshot.briefing.environment.lanes.find(({ id }) => id === "holds");
  const event = lane?.events.find(({ end, state }) => end === undefined && state === "held");
  if (!event) return undefined;
  const label = event.label.trim();
  return {
    ...(label && label !== "?" ? { label } : {}),
    start: event.start,
    ...(event.inspect ? { inspect: event.inspect } : {}),
  };
}
