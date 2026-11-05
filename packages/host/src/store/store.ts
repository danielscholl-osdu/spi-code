// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.js";

export interface CreateRunParams {
  id: string;
  kind: string;
  title?: string | null;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  kind: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppendRunEvent {
  kind: string;
  message?: string;
  data?: unknown;
}

export interface RunEventRecord {
  seq: number;
  kind: string;
  message: string | null;
  data: unknown;
  createdAt: string;
}

export interface RunStore {
  create(params: CreateRunParams): void;
  get(id: string): RunRecord | undefined;
  appendEvent(id: string, event: AppendRunEvent, at: string): number;
  listEvents(id: string, cursor: number, limit?: number): RunEventRecord[];
  lastSeq(id: string): number;
  close(): void;
}

type RunRow = {
  id: string;
  kind: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  seq: number;
  kind: string;
  message: string | null;
  data_json: string | null;
  created_at: string;
};

function encodeData(data: unknown): string | null {
  if (data === undefined) return null;
  const json = JSON.stringify(data);
  if (json === undefined) throw new TypeError("Event data must be JSON-serializable");
  return json;
}

export function openRunStore(path: string): RunStore {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    migrate(db);
    const insertRun = db.prepare(
      "INSERT INTO runs (id, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    const getRun = db.prepare("SELECT * FROM runs WHERE id = ?");
    const highestSeq = db.prepare(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM run_events WHERE run_id = ?",
    );
    const insertEvent = db.prepare(
      `INSERT INTO run_events (run_id, seq, kind, message, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const updateRun = db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?");
    const readEvents = db.prepare(
      `SELECT seq, kind, message, data_json, created_at FROM run_events
       WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    );
    let closed = false;

    return {
      create(params) {
        insertRun.run(
          params.id,
          params.kind,
          params.title ?? null,
          params.createdAt,
          params.createdAt,
        );
      },
      get(id) {
        const row = getRun.get(id) as RunRow | undefined;
        if (!row) return undefined;
        return {
          id: row.id,
          kind: row.kind,
          title: row.title,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      },
      appendEvent(id, event, at) {
        const data = encodeData(event.data);
        // Acquire the writer lock before reading MAX(seq), including across host connections.
        db.exec("BEGIN IMMEDIATE");
        try {
          const seq = Number(highestSeq.get(id)?.seq) + 1;
          if (!Number.isSafeInteger(seq)) throw new RangeError("Run event sequence exhausted");
          insertEvent.run(id, seq, event.kind, event.message ?? null, data, at);
          updateRun.run(at, id);
          db.exec("COMMIT");
          return seq;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
      listEvents(id, cursor, limit = 1000) {
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
          throw new RangeError("Cursor must be a non-negative safe integer");
        }
        if (!Number.isSafeInteger(limit) || limit <= 0) {
          throw new RangeError("Limit must be a positive safe integer");
        }
        return (readEvents.all(id, cursor, limit) as EventRow[]).map((row) => ({
          seq: row.seq,
          kind: row.kind,
          message: row.message,
          data: row.data_json === null ? null : JSON.parse(row.data_json),
          createdAt: row.created_at,
        }));
      },
      lastSeq(id) {
        return Number(highestSeq.get(id)?.seq);
      },
      close() {
        if (closed) return;
        db.close();
        closed = true;
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
