// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import type { PlaceTile } from "../../components/place/Place.js";
import { envelopesFor } from "../../store/evidence.js";
import { openHold } from "./hold.js";

/** The stop's tone from the Environment fact: failed or warning when read so, else nothing. */
export function holdTone(snapshot: Pick<ViewSnapshot, "briefing">): "warn" | "bad" | undefined {
  const fact = snapshot.briefing.facts.find(({ label }) => label === "Environment");
  const read = fact && fact.figure !== "?";
  return read && (fact.tone === "warn" || fact.tone === "bad") ? fact.tone : undefined;
}

/** Core sent the Held lane and no area feeding it went unread. */
export function heldLaneRead(
  snapshot: Pick<ViewSnapshot, "briefing" | "areas" | "provenance">,
): boolean {
  const index = snapshot.briefing.environment.lanes.findIndex(({ id }) => id === "holds");
  return (
    index >= 0 &&
    envelopesFor(snapshot, `/briefing/environment/lanes/${index}`).every(
      ({ envelope }) => envelope.state !== "unread",
    )
  );
}

/**
 * The place's lead tiles from core's environment facts: Maintenance while a hold is open, else the
 * Running fact, then the rest. Nothing, so the reading's own tiles stand, with no facts or no Held lane read.
 */
export function leadTiles(
  snapshot: Pick<ViewSnapshot, "briefing" | "areas" | "provenance">,
): PlaceTile[] | undefined {
  const { facts } = snapshot.briefing.environment;
  const [running, ...rest] = facts;
  if (!running || !heldLaneRead(snapshot)) return undefined;
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
          tone: holdTone(snapshot) ?? "neutral",
        }
      : tile(running),
    ...rest.map(tile),
  ];
}
