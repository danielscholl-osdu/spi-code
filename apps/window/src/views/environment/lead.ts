// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Tone, ViewSnapshot } from "@spi-code/contracts";
import type { PlaceTile } from "../../components/place/Place.js";
import { openHold } from "./hold.js";

/** The stop's tone from the Environment fact, as Today's Stops the line reads it: neutral when unread. */
export function holdTone(snapshot: Pick<ViewSnapshot, "briefing">): Tone {
  const fact = snapshot.briefing.facts.find(({ label }) => label === "Environment");
  const read = fact && fact.figure !== "?";
  return read && (fact.tone === "warn" || fact.tone === "bad") ? fact.tone : "neutral";
}

/**
 * The place's lead tiles from core's environment facts: Maintenance while a hold is open, else the
 * Running fact, then the rest. Nothing, so the reading's own tiles stand, with no facts or no Held lane.
 */
export function leadTiles(snapshot: Pick<ViewSnapshot, "briefing">): PlaceTile[] | undefined {
  const { facts, lanes } = snapshot.briefing.environment;
  const [running, ...rest] = facts;
  if (!running || !lanes.some(({ id }) => id === "holds")) return undefined;
  const tile = ({ label, figure, sub, tone }: (typeof facts)[number]): PlaceTile => ({
    label,
    value: figure,
    counts: sub,
    tone,
  });
  const hold = openHold(snapshot);
  return [
    hold
      ? {
          label: "Maintenance",
          value: hold.label ?? "?",
          counts: `since ${hold.start}`,
          tone: holdTone(snapshot),
        }
      : tile(running),
    ...rest.map(tile),
  ];
}
