// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AREAS,
  builtInFleet,
  createContext,
  emptyFacts,
  type Facts,
  fleetOf,
  parseRollout,
  type ReleaseReads,
} from "@spi-code/core";
import type { WatchInput } from "./project.js";

export const fixtureRoot = fileURLToPath(
  new URL("../../../core/test/fixtures/rib-59d6895/", import.meta.url),
);
export const snapshotPath = fileURLToPath(
  new URL("../../../../fixtures/watch/snapshot-59d6895.json", import.meta.url),
);

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}

export const mixedSnapshotPath = fileURLToPath(
  new URL("../../../../fixtures/watch/snapshot-mixed-59d6895.json", import.meta.url),
);

export function oracle(name: string): unknown {
  return json(
    fileURLToPath(new URL(`../../../../fixtures/rib-59d6895/oracle/${name}.json`, import.meta.url)),
  );
}

export function fixtureInput(): WatchInput {
  const { now } = json<{ now: string }>(join(fixtureRoot, "render.json"));
  const facts: Facts = { ...emptyFacts(), ...json<Facts>(join(fixtureRoot, "facts.json")) };
  const releases = json<ReleaseReads>(join(fixtureRoot, "releases.json"));
  const { rollout } = parseRollout(readFileSync(join(fixtureRoot, "rollout.json"), "utf8"));
  if (!rollout) throw new Error("Pinned rollout must parse");
  const context = createContext({
    fleet: fleetOf(builtInFleet(join(fixtureRoot, "services.json"))),
    rollout,
    clock: { now: () => new Date(now) },
  });
  return {
    facts,
    releases,
    context,
    cursor: 1,
    appData: fixtureRoot,
    doctor: { state: "clear", problems: [] },
    intervalMs: 300_000,
    reads: Object.fromEntries(
      AREAS.flatMap((area) => {
        const at = facts[area].at;
        return at
          ? [
              [
                area,
                [
                  {
                    source: area,
                    object: area,
                    observedAt: at,
                    completeness: { kind: "complete" },
                    inferred: true,
                  },
                ],
              ],
            ]
          : [];
      }),
    ),
    releaseRecords: releases.at
      ? [
          {
            source: "releases",
            object: "releases",
            observedAt: releases.at,
            completeness: { kind: "complete" },
            inferred: true,
          },
        ]
      : [],
  };
}

/** Lifecycle runs (deployability, maintenance) come only from inferred reads; peers are observed. */
export function mixedFixtureInput(): WatchInput {
  const input = fixtureInput();
  const reads = Object.fromEntries(
    Object.entries(input.reads).map(([area, records]) => [
      area,
      area === "lifecycle" ? records : records?.map(({ inferred: _inferred, ...record }) => record),
    ]),
  );
  const releaseRecords = input.releaseRecords.map(({ inferred: _inferred, ...record }) => record);
  const fork = input.context.fleet.forks.find(({ id }) => id === "entitlements");
  const github = reads.github?.[0];
  const history = releaseRecords[0];
  if (!fork || !github || !history) throw new Error("Pinned fixture must have entitlements reads");
  return {
    ...input,
    reads: { ...reads, github: [...(reads.github ?? []), { ...github, object: fork.repo }] },
    releaseRecords: [
      ...releaseRecords,
      { ...history, source: "github-releases", object: fork.repo },
    ],
  };
}
