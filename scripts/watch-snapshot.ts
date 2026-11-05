// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// Run after pnpm build: TZ=UTC bun scripts/watch-snapshot.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectWatch } from "../packages/host/src/watch/project";
import { fixtureInput, snapshotPath } from "../packages/host/src/watch/snapshot-fixture";

process.env.TZ = "UTC";
mkdirSync(dirname(snapshotPath), { recursive: true });
writeFileSync(snapshotPath, `${JSON.stringify(projectWatch(fixtureInput()), null, 2)}\n`);
