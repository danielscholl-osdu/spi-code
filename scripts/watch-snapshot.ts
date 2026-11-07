// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// pnpm build && TZ=UTC bun scripts/watch-snapshot.ts && pnpm biome check --write
// Biome formats the three snapshots back to their checked-in bytes.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectWatch } from "../packages/host/src/watch/project.js";
import {
  fixtureInput,
  mixedFixtureInput,
  mixedSnapshotPath,
  recordedInput,
  recordedSnapshotPath,
  snapshotPath,
} from "../packages/host/src/watch/snapshot-fixture.js";

process.env.TZ = "UTC";
mkdirSync(dirname(snapshotPath), { recursive: true });
for (const [path, input] of [
  [snapshotPath, fixtureInput()],
  [mixedSnapshotPath, mixedFixtureInput()],
  [recordedSnapshotPath, recordedInput()],
] as const) {
  writeFileSync(path, `${JSON.stringify(projectWatch(input), null, 2)}\n`);
}
