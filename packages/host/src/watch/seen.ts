// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  AttentionTierSchema,
  type SeenState,
  type WatchBriefing,
  type WatchItem,
} from "@spi-code/contracts";
import type { Model } from "@spi-code/core";
import { z } from "zod";
import type { WatchInput } from "./project.js";

/** What the operator last acknowledged: the briefing items of the snapshot at `cursor`. */
export interface SeenBaseline {
  readonly cursor: number;
  /** When it was acknowledged; carried into `seen.at`. */
  readonly at?: string;
  readonly items: readonly SeenItem[];
}
export type SeenItem = Pick<WatchItem, "id" | "ids" | "rung" | "attention">;

const SeenItemsSchema = z.array(
  z.object({
    id: z.string(),
    ids: z.array(z.string()),
    rung: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    attention: AttentionTierSchema,
  }),
);

/** Reads stored baseline items back; anything not in the shape baselineItems writes is refused. */
export function parseSeenItems(value: unknown): SeenItem[] | undefined {
  const parsed = SeenItemsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function baselineItems(briefing: Pick<WatchBriefing, "focus" | "rest">): SeenItem[] {
  return [...briefing.focus, ...briefing.rest].map(({ id, ids, rung, attention }) => ({
    id,
    ids: [...ids],
    rung,
    attention,
  }));
}

const idsOf = (item: Pick<SeenItem, "id" | "ids">) => [item.id, ...item.ids];

function priorOf(item: SeenItem, previous: readonly SeenItem[]): SeenItem | undefined {
  const ids = new Set(idsOf(item));
  return (
    previous.find((p) => p.id === item.id) ??
    previous.find((p) => idsOf(p).some((id) => ids.has(id)))
  );
}

/**
 * The Interrupt items that arrived since the baseline: new, newly interrupting, a worse rung, or
 * spread to an id the acknowledged item did not reach. Without a baseline there is nothing to
 * compare, so `cursor` is null and `since` is empty; the window treats that as unacknowledged.
 */
export function seenSince(
  baseline: SeenBaseline | undefined,
  briefing: Pick<WatchBriefing, "focus" | "rest">,
): SeenState {
  if (!baseline) return { cursor: null, since: [] };
  const since = new Set<string>();
  for (const item of baselineItems(briefing)) {
    if (item.attention !== "interrupt") continue;
    const prior = priorOf(item, baseline.items);
    if (
      prior === undefined ||
      prior.attention !== "interrupt" ||
      item.rung < prior.rung ||
      idsOf(item).some((id) => !idsOf(prior).includes(id))
    ) {
      since.add(item.id);
    }
  }
  return {
    cursor: baseline.cursor,
    since: [...since],
    ...(baseline.at === undefined ? {} : { at: baseline.at }),
  };
}

export function seenState(_model: Model, input: WatchInput, briefing: WatchBriefing): SeenState {
  return seenSince(input.baseline, briefing);
}
