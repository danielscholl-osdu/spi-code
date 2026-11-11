// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AREAS,
  builtInFleet,
  CORE_LIB_REPO,
  createContext,
  emptyFacts,
  type Facts,
  fleetOf,
  LEAD_TIME_MS,
  type PrFact,
  parseRollout,
  pinKey,
  type ReadRecord,
  type ReleaseReads,
  type RepoFact,
  type SweepReads,
  TEMPLATE_REPO,
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

export const unverifiedSnapshotPath = fileURLToPath(
  new URL("../../../../fixtures/watch/snapshot-1106-unverified.json", import.meta.url),
);

/**
 * The 6 Nov sweep with partition and legal merged onto osdu-spi main: partition's main run after
 * the merge is green, so it is verified; legal's failed, so it is on the revision, not verified.
 */
export function unverifiedForkInput(): WatchInput {
  const input = recordedInput();
  const { github, template, runs } = input.facts;
  const target = github.data?.repos[TEMPLATE_REPO]?.head;
  if (!target || !template.data) throw new Error("Recorded sweep must carry the template head");
  for (const [service, conclusion] of [
    ["partition", "success"],
    ["legal", "failure"],
  ] as const) {
    const name = input.context.fleet.forks.find(({ id }) => id === service)?.repo;
    const repo = name ? github.data?.repos[name] : undefined;
    const previous = repo?.marker ? template.data.compares[repo.marker] : undefined;
    const forkRuns = name ? runs.data?.[name] : undefined;
    const run = forkRuns?.main[0];
    if (!repo || !previous || !forkRuns || !run) throw new Error(`Recorded sweep lacks ${service}`);
    template.data.compares[target.sha] = {
      ...previous,
      marker: target.sha,
      aheadBy: 0,
      shas: [],
      changes: [],
    };
    repo.marker = target.sha;
    repo.prs = repo.prs.filter((pr) => !pr.head.startsWith("template-sync/"));
    repo.pastPrs = [
      {
        number: 999,
        title: "Template sync",
        url: `${repo.repo}/pull/999`,
        head: "template-sync/main",
        base: "main",
        createdAt: "2026-11-06T12:00:00Z",
        mergedAt: "2026-11-06T12:01:00Z",
      },
    ];
    forkRuns.main = [
      { ...run, status: "completed", conclusion, createdAt: "2026-11-06T12:02:00Z" },
    ];
  }
  return input;
}

export const calmSnapshotPath = fileURLToPath(
  new URL("../../../../fixtures/watch/snapshot-calm.json", import.meta.url),
);
export const busySnapshotPath = fileURLToPath(
  new URL("../../../../fixtures/watch/snapshot-busy.json", import.meta.url),
);
export const badSnapshotPath = fileURLToPath(
  new URL("../../../../fixtures/watch/snapshot-bad.json", import.meta.url),
);

const MORNING_AT = "2026-11-06T14:02:00.133Z";
const LAST_GOOD_GITHUB = "2026-11-06T13:52:00Z";
const TARGET = "7d269b5e84cb90daa7e07f41a0fb163e030ccfd4";
const OLD_MARKER = "5398e9339b7236baecdf7e8b82366041c137c0f7";

function morningRepo(input: WatchInput, service: string): RepoFact {
  const name = input.context.fleet.forks.find((fork) => fork.id === service)?.repo ?? service;
  const repo = input.facts.github.data?.repos[name];
  if (!repo) throw new Error(`Morning fixture lacks ${service}`);
  return repo;
}

