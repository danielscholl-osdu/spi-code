// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { DatabaseSync } from "node:sqlite";
import type { JournalEntry, ThreadEvent } from "./types.js";

type Row = { thread_id: string; sequence: number; at: number; payload: string };

function decode(row: Row): ThreadEvent {
  return {
    ...(JSON.parse(row.payload) as JournalEntry),
    threadId: row.thread_id,
    sequence: row.sequence,
    at: row.at,
  };
}

export class ThreadJournal {
  private readonly insert;
  private readonly after;
  private readonly all;

  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_engine_journal (
        thread_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (thread_id, sequence)
      ) STRICT, WITHOUT ROWID
    `);
    this.insert = db.prepare(`
      INSERT INTO thread_engine_journal (thread_id, sequence, at, payload)
      SELECT ?, coalesce(max(sequence), 0) + 1, ?, ?
      FROM thread_engine_journal WHERE thread_id = ?
      RETURNING thread_id, sequence, at, payload
    `);
    this.after = db.prepare(`
      SELECT * FROM thread_engine_journal WHERE thread_id = ? AND sequence > ? ORDER BY sequence
    `);
    this.all = db.prepare("SELECT * FROM thread_engine_journal ORDER BY thread_id, sequence");
  }

  *load(): Iterable<{ id: string; decode(): ThreadEvent }> {
    for (const entry of this.all.iterate()) {
      const row = entry as Row;
      yield { id: row.thread_id, decode: () => decode(row) };
    }
  }

  since(id: string, sequence: number): ThreadEvent[] {
    return this.after.all(id, sequence).map((row) => decode(row as Row));
  }

  append(id: string, entries: readonly JournalEntry[]): ThreadEvent[] {
    const at = Date.now();
    const payloads = entries.map((entry) => JSON.stringify(entry));
    const [first] = payloads;
    if (first === undefined) return [];
    if (payloads.length === 1) return [this.write(id, at, first)];

    this.db.exec("SAVEPOINT thread_engine_append");
    try {
      const events = payloads.map((payload) => this.write(id, at, payload));
      this.db.exec("RELEASE thread_engine_append");
      return events;
    } catch (error) {
      this.db.exec("ROLLBACK TO thread_engine_append; RELEASE thread_engine_append");
      throw error;
    }
  }

  private write(id: string, at: number, payload: string): ThreadEvent {
    return decode(this.insert.get(id, at, payload, id) as Row);
  }
}
