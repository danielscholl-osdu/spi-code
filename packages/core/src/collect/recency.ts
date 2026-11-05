// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";

export const usedAtSchema = z.iso.datetime({ offset: true }).optional();

// Evicts least recently used entries down to the cap. An entry with no usedAt
// predates recency tracking and counts as oldest. Entries the newest read
// stamped back the current facts, so they stay even when they alone exceed it.
export function evictLeastRecent(map: Record<string, { usedAt?: string }>, cap: number): void {
  const entries = Object.entries(map).map(([key, entry], index) => ({
    key, index, at: entry.usedAt === undefined ? -Infinity : Date.parse(entry.usedAt),
  }));
  const newest = entries.reduce((max, e) => Math.max(max, e.at), -Infinity);
  const candidates = entries
    .filter((e) => !Number.isFinite(newest) || e.at < newest)
    .sort((a, b) => a.at - b.at || a.index - b.index);
  for (const e of candidates.slice(0, Math.max(0, entries.length - cap))) delete map[e.key];
}
