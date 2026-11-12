// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { RunStore } from "../store/store.js";

export function probeStore(
  store: Omit<RunStore, "close">,
  phase: string,
  id: string,
  reportPath: string,
): void {
  assert(phase === "write" || phase === "read", "Unknown smoke phase");
  const db = new DatabaseSync(":memory:");
  const sqliteIsTransaction = typeof db.isTransaction === "boolean";
  db.close();
  assert(sqliteIsTransaction, "utilityProcess needs DatabaseSync.isTransaction");
  if (phase === "write") {
    const at = new Date().toISOString();
    store.create({ id, kind: "smoke", title: "utilityProcess persistence", createdAt: at });
    store.appendEvent(id, { kind: "smoke", data: { durable: true } }, at);
  }
  assert.equal(store.get(id)?.title, "utilityProcess persistence");
  assert.deepEqual(
    store.listEvents(id, 0).map((event) => event.data),
    [{ durable: true }],
  );
  writeFileSync(
    reportPath,
    JSON.stringify({
      pid: process.pid,
      nodeVersion: process.versions.node,
      sqliteIsTransaction,
      rowSurvived: true,
    }),
  );
}
