// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
// Imports built output: run `tsc -b` (scripts/check does) before running this test alone.
import { createLeaseStore } from "../../../dist/store/leases.js";
import { openStore } from "../../../dist/store/open.js";

const [path, owner] = process.argv.slice(2);
const db = openStore(path);
assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
assert.equal(db.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);
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
