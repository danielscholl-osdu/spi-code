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
  /** When the acknowledged snapshot's runs were read; absent when unknown. */
  readonly observedAt?: string;
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

/**
 * The ids in `itemIds` whose items arrived since the baseline, of any tier: absent from it, or
 * reaching an id the acknowledged item did not. Without a baseline nothing can be told new.
 */
export function freshIds(
  baseline: SeenBaseline | undefined,
  itemIds: readonly string[],
  briefing: Pick<WatchBriefing, "focus" | "rest">,
): string[] {
  if (!baseline) return [];
  const items = baselineItems(briefing);
  return itemIds.filter((id) => {
    const item = items.find((entry) => entry.id === id);
    if (!item) return false;
    const prior = priorOf(item, baseline.items);
    return prior === undefined || idsOf(item).some((ref) => !idsOf(prior).includes(ref));
  });
}

/**
 * Where the since pips start: the earlier of the acknowledgement and its snapshot's runs read, so
 * runs that finished before the operator looked but after that read are not dropped. Without a
 * known observation it is the acknowledgement alone.
 */
export function sinceStart(baseline: SeenBaseline | undefined): string | undefined {
  if (baseline?.at === undefined) return undefined;
  const at = Date.parse(baseline.at);
  const observed = baseline.observedAt === undefined ? Number.NaN : Date.parse(baseline.observedAt);
  if (Number.isNaN(at) || Number.isNaN(observed) || observed >= at) return baseline.at;
  return baseline.observedAt;
}

export function seenState(_model: Model, input: WatchInput, briefing: WatchBriefing): SeenState {
  return seenSince(input.baseline, briefing);
}
