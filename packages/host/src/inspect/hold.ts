// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type AreaEnvelope,
  type Briefing,
  type InspectResult,
  InspectResultSchema,
} from "@spi-code/contracts";
import { type CoreContext, stamp } from "@spi-code/core";
import { RUN_PREFIX } from "./prefixes.js";

type EnvEvent = Briefing["environment"]["lanes"][number]["events"][number];

/** States only the ends it can read: an open hold runs since its start, an unread end is left out. */
function heldWhen(hold: EnvEvent, now: Date, ctx: Pick<CoreContext, "timeStyle">): string {
  const start = stamp(hold.start, now, ctx);
  const end = stamp(hold.end, now, ctx);
  if (start && end) return `${start} to ${end}`;
  if (end) return `until ${end}`;
  if (!start) return "";
  return hold.end === undefined ? `since ${start}` : `from ${start}`;
}

/** A maintenance hold the Environment's Held lane draws, with the runs it overlaps. */
export function holdResult(
  id: string,
  hold: EnvEvent,
  briefing: Briefing,
  areas: readonly AreaEnvelope[],
  now: Date,
  ctx: Pick<CoreContext, "timeStyle">,
): InspectResult {
  const from = Date.parse(hold.start);
  const to = hold.end === undefined ? Number.POSITIVE_INFINITY : Date.parse(hold.end);
  const runs = briefing.environment.lanes
    .filter((lane) => lane.id !== "holds")
    .flatMap((lane) =>
      lane.events
        .filter((e) => {
          const start = Date.parse(e.start);
          const end = e.end === undefined ? Number.POSITIVE_INFINITY : Date.parse(e.end);
          return start <= to && end >= from;
        })
        .map((e) => ({
          text: `${lane.label} ${e.label}`,
          state: e.detail,
          inspect: e.inspect ?? `${RUN_PREFIX}${e.id}`,
        })),
    );
  return InspectResultSchema.parse({
    id,
    title: `Held ${hold.label}`,
    class: hold.end === undefined ? "GATE" : "READY",
    cause: `Held ${hold.label}`,
    effect: hold.detail,
    next: "",
    why: heldWhen(hold, now, ctx),
    evidence: [],
    related: runs,
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}
