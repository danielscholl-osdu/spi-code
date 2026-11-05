// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { DatabaseSync } from "node:sqlite";

export interface LeaseIdentity {
  fleet: string;
  owner: string;
  fence: number;
}

function expiry(ttl: number, now: number): number {
  if (
    !Number.isSafeInteger(ttl) ||
    ttl <= 0 ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(now + ttl)
  ) {
    throw new RangeError("Lease clock and positive ttl must be safe integer milliseconds");
  }
  return now + ttl;
}

/** Uses the caller's migrated SQLite connection; configure its writer-lock timeout before use. */
export function createLeaseStore(db: DatabaseSync) {
  const acquire = db.prepare(`
    INSERT INTO leases (fleet, owner, fence, expires_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(fleet) DO UPDATE SET
      owner = excluded.owner, fence = leases.fence + 1, expires_at = excluded.expires_at
    WHERE leases.owner IS NULL OR leases.expires_at <= ?
    RETURNING fence
  `);
  const renew = db.prepare(`
    UPDATE leases SET expires_at = ?
    WHERE fleet = ? AND owner = ? AND fence = ? AND expires_at > ?
  `);
  // Keep the row so release cannot reset the next owner's fencing counter.
  const release = db.prepare(`
    UPDATE leases SET owner = NULL, expires_at = 0 WHERE fleet = ? AND owner = ? AND fence = ?
  `);
  return {
    acquire(fleet: string, owner: string, ttl: number, now: number): number | undefined {
      const row = acquire.get(fleet, owner, expiry(ttl, now), now);
      return row === undefined ? undefined : Number(row.fence);
    },
    renew(fleet: string, owner: string, fence: number, ttl: number, now: number): boolean {
      return renew.run(expiry(ttl, now), fleet, owner, fence, now).changes === 1;
    },
    release(fleet: string, owner: string, fence: number): boolean {
      return release.run(fleet, owner, fence).changes === 1;
    },
  };
}
