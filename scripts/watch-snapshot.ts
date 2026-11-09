// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// pnpm build && TZ=UTC bun scripts/watch-snapshot.ts && pnpm biome check --write
// Biome formats the five snapshots and the Detail feed back to their checked-in bytes.
import { execFileSync } from "node:child_process";
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
  unreadForksInput,
  unreadSnapshotPath,
  unverifiedForkInput,
  unverifiedSnapshotPath,
} from "../packages/host/src/watch/snapshot-fixture.js";

process.env.TZ = "UTC";
mkdirSync(dirname(snapshotPath), { recursive: true });
for (const [path, input] of [
  [snapshotPath, fixtureInput()],
  [mixedSnapshotPath, mixedFixtureInput()],
  [recordedSnapshotPath, recordedInput()],
  [unreadSnapshotPath, unreadForksInput()],
  [unverifiedSnapshotPath, unverifiedForkInput()],
] as const) {
  writeFileSync(path, `${JSON.stringify(projectWatch(input), null, 2)}\n`);
}

// The Detail feed comes from the offline router over a node:sqlite store, which Bun lacks, so
// Node runs the built detail-feed.js that parity.test.ts asks through.
const detailFeed = new URL("../packages/host/dist/watch/detail-feed.js", import.meta.url).href;
execFileSync(
  "node",
  [
    "--no-warnings",
    "--input-type=module",
    "-e",
    `const { writeDetailFeed } = await import(${JSON.stringify(detailFeed)}); await writeDetailFeed();`,
  ],
  { stdio: "inherit", env: { ...process.env, TZ: "UTC" } },
);
