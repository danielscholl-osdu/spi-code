// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// Run after pnpm build: TZ=UTC bun scripts/watch-snapshot.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectWatch } from "../packages/host/src/watch/project.js";
import {
  fixtureInput,
  mixedFixtureInput,
  mixedSnapshotPath,
  snapshotPath,
} from "../packages/host/src/watch/snapshot-fixture.js";

process.env.TZ = "UTC";
mkdirSync(dirname(snapshotPath), { recursive: true });
for (const [path, input] of [
  [snapshotPath, fixtureInput()],
  [mixedSnapshotPath, mixedFixtureInput()],
] as const) {
  writeFileSync(path, `${JSON.stringify(projectWatch(input), null, 2)}\n`);
}
