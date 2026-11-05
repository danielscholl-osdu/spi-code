// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { DatabaseSync } from "node:sqlite";
import type { LeaseIdentity } from "./leases.js";

export interface SnapshotRecord {
  cursor: number;
  fleet: string;
  at: number;
  facts: unknown;
  envelope: unknown;
  fence: number;
}

type SnapshotRow = Omit<SnapshotRecord, "facts" | "envelope"> & {
  facts: string;
  envelope: string;
};

function decode(row: SnapshotRow): SnapshotRecord {
  return { ...row, facts: JSON.parse(row.facts), envelope: JSON.parse(row.envelope) };
}

function encode(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Snapshot data must be JSON-serializable");
  return json;
}

/** Uses a migrated connection configured for WAL, synchronous=FULL and a writer-lock timeout. */
export function createSnapshotStore(db: DatabaseSync) {
  const currentLease = db.prepare(`
    SELECT 1 FROM leases WHERE fleet = ? AND owner = ? AND fence = ? AND expires_at > ?
  `);
  const insert = db.prepare(`
    INSERT INTO facts_snapshots (fleet, at, facts, envelope, fence) VALUES (?, ?, ?, ?, ?)
  `);
  const latest = db.prepare(
    "SELECT * FROM facts_snapshots WHERE fleet = ? ORDER BY cursor DESC LIMIT 1",
  );
  const since = db.prepare("SELECT * FROM facts_snapshots WHERE cursor > ? ORDER BY cursor");
  return {
    writeSnapshot(
      lease: LeaseIdentity,
      facts: unknown,
      envelope: unknown,
      clock: number | (() => number),
    ): number {
      const factsJson = encode(facts);
      const envelopeJson = encode(envelope);
      db.exec("BEGIN IMMEDIATE");
      try {
        const now = typeof clock === "function" ? clock() : clock;
        if (!Number.isSafeInteger(now))
          throw new RangeError("Snapshot clock must be safe integer milliseconds");
        if (!currentLease.get(lease.fleet, lease.owner, lease.fence, now)) {
          throw new Error("Stale lease: snapshot write refused");
        }
        const cursor = Number(
          insert.run(lease.fleet, now, factsJson, envelopeJson, lease.fence).lastInsertRowid,
        );
        if (!Number.isSafeInteger(cursor)) throw new RangeError("Snapshot cursor exhausted");
        db.exec("COMMIT");
        return cursor;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    latestSnapshot(fleet: string): SnapshotRecord | undefined {
      const row = latest.get(fleet) as SnapshotRow | undefined;
      return row === undefined ? undefined : decode(row);
    },
    snapshotsSince(cursor: number): SnapshotRecord[] {
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new RangeError("Cursor must be a non-negative safe integer");
      }
      return (since.all(cursor) as SnapshotRow[]).map(decode);
    },
  };
}
