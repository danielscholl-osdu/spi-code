// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { DatabaseSync } from "node:sqlite";
// Imports built output: run `tsc -b` (scripts/check does) before running this test alone.
import { createLeaseStore } from "../../../dist/store/leases.js";

const [path, owner] = process.argv.slice(2);
const db = new DatabaseSync(path);
const leases = createLeaseStore(db);
process.on("message", (request) => {
  if (request === "lock") {
    db.exec("BEGIN IMMEDIATE");
    process.send("locked");
  } else if (request === "commit") {
    setTimeout(() => {
      db.exec("COMMIT");
      process.send("committed");
    }, 2500);
  } else {
    process.send(leases.acquire("a", owner, request.ttl, request.now) ?? null);
  }
});
process.send("ready");
