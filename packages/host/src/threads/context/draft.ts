// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ThreadAttachment } from "@spi-code/threads";
import {
  CHIP_BYTE_BUDGET,
  type ChipOutcome,
  type PackedChip,
  packChip,
  packPlace,
  type Refusal,
} from "./chip.js";
import { readPlace, UNPACKED_PLACES } from "./places.js";
import type { SpiRedactor } from "./redaction.js";
import type { LatestSweep } from "./sweep.js";

export const MAX_CHIPS = 8;
export const CHIP_ATTACHMENT_PREFIX = "context:";

const refuse = (reason: string): Refusal => ({ ok: false, reason });

/** Packs a place or an id from the latest saved sweep; a refresh is the same read again. */
export async function chipFromSweep(
  latest: LatestSweep,
  id: string,
  redactor: SpiRedactor,
): Promise<ChipOutcome> {
  const sweep = latest();
  if (!sweep) return refuse("No sweep has been saved.");
  if (UNPACKED_PLACES.includes(id)) {
    return refuse(`${id} cannot be a chip yet: it packs with the scope that reads it.`);
  }
  const at = { sweptAt: sweep.view.sweptAt, reads: sweep.reads };
  const place = readPlace(sweep.view, id);
  if (place) return packPlace(id, place, at, redactor);
  const answer = await sweep.inspect(id);
  if (!answer) return refuse(`Nothing in the latest sweep has the id ${id}.`);
  return packChip(answer, at, redactor);
}

export function refreshChip(
  latest: LatestSweep,
  chip: PackedChip,
  redactor: SpiRedactor,
): Promise<ChipOutcome> {
  return chipFromSweep(latest, chip.id, redactor);
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
): { readonly ok: true; readonly attachments: ThreadAttachment[] } | Refusal {
  if (chips.length > MAX_CHIPS)
    return refuse(`A message carries at most ${MAX_CHIPS} context chips.`);
  if (new Set(chips.map(({ id }) => id)).size !== chips.length) {
    return refuse("A context chip repeats on this message.");
  }
  const over = chips.find(({ content }) => Buffer.byteLength(content) > CHIP_BYTE_BUDGET);
  if (over) return refuse(`${over.id} is over ${CHIP_BYTE_BUDGET} UTF-8 bytes.`);
  return {
    ok: true,
    attachments: chips.map(({ id, content }) => ({
      name: `${CHIP_ATTACHMENT_PREFIX}${id}`,
      content,
    })),
  };
}
