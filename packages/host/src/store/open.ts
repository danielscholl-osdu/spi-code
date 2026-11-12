// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.js";

/** Opens and migrates the shared host connection. The caller closes it after all stores stop. */
export function openStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON");
    const journalMode = db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
    if (journalMode !== "wal") {
      throw new Error(`SQLite WAL mode required; received ${journalMode}`);
    }
    db.exec("PRAGMA synchronous = FULL");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
