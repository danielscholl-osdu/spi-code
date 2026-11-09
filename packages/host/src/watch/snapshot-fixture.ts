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
  type ReadRecord,
  type ReleaseReads,
  type SweepReads,
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

export const recordedRoot = fileURLToPath(new URL("../../../core/test/fixtures/", import.meta.url));
export const recordedSnapshotPath = fileURLToPath(
  new URL("../../../../fixtures/watch/snapshot-1106.json", import.meta.url),
);
export const detailFeedPath = fileURLToPath(
  new URL("../../../../fixtures/watch/inspect-1106.json", import.meta.url),
);

export function oracle(name: string): unknown {
  return json(
    fileURLToPath(new URL(`../../../../fixtures/rib-59d6895/oracle/${name}.json`, import.meta.url)),
  );
}

function inferredReads(facts: Facts): SweepReads {
  return Object.fromEntries(
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
    reads: inferredReads(facts),
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

/** The 6 Nov sweep: no releases, the 59d6895 rollout (same as it recorded), its start as clock. */
export function recordedInput(): WatchInput {
  const facts: Facts = {
    ...emptyFacts(),
    ...json<Partial<Facts>>(join(recordedRoot, "upstream-1106.json")),
  };
  const { radar } = json<{ radar: ReadRecord[] }>(join(recordedRoot, "upstream-1106-reads.json"));
  const now = facts.sweep?.at;
  if (!now) throw new Error("Recorded sweep must carry its start time");
  const { rollout } = parseRollout(readFileSync(join(fixtureRoot, "rollout.json"), "utf8"));
  if (!rollout) throw new Error("Pinned rollout must parse");
  const context = createContext({
    fleet: fleetOf(builtInFleet(join(recordedRoot, "upstream-services.json"))),
    rollout,
    clock: { now: () => new Date(now) },
  });
  return {
    facts,
    releases: { releases: {}, created: {}, pins: {}, errors: {} },
    context,
    cursor: 1,
    appData: recordedRoot,
    doctor: { state: "clear", problems: [] },
    intervalMs: 300_000,
    reads: { ...inferredReads(facts), radar },
    releaseRecords: [],
  };
}

export const unreadSnapshotPath = fileURLToPath(
  new URL("../../../../fixtures/watch/snapshot-1106-unread.json", import.meta.url),
);

export const UNREAD_FORKS = ["workflow", "indexer-queue", "unit", "crs-catalog", "crs-conversion"];

/** The 6 Nov sweep with five forks' GitHub reads failed (HTTP 504) and nothing retained for them. */
export function unreadForksInput(): WatchInput {
  const input = recordedInput();
  const github = input.facts.github;
  const at = github.at;
  if (!github.data || !at) throw new Error("Recorded sweep must carry GitHub facts");
  const repos = input.context.fleet.forks
    .filter(({ id }) => UNREAD_FORKS.includes(id))
    .map(({ repo }) => repo);
  if (repos.length !== UNREAD_FORKS.length) throw new Error("Recorded fleet must hold the forks");
  return {
    ...input,
    facts: {
      ...input.facts,
      github: {
        ...github,
        data: {
          ...github.data,
          repos: Object.fromEntries(
            Object.entries(github.data.repos).filter(([repo]) => !repos.includes(repo)),
          ),
        },
      },
    },
    reads: {
      ...input.reads,
      github: [
        ...(input.reads.github ?? []),
        ...repos.map((repo) => ({
          source: "github",
          object: repo,
          observedAt: at,
          completeness: { kind: "complete" as const },
          failure: "HTTP 504: Gateway Timeout",
        })),
      ],
    },
  };
}
