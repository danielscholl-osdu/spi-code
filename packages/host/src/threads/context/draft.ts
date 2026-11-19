// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  CHIP_TOKEN_BUDGET,
  type ChipOutcome,
  type PackedChip,
  packChip,
  type Refusal,
} from "./chip.js";
import type { ModelRedactor, ThreadAttachment } from "./seams.js";
import type { LatestSweep } from "./sweep.js";
import { estimateTokens, type TokenEstimate } from "./tokens.js";

export const MAX_CHIPS = 8;
export const CHIP_ATTACHMENT_PREFIX = "context:";

const refuse = (reason: string): Refusal => ({ ok: false, reason });

/** Packs an id from the latest saved sweep; a refresh is the same read again. */
export async function chipFromSweep(
  latest: LatestSweep,
  id: string,
  redactor: ModelRedactor,
  estimate: TokenEstimate = estimateTokens,
): Promise<ChipOutcome> {
  const sweep = latest();
  if (!sweep) return refuse("No sweep has been saved.");
  const answer = await sweep.inspect(id);
  if (!answer) return refuse(`Nothing in the latest sweep has the id ${id}.`);
  return packChip(answer, sweep.view.sweptAt, redactor, estimate);
}

export function refreshChip(
  latest: LatestSweep,
  chip: PackedChip,
  redactor: ModelRedactor,
  estimate: TokenEstimate = estimateTokens,
): Promise<ChipOutcome> {
  return chipFromSweep(latest, chip.id, redactor, estimate);
}

/** A chip already on the draft is replaced in place; a ninth is refused. */
export function addChip(
  chips: readonly PackedChip[],
  chip: PackedChip,
): { readonly ok: true; readonly chips: readonly PackedChip[] } | Refusal {
  const at = chips.findIndex(({ id }) => id === chip.id);
  if (at >= 0)
    return { ok: true, chips: chips.map((entry, index) => (index === at ? chip : entry)) };
  if (chips.length >= MAX_CHIPS)
    return refuse(`A message carries at most ${MAX_CHIPS} context chips.`);
  return { ok: true, chips: [...chips, chip] };
}

/** What a sent message keeps: each chip's payload as it was packed, never re-read. */
export function snapshotChips(
  chips: readonly PackedChip[],
  estimate: TokenEstimate = estimateTokens,
): { readonly ok: true; readonly attachments: ThreadAttachment[] } | Refusal {
  if (chips.length > MAX_CHIPS)
    return refuse(`A message carries at most ${MAX_CHIPS} context chips.`);
  if (new Set(chips.map(({ id }) => id)).size !== chips.length) {
    return refuse("A context chip repeats on this message.");
  }
  const over = chips.find(({ content }) => estimate(content) > CHIP_TOKEN_BUDGET);
  if (over) return refuse(`${over.id} is over ${CHIP_TOKEN_BUDGET} tokens.`);
  return {
    ok: true,
    attachments: chips.map(({ id, content }) => ({
      name: `${CHIP_ATTACHMENT_PREFIX}${id}`,
      content,
    })),
  };
}
