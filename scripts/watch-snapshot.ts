// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// Run after pnpm build: TZ=UTC bun scripts/watch-snapshot.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AREAS,
  builtInFleet,
  createContext,
  emptyFacts,
  factsSchema,
  fleetOf,
} from "../packages/core/src/index.js";
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

const facts = factsSchema.parse({
  ...emptyFacts(),
  ...JSON.parse(
    readFileSync(
      new URL("../packages/core/test/fixtures/upstream-1106.json", import.meta.url),
      "utf8",
    ),
  ),
});
if (!facts.sweep) throw new Error("The November 6 recording must have a sweep");
const now = new Date(facts.sweep.at);
const november = projectWatch({
  ...fixtureInput(),
  facts,
  cursor: 13,
  context: createContext({
    fleet: fleetOf(
      builtInFleet(
        fileURLToPath(
          new URL("../packages/core/test/fixtures/upstream-services.json", import.meta.url),
        ),
      ),
    ),
    clock: { now: () => now },
  }),
  releases: { releases: {}, created: {}, pins: {}, errors: {} },
  releaseRecords: [],
  reads: Object.fromEntries(
    AREAS.flatMap((area) => {
      const observedAt = facts[area].at;
      return observedAt
        ? [[area, [{ source: area, object: area, observedAt, completeness: { kind: "complete" } }]]]
        : [];
    }),
  ),
});
writeFileSync(
  new URL("../fixtures/watch/snapshot-1106.json", import.meta.url),
  `${JSON.stringify(november, null, 2)}\n`,
);
