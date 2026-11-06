// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type FocusItem,
  type ItemAttention,
  type WatchItem,
  WatchItemSchema,
} from "@spi-code/contracts";
import {
  attentionOf,
  buildBriefing,
  LEAD_TIME_MS,
  type Model,
  type OwnerState,
  type Theme,
} from "@spi-code/core";
import { z } from "zod";
import type { WatchInput } from "./project.js";

export interface AttentionInput {
  readonly leadTimeMs: number;
  readonly previous: readonly WatchItem[];
  /** Theme ids in the previous projection; absent means every theme is new. */
  readonly previousThemes?: readonly string[];
  /** Owning thread state by item id. */
  readonly owners?: ReadonlyMap<string, OwnerState>;
  /** Item ids with a card waiting on a decision. */
  readonly cards?: ReadonlySet<string>;
}

const themesByModel = new WeakMap<Model, readonly Theme[]>();

function themesOf(model: Model, input: WatchInput, now: Date): readonly Theme[] {
  let themes = themesByModel.get(model);
  if (!themes) {
    themes = buildBriefing(model, input.doctor, now, input.context).themes;
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
    themes: themesOf(model, input, now),
    ...(attention.previousThemes ? { previousThemes: attention.previousThemes } : {}),
    ...(attention.owners ? { owners: attention.owners } : {}),
    ...(attention.cards ? { cards: attention.cards } : {}),
  });
}

const PreviousViewSchema = z.object({
  briefing: z.object({
    focus: z.array(WatchItemSchema),
    rest: z.array(WatchItemSchema),
    themes: z.array(z.object({ id: z.string() })),
  }),
});

/** The items and themes of a stored view, or none when it predates the Watch snapshot. */
export function previousAttention(
  view: unknown,
): Pick<AttentionInput, "previous" | "previousThemes"> {
  const parsed = PreviousViewSchema.safeParse(view);
  if (!parsed.success) return { previous: [] };
  const { focus, rest, themes } = parsed.data.briefing;
  return { previous: [...focus, ...rest], previousThemes: themes.map((t) => t.id) };
}
