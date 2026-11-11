// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { DatabaseSync } from "node:sqlite";

export interface SeenRecord {
  fleet: string;
  cursor: number;
  items: unknown;
  at: number;
  /** When the acknowledged snapshot's runs were read; null for a row stored before it was kept. */
  observedAt: number | null;
}

type SeenRow = Omit<SeenRecord, "items" | "observedAt"> & {
  items: string;
  observed_at: number | null;
};

/** One acknowledged baseline per fleet; it only ever moves to a newer cursor. */
export function createSeenStore(db: DatabaseSync) {
  const select = db.prepare(
    "SELECT fleet, cursor, items, at, observed_at FROM seen_baselines WHERE fleet = ?",
  );
  const upsert = db.prepare(`
    INSERT INTO seen_baselines (fleet, cursor, items, at, observed_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (fleet) DO UPDATE SET cursor = excluded.cursor, items = excluded.items,
      at = excluded.at, observed_at = excluded.observed_at
    WHERE excluded.cursor > seen_baselines.cursor
  `);
  return {
    baseline(fleet: string): SeenRecord | undefined {
      const row = select.get(fleet) as SeenRow | undefined;
      if (row === undefined) return undefined;
      const { observed_at, ...rest } = row;
      return { ...rest, items: JSON.parse(row.items), observedAt: observed_at };
    },
    /** Returns false when a baseline at this cursor or a newer one is already stored. */
    acknowledge(
      fleet: string,
      cursor: number,
      items: unknown,
      at: number,
      observedAt: number | null = null,
    ): boolean {
      if (!Number.isSafeInteger(cursor) || cursor <= 0) {
        throw new RangeError("Seen cursor must be a positive safe integer");
      }
      if (!Number.isSafeInteger(at)) throw new RangeError("Seen time must be safe milliseconds");
      if (observedAt !== null && !Number.isSafeInteger(observedAt)) {
        throw new RangeError("Seen observation must be safe milliseconds");
      }
      const json = JSON.stringify(items);
      if (json === undefined) throw new TypeError("Seen items must be JSON-serializable");
      return upsert.run(fleet, cursor, json, at, observedAt).changes > 0;
    },
  };
}
