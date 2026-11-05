// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const [path, at] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
const journalMode = db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
if (journalMode !== "wal") {
  throw new Error(`SQLite WAL mode required; received ${journalMode}`);
}
db.exec("PRAGMA synchronous = FULL");
const highestSeq = db.prepare(
  "SELECT COALESCE(MAX(seq), 0) AS seq FROM run_events WHERE run_id = ?",
);
const insertEvent = db.prepare(
  `INSERT INTO run_events (run_id, seq, kind, message, data_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
const updateRun = db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?");

for await (const command of createInterface({ input: process.stdin })) {
  if (command !== "append") throw new Error(`Unexpected command: ${command}`);
  db.exec("BEGIN IMMEDIATE");
  let seq;
  try {
    seq = Number(highestSeq.get("crash").seq) + 1;
    if (!Number.isSafeInteger(seq)) throw new RangeError("Run event sequence exhausted");
    insertEvent.run("crash", seq, "text", `event ${seq}`, null, at);
    updateRun.run(at, "crash");
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
  process.stdout.write(`committed ${seq}\n`);
}