function morningPr(repo: RepoFact, number: number, head: string, title: string): PrFact {
  repo.openPrs = (repo.openPrs ?? 0) + 1;
  return {
    repo: repo.repo,
    number,
    head,
    title,
    url: `${repo.url}/pull/${number}`,
    createdAt: "2026-11-05T12:00:00Z",
    updatedAt: "2026-11-06T12:00:00Z",
    draft: false,
    base: "main",
    headSha: `${number}`.padStart(40, "0"),
    reviewDecision: "REVIEW_REQUIRED",
    labels: [],
    checks: [
      {
        id: number * 100,
        name: "Java Build",
        workflow: "Validation",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
    ],
  };
}

/** A fully read synthetic sweep built from the Nov 6 fleet and lifecycle history. */
function morningInput(adopted: number): WatchInput {
  const input = recordedInput();
  const facts = input.facts;
  for (const area of AREAS) {
    facts[area].at = MORNING_AT;
    delete facts[area].error;
    delete facts[area].errorAt;
  }
  facts.approvals.data = {};
  facts.details.data = {};
  facts.security.data = {};
  facts.radar.data = { services: {}, filters: {} };
  facts.upstream.data = {};
  facts.template.data = {
    latestTag: "v1.4.0",
    mainAhead: 1,
    compares: {
      [TARGET]: { marker: TARGET, head: TARGET, label: "main", aheadBy: 0, shas: [], changes: [] },
      [OLD_MARKER]: {
        marker: OLD_MARKER,
        head: TARGET,
        label: "v1.4.0",
        aheadBy: 1,
        shas: [TARGET],
        changes: [
          {
            sha: TARGET,
            title: "chore: refresh workflow pins",
            at: "2026-11-05T10:00:00Z",
            url: `https://github.com/${TEMPLATE_REPO}/commit/${TARGET}`,
          },
        ],
      },
    },
    targets: {},
    synced: { dirs: [".github"], files: [] },
  };
  for (const repo of Object.values(facts.github.data?.repos ?? {})) {
    repo.prs = [];
    repo.issues = [];
    repo.openPrs = 0;
    delete repo.openIssues;
    facts.security.data[repo.repo] = { dependabot: [], code: [] };
  }
  const template = morningRepo(input, TEMPLATE_REPO);
  template.head = { sha: TARGET, at: "2026-11-05T10:00:00Z" };
  for (const [index, fork] of input.context.fleet.forks.entries()) {
    const repo = morningRepo(input, fork.id);
    repo.marker = index < adopted ? TARGET : OLD_MARKER;
    repo.deployments = [{ createdAt: "2026-11-06T11:00:00Z", state: "SUCCESS" }];
    if (index >= adopted) {
      const pr = morningPr(
        repo,
        500 + index,
        "template-sync/morning",
        "chore: sync template workflow pins",
      );
      pr.headMarker = TARGET;
      repo.prs.push(pr);
    }
    const runs = facts.runs.data?.[fork.repo];
    if (!runs) throw new Error(`Morning fixture lacks runs for ${fork.id}`);
    for (const workflow of ["sync", "template", "cascade", "main"] as const) {
      runs[workflow] = runs[workflow].slice(0, 1).map((run) => ({
        ...run,
        status: "completed",
        conclusion: "success",
        createdAt: "2026-11-06T12:00:00Z",
        updatedAt: "2026-11-06T12:10:00Z",
      }));
    }
    const main = runs.main[0];
    runs.mainRunJobs = main
      ? {
          [main.id]: [
            {
              id: main.id,
              name: "Java Build",
              status: "completed",
              conclusion: "success",
              url: main.url,
              steps: [],
            },
          ],
        }
      : {};
    runs.cascadeRunJobs = {};
    facts.security.data[fork.repo] = { dependabot: [], code: [] };
    facts.upstream.data[fork.id] = { service: fork.id, lag: 0, commits: [] };
    facts.radar.data.services[fork.id] = {
      project: fork.upstream,
      mrs: [],
      queued: [],
      merged: [],
      forkPrs: [],
      pins: {
        fork: { osCoreCommon: "8.4.0", coreLibAzure: "4.0.0" },
        upstream: { osCoreCommon: "8.4.0" },
      },
    };
    facts.radar.data.filters[fork.id] = {
      sha: TARGET,
      text: `service: ${fork.id}\ntop_level:\n  pom.xml: keep\n  README.md: keep\ntesting: {}\nprofiles: {}\nfossa_modules: {}\n`,
    };
  }
  const releases: ReleaseReads = {
    at: MORNING_AT,
    releases: {
      [CORE_LIB_REPO]: [{ tag: "v5.0.0", at: "2026-11-05T10:00:00Z", body: "" }],
    },
    created: { [CORE_LIB_REPO]: "2026-01-01T00:00:00Z" },
    pins: {},
    errors: {},
  };
  for (const repo of Object.values(facts.github.data?.repos ?? {})) {
    const release = repo.release;
    if (release) {
      releases.releases[repo.repo] = [{ ...release, body: "" }];
      releases.created[repo.repo] = "2026-01-01T00:00:00Z";
    }
  }
  const read = (source: string, object: string): ReadRecord => ({
    source,
    object,
    observedAt: MORNING_AT,
    completeness: { kind: "complete" },
  });
  return {
    ...input,
    releases,
    reads: {
      ...Object.fromEntries(AREAS.map((area) => [area, [read(area, area)]])),
      github: Object.keys(facts.github.data?.repos ?? {}).map((repo) => read("github", repo)),
      upstream: input.context.fleet.forks.map((fork) =>
        read(fork.upstream, "repository/branches/master"),
      ),
    },
    releaseRecords: [
      {
        source: "releases",
        object: "releases",
        observedAt: MORNING_AT,
        completeness: { kind: "complete" },
      },
    ],
  };
}

function queuedChange(input: WatchInput, service: string, value?: string) {
  const upstream = input.facts.upstream.data?.[service];
  const radar = input.facts.radar.data?.services[service];
  if (!upstream || !radar) throw new Error(`Morning fixture lacks radar for ${service}`);
  const commit = {
    sha: (input.context.fleet.forks.findIndex((fork) => fork.id === service) + 1)
      .toString(16)
      .padStart(40, "0"),
    title: value ? `build: adopt ${value}` : "docs: refresh guidance",
    at: "2026-11-06T13:00:00Z",
    url: `https://example.com/upstream/${service}/commit/morning`,
  };
  upstream.lag = 1;
  upstream.commits = [commit];
  radar.queued = [
    {
      ...commit,
      paths:
        value === "schemathesis-tests"
          ? ["schemathesis-tests/pom.xml"]
          : [value ? "pom.xml" : "README.md"],
      ...(value && value !== "schemathesis-tests"
        ? {
            hunks: {
              "pom.xml": [
                value.startsWith("Java")
                  ? "+<java.version>25</java.version>"
                  : `+<os-core-common.version>${value.split(" ")[1]}</os-core-common.version>`,
              ],
            },
          }
        : {}),
    },
  ];
}

/** No urgent work; two forks have ordinary commits queued, and the rollout is finishing. */
export function calmInput(): WatchInput {
  const input: WatchInput = {
    ...morningInput(11),
    attention: {
      leadTimeMs: LEAD_TIME_MS,
      previous: [{ id: "rollout", ids: ["rollout"], rung: 1, attention: "ambient", owned: false }],
    },
  };
  const template = morningRepo(input, TEMPLATE_REPO);
  template.issues.push({
    repo: template.repo,
    number: 800,
    title: "Document the nightly workflow schedule",
    url: `${template.url}/issues/800`,
    createdAt: "2026-11-01T12:00:00Z",
    updatedAt: "2026-11-01T12:00:00Z",
    labels: ["documentation"],
    comments: 0,
  });
  queuedChange(input, "partition");
  queuedChange(input, "schema");
  return input;
}

function failedPr(input: WatchInput, service: string, number: number, check: string, step: string) {
  const repo = morningRepo(input, service);
  const pr = morningPr(repo, number, "release/upstream-morning", "chore: release/upstream morning");
  const id = number * 100;
  const url = `${repo.url}/actions/runs/${number}/job/${id}`;
  pr.checks = [
    {
      id,
      runId: number,
      name: check,
      workflow: "Validation",
      status: "COMPLETED",
      conclusion: "FAILURE",
      completedAt: "2026-11-06T03:00:00Z",
      url,
    },
  ];
  const detail = {
    id,
    name: check,
    status: "completed",
    conclusion: "failure",
    url,
    failedStep: step,
    reason:
      check === "Deploy and Test"
        ? "The shared environment is draining"
        : "Compilation failed in the synthetic morning build",
    steps: [],
  };
  if (!input.facts.details.data) throw new Error("Morning fixture lacks details");
  input.facts.details.data[`${repo.repo}#${id}`] = detail;
  repo.prs.push(pr);
  return pr;
}

/** Seven upstream decisions in four themes, releases and alerts across a fully read fleet. */
export function busyInput(): WatchInput {
  const input = morningInput(7);
  for (const [service, value] of [
    ["indexer", "os-core-common 8.5.0"],
    ["workflow", "os-core-common 8.5.0"],
    ["unit", "os-core-common 8.5.0"],
    ["legal", "schemathesis-tests"],
    ["storage", "Java 25"],
    ["crs-conversion", "Java 25"],
    ["partition", "os-core-common 10.0.0"],
  ] as const)
    queuedChange(input, service, value);
  for (const [index, fork] of input.context.fleet.forks.entries()) {
    const repo = morningRepo(input, fork.id);
    const release = input.releases.releases[fork.repo]?.[0];
    if (!release) throw new Error(`Morning fixture lacks release for ${fork.id}`);
    input.releases.pins[pinKey(fork.repo, release.tag)] = {
      lib: index < 2 ? "5.0.0" : index < 6 ? "4.0.0" : index < 12 ? "3.0.1" : "2.5.10",
      java: "21",
    };
    if (index < 8)
      repo.prs.push(
        morningPr(repo, 600 + index, "release-please--branches--main", "chore: release 1.5.0"),
      );
    if (!input.facts.security.data) throw new Error("Morning fixture lacks security");
    input.facts.security.data[fork.repo] = {
      dependabot: (["high", "critical"] as const).map((severity, n) => ({
        number: n + 1,
        severity,
        package: "fixture-library",
        ecosystem: "maven",
        manifest: `provider/${fork.id}-azure/pom.xml`,
        advisory: `GHSA-fixture-${n}`,
        summary: "Synthetic dependency finding",
        url: `${repo.url}/security/dependabot/${n + 1}`,
        createdAt: "2026-11-05T12:00:00Z",
      })),
      code: [],
    };
  }
  const template = morningRepo(input, TEMPLATE_REPO);
  template.prs.push(
    morningPr(template, 263, "release-please--branches--main", "chore: release 1.5.0"),
  );
  for (const [index, service] of ["indexer", "workflow", "unit"].entries()) {
    const repo = morningRepo(input, service);
    repo.prs.push({
      ...morningPr(repo, 58 + index, "sync/upstream-morning", "build: absorb os-core-common 8.5.0"),
      headAt: "2026-11-06T12:05:00Z",
    });
  }
  const schema = morningRepo(input, "schema");
  schema.issues.push({
    repo: schema.repo,
    number: 700,
    title: "Label Configuration Update Required",
    url: `${schema.url}/issues/700`,
    createdAt: MORNING_AT,
    updatedAt: MORNING_AT,
    labels: [],
    comments: 0,
  });
  const storage = input.facts.runs.data?.[morningRepo(input, "storage").repo]?.sync[0];
  if (!storage) throw new Error("Morning fixture lacks storage sync");
  storage.conclusion = "failure";
  failedPr(input, "indexer-queue", 67, "Deploy and Test", "Verify");
  return {
    ...input,
    attention: {
      leadTimeMs: LEAD_TIME_MS,
      previous: ["gate1:indexer", "gate1:workflow", "gate1:unit", "gate2:indexer-queue"].map(
        (id) => ({ id, ids: [id], rung: 1, attention: "ambient", owned: false }),
      ),
    },
  };
}

/** Retained GitHub figures with a new failed read; the other areas still read successfully. */
export function badInput(): WatchInput {
  const input = busyInput();
  failedPr(input, "entitlements", 121, "Java Build", "Build");
  const legalPr = failedPr(input, "legal", 701, "Java Build", "Build");
  legalPr.head = "sync/upstream-morning";
  const github = input.facts.github;
  github.at = LAST_GOOD_GITHUB;
  github.error = "HTTP 504: Gateway Timeout";
  github.errorAt = MORNING_AT;
  return {
    ...input,
    reads: {
      ...input.reads,
      github: [
        {
          source: "github",
          object: "github",
          observedAt: LAST_GOOD_GITHUB,
          completeness: { kind: "complete" },
        },
        {
          source: "github",
          object: "github",
          observedAt: MORNING_AT,
          completeness: { kind: "complete" },
          failure: github.error,
        },
      ],
    },
    attention: {
      ...input.attention,
      leadTimeMs: LEAD_TIME_MS,
      previous: input.attention?.previous ?? [],
      cards: new Set(["gate2:entitlements", "gate1:legal"]),
    },
  };
}
