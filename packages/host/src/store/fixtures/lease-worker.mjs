// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { DatabaseSync } from "node:sqlite";
// Imports built output: run `tsc -b` (scripts/check does) before running this test alone.
import { createLeaseStore } from "../../../dist/store/leases.js";

const [path, owner] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA busy_timeout = 2000");
const leases = createLeaseStore(db);
process.on("message", ({ now }) => {
  process.send(leases.acquire("a", owner, 100, now) ?? null);
});
process.send("ready");
