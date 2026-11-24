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

/** What acknowledging a shown cursor records as the seen baseline. */
export interface ShownRecord {
  items: unknown;
  observedAt: number | null;
}

/** A shown cursor acknowledges for this long after it was last shown; each fleet's newest always does. */
export const SHOWN_RETENTION_MS = 24 * 60 * 60 * 1000;

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

/**
 * One snapshot per fleet, replaced by each write; AUTOINCREMENT keeps cursors rising.
 * Uses a migrated connection configured for WAL, synchronous=FULL and a writer-lock timeout.
 */
export function createSnapshotStore(db: DatabaseSync) {
  const currentLease = db.prepare(`
    SELECT 1 FROM leases WHERE fleet = ? AND owner = ? AND fence = ? AND expires_at > ?
  `);
  const replace = db.prepare("DELETE FROM facts_snapshots WHERE fleet = ?");
  const insert = db.prepare(`
    INSERT INTO facts_snapshots (fleet, at, facts, envelope, fence) VALUES (?, ?, ?, ?, ?)
  `);
  const latest = db.prepare(
    "SELECT * FROM facts_snapshots WHERE fleet = ? ORDER BY cursor DESC LIMIT 1",
  );
  const since = db.prepare("SELECT * FROM facts_snapshots WHERE cursor > ? ORDER BY cursor");
  const show = db.prepare(`
    INSERT INTO snapshots_shown (fleet, cursor, items, observed_at, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (fleet, cursor) DO UPDATE SET items = excluded.items,
      observed_at = excluded.observed_at, at = MAX(at, excluded.at)
  `);
  const forget = db.prepare(`
    DELETE FROM snapshots_shown WHERE fleet = ? AND at < ?
      AND cursor < (SELECT MAX(cursor) FROM snapshots_shown WHERE fleet = ?)
  `);
  const shown = db.prepare(`
    SELECT items, observed_at FROM snapshots_shown WHERE fleet = ? AND cursor = ?
      AND (at >= ? OR cursor = (SELECT MAX(cursor) FROM snapshots_shown WHERE fleet = ?))
  `);
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
        replace.run(lease.fleet);
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
    /** Keeps what acknowledging `cursor` needs once a later sweep has replaced its snapshot. */
    recordShown(fleet: string, cursor: number, record: ShownRecord, at: number): void {
      if (!Number.isSafeInteger(cursor) || cursor <= 0) {
        throw new RangeError("Shown cursor must be a positive safe integer");
      }
      const cutoff = at - SHOWN_RETENTION_MS;
      if (!Number.isSafeInteger(at) || !Number.isSafeInteger(cutoff)) {
        throw new RangeError("Shown time must be safe integer epoch milliseconds");
      }
      const { observedAt } = record;
      if (observedAt !== null && !Number.isSafeInteger(observedAt)) {
        throw new RangeError("Shown observation must be safe milliseconds");
      }
      const items = encode(record.items);
      db.exec("BEGIN IMMEDIATE");
      try {
        show.run(fleet, cursor, items, observedAt, at);
        forget.run(fleet, cutoff, fleet);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    /** Undefined for a cursor never shown, or shown before the retention window and since superseded. */
    shownAt(fleet: string, cursor: number, now: number): ShownRecord | undefined {
      if (!Number.isSafeInteger(cursor) || cursor <= 0) return undefined;
      const cutoff = now - SHOWN_RETENTION_MS;
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(cutoff)) return undefined;
      const row = shown.get(fleet, cursor, cutoff, fleet) as
        | { items: string; observed_at: number | null }
        | undefined;
      return row === undefined
        ? undefined
        : { items: JSON.parse(row.items), observedAt: row.observed_at };
    },
  };
}
