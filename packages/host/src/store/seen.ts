// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { DatabaseSync } from "node:sqlite";

export interface SeenRecord {
  fleet: string;
  cursor: number;
  items: unknown;
  at: number;
}

type SeenRow = Omit<SeenRecord, "items"> & { items: string };

/** One acknowledged baseline per fleet; it only ever moves to a newer cursor. */
export function createSeenStore(db: DatabaseSync) {
  const select = db.prepare("SELECT fleet, cursor, items, at FROM seen_baselines WHERE fleet = ?");
  const upsert = db.prepare(`
    INSERT INTO seen_baselines (fleet, cursor, items, at) VALUES (?, ?, ?, ?)
    ON CONFLICT (fleet) DO UPDATE SET cursor = excluded.cursor, items = excluded.items, at = excluded.at
    WHERE excluded.cursor > seen_baselines.cursor
  `);
  return {
    baseline(fleet: string): SeenRecord | undefined {
      const row = select.get(fleet) as SeenRow | undefined;
      return row === undefined ? undefined : { ...row, items: JSON.parse(row.items) };
    },
    /** Returns false when a baseline at this cursor or a newer one is already stored. */
    acknowledge(fleet: string, cursor: number, items: unknown, at: number): boolean {
      if (!Number.isSafeInteger(cursor) || cursor <= 0) {
        throw new RangeError("Seen cursor must be a positive safe integer");
      }
      if (!Number.isSafeInteger(at)) throw new RangeError("Seen time must be safe milliseconds");
      const json = JSON.stringify(items);
      if (json === undefined) throw new TypeError("Seen items must be JSON-serializable");
      return upsert.run(fleet, cursor, json, at).changes > 0;
    },
  };
}
