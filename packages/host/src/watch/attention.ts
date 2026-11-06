// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type FocusItem,
  type ItemAttention,
  ItemAttentionSchema,
  type ViewSnapshot,
} from "@spi-code/contracts";
import {
  attentionOf,
  briefThemes,
  LEAD_TIME_MS,
  type Model,
  type OwnerState,
  type PriorAttention,
  type Theme,
} from "@spi-code/core";
import { z } from "zod";
import type { WatchInput } from "./project.js";

export interface AttentionInput {
  readonly leadTimeMs: number;
  readonly previous: readonly PriorAttention[];
  /** Theme ids in the previous projection; absent means every theme is new. */
  readonly previousThemes?: readonly string[];
  /** Owning thread state by item id. */
  readonly owners?: ReadonlyMap<string, OwnerState>;
  /** Item ids with a card waiting on a decision. */
  readonly cards?: ReadonlySet<string>;
}

const themesByModel = new WeakMap<Model, readonly Theme[]>();

function themesOf(model: Model, now: Date): readonly Theme[] {
  let themes = themesByModel.get(model);
  if (!themes) {
    themes = briefThemes(model, now);
    themesByModel.set(model, themes);
  }
  return themes;
}

export function itemAttention(
  item: FocusItem,
  model: Model,
  input: WatchInput,
  attention: AttentionInput = { leadTimeMs: LEAD_TIME_MS, previous: [] },
): ItemAttention {
  const now = input.context.clock.now();
  return attentionOf(item, model, {
    now,
    leadTimeMs: attention.leadTimeMs,
    previous: attention.previous,
    themes: themesOf(model, now),
    ...(attention.previousThemes ? { previousThemes: attention.previousThemes } : {}),
    ...(attention.owners ? { owners: attention.owners } : {}),
    ...(attention.cards ? { cards: attention.cards } : {}),
  });
}

const PriorSchema = z.object({
  id: z.string(),
  ids: z.array(z.string()),
  rung: z.number(),
  ...ItemAttentionSchema.pick({ attention: true, owned: true }).shape,
});

const PreviousViewSchema = z.object({
  briefing: z.object({
    focus: z.array(PriorSchema),
    rest: z.array(PriorSchema),
    themes: z.array(z.object({ id: z.string() })),
  }),
});

type Seen = Pick<AttentionInput, "previous" | "previousThemes">;

function seenOf(briefing: z.infer<typeof PreviousViewSchema>["briefing"]): Seen {
  const prior = ({ id, ids, rung, attention, owned }: PriorAttention): PriorAttention => ({
    id,
    ids,
    rung,
    attention,
    owned,
  });
  return {
    previous: [...briefing.focus.map(prior), ...briefing.rest.map(prior)],
    previousThemes: briefing.themes.map((t) => t.id),
  };
}

/** The items and themes of a stored view, or none when it predates the Watch snapshot. */
export function previousAttention(view: unknown): Seen {
  const parsed = PreviousViewSchema.safeParse(view);
  return parsed.success ? seenOf(parsed.data.briefing) : { previous: [] };
}

/** The items and themes of a view this host just projected. */
export function projectedAttention(view: Pick<ViewSnapshot, "briefing">): Seen {
  return seenOf(view.briefing);
}
