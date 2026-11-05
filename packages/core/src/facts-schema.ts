// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { LIFECYCLE_WORKFLOWS, type LifecycleKind } from "./config.js";
import type { Facts } from "./facts.js";

// Facts in facts.ts is the source of truth. The top level is closed; nested
// objects drop keys the type does not name, so an older snapshot still loads.

const LIFECYCLE_KINDS = Object.keys(LIFECYCLE_WORKFLOWS) as [LifecycleKind, ...LifecycleKind[]];
const lifecycleKind = z.enum(LIFECYCLE_KINDS);
const severity = z.enum(["critical", "high", "medium", "low"]);
const strings = z.array(z.string());
const hunks = z.record(z.string(), strings);
const commitAt = z.object({ sha: z.string(), at: z.string() });

function measured<T extends z.ZodType>(data: T) {
  return z.object({
    at: z.string().optional(),
    data: data.optional(),
    error: z.string().optional(),
    errorAt: z.string().optional(),
  });
}

const checkFact = z.object({
  id: z.number(),
  name: z.string(),
  workflow: z.string().optional(),
  runId: z.number().optional(),
  status: z.string(),
  conclusion: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  url: z.string().optional(),
});

const prFact = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  draft: z.boolean(),
  head: z.string(),
  base: z.string(),
  headSha: z.string(),
  headMarker: z.string().optional(),
  mergeState: z.string().optional(),
  reviewDecision: z.string().optional(),
  author: z.string().optional(),
  authorApp: z.boolean().optional(),
  association: z.string().optional(),
  labels: strings,
  checks: z.array(checkFact),
});

const issueFact = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: z.string().optional(),
  association: z.string().optional(),
  bot: z.boolean().optional(),
  labels: strings,
  comments: z.number(),
  halt: z.string().optional(),
});

const pastPrFact = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  head: z.string(),
  base: z.string(),
  createdAt: z.string(),
  mergedAt: z.string().optional(),
  closedAt: z.string().optional(),
  author: z.string().optional(),
});

const pastIssueFact = z.object({
  number: z.number(),
  url: z.string(),
  createdAt: z.string(),
  closedAt: z.string().optional(),
  labels: strings,
});

const releaseFact = z.object({ tag: z.string(), at: z.string(), url: z.string() });

const deploymentFact = z.object({
  createdAt: z.string(),
  ref: z.string().optional(),
  sha: z.string().optional(),
  state: z.string().optional(),
  statusAt: z.string().optional(),
});

const declaration = z.object({
  stackVersion: z.string().optional(),
  location: z.string().optional(),
  profile: z.string().optional(),
  forks: strings,
});

const repoFact = z.object({
  repo: z.string(),
  url: z.string(),
  autoMergeAllowed: z.boolean().optional(),
  head: commitAt.optional(),
  release: releaseFact.optional(),
  marker: z.string().optional(),
  upstreamSha: commitAt.optional(),
  declaration: declaration.optional(),
  prs: z.array(prFact),
  issues: z.array(issueFact),
  openPrs: z.number().optional(),
  openIssues: z.number().optional(),
  deployments: z.array(deploymentFact),
  pastPrs: z.array(pastPrFact).optional(),
  pastIssues: z.array(pastIssueFact).optional(),
  releases: z.array(releaseFact).optional(),
  schedules: z.partialRecord(lifecycleKind, strings).optional(),
  syncCrons: strings.optional(),
});

const githubFacts = z.object({
  repos: z.record(z.string(), repoFact),
  planned: z.record(z.string(), z.boolean()),
  rate: z
    .object({ remaining: z.number(), resetAt: z.string(), cost: z.number().optional() })
    .optional(),
});

const runFact = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  branch: z.string().optional(),
  sha: z.string(),
  title: z.string(),
  url: z.string(),
  attempt: z.number(),
});

const outsidePr = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  association: z.string(),
  draft: z.boolean(),
  headSha: z.string(),
  files: strings,
  changedFiles: z.number(),
  additions: z.number(),
  deletions: z.number(),
});

const waitingRun = runFact.extend({ pr: outsidePr.nullable().optional() });

const stepFact = z.object({
  number: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

const jobDetail = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  url: z.string(),
  steps: z.array(stepFact),
  failedStep: z.string().optional(),
  reason: z.string().optional(),
  environment: strings.optional(),
  attempt: z.number().optional(),
});

const jobsByRun = z.record(z.string(), z.array(jobDetail));

const forkRuns = z.object({
  sync: z.array(runFact),
  template: z.array(runFact),
  cascade: z.array(runFact),
  main: z.array(runFact),
  mainRunJobs: jobsByRun.optional(),
  cascadeRunJobs: jobsByRun.optional(),
  integration: commitAt.optional(),
});

const lifecycleRun = runFact.extend({
  kind: lifecycleKind,
  jobs: z.array(jobDetail).optional(),
  target: z.string().optional(),
});

const upstreamFact = z.object({
  service: z.string(),
  head: z.object({ sha: z.string(), at: z.string(), url: z.string() }).optional(),
  synced: z.string().optional(),
  lag: z.number().optional(),
  commits: z.array(
    z.object({ sha: z.string(), title: z.string(), at: z.string(), url: z.string() }),
  ),
});

const templateChange = z.object({
  sha: z.string(),
  parent: z.string().optional(),
  title: z.string(),
  pr: z.number().optional(),
  url: z.string(),
  at: z.string(),
});

const templateCompare = z.object({
  marker: z.string(),
  head: z.string(),
  label: z.string(),
  aheadBy: z.number(),
  shas: strings,
  changes: z.array(templateChange),
});

const templateFacts = z.object({
  latestTag: z.string().optional(),
  mainAhead: z.number().optional(),
  compares: z.record(z.string(), templateCompare),
  targets: z.record(z.string(), z.string()).optional(),
  synced: z.object({ dirs: strings, files: strings }).optional(),
  files: z.record(z.string(), strings).optional(),
});

const authFacts = z.object({
  gh: z.object({ ok: z.boolean(), detail: z.string(), scopes: strings.optional() }),
  glab: z.object({ ok: z.boolean(), detail: z.string() }),
});

const diffFact = z.object({
  sha: z.string(),
  title: z.string(),
  at: z.string(),
  url: z.string(),
  paths: strings.optional(),
  hunks: hunks.optional(),
});

const mrFact = z.object({
  iid: z.number(),
  title: z.string(),
  author: z.string(),
  draft: z.boolean(),
  labels: strings,
  createdAt: z.string(),
  updatedAt: z.string(),
  headSha: z.string(),
  url: z.string(),
  pipeline: z.string().optional(),
  paths: strings.optional(),
  hunks: hunks.optional(),
});

const mergedMrFact = z.object({
  iid: z.number(),
  title: z.string(),
  url: z.string(),
  mergedAt: z.string(),
  headSha: z.string(),
  paths: strings.optional(),
  deleted: strings.optional(),
});

const libraryPins = z.object({
  osCoreCommon: z.string().optional(),
  coreLibAzure: z.string().optional(),
});

const forkPrFact = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(["open", "merged"]),
  refs: strings,
});

const radarFacts = z.object({
  services: z.record(
    z.string(),
    z.object({
      project: z.string(),
      mrs: z.array(mrFact),
      queued: z.array(diffFact),
      merged: z.array(mergedMrFact).optional(),
      forkPrs: z.array(forkPrFact).optional(),
      pins: z.object({ fork: libraryPins.optional(), upstream: libraryPins.optional() }).optional(),
    }),
  ),
  filters: z.record(z.string(), z.object({ sha: z.string(), text: z.string() })),
  removal: z
    .object({
      due: z.string().optional(),
      labels: z.record(z.string(), z.enum(["pending", "established"])),
    })
    .optional(),
  latest: libraryPins.optional(),
  portRead: z.object({ prs: z.number(), commits: z.number() }).optional(),
});

const dependencyAlertFact = z.object({
  number: z.number(),
  severity,
  package: z.string(),
  ecosystem: z.string(),
  manifest: z.string(),
  scope: z.enum(["runtime", "development"]).optional(),
  fixed: z.string().optional(),
  advisory: z.string(),
  cve: z.string().optional(),
  summary: z.string(),
  url: z.string(),
  createdAt: z.string(),
});

const codeAlertFact = z.object({
  number: z.number(),
  severity: severity.optional(),
  ruleSeverity: z.string().optional(),
  rule: z.string(),
  description: z.string(),
  tool: z.string(),
  path: z.string().optional(),
  url: z.string(),
  createdAt: z.string(),
});

const repoAlerts = z.object({
  dependabot: z.array(dependencyAlertFact).optional(),
  code: z.array(codeAlertFact).optional(),
});

const fleetFacts = z.object({
  forks: z
    .array(
      z.object({
        service: z.string(),
        repo: z.string(),
        canonicalSource: z.string().optional(),
      }),
    )
    .optional(),
  vars: z.record(
    z.string(),
    z.object({ upstreamUrl: z.string().optional(), syncMode: z.string().optional() }).nullable(),
  ),
  varsAt: z.string().optional(),
  rollout: z.string().nullable().optional(),
  rolloutFrom: z.string().optional(),
});

const schema = z.strictObject({
  fleet: measured(fleetFacts),
  github: measured(githubFacts),
  runs: measured(z.record(z.string(), forkRuns)),
  approvals: measured(z.record(z.string(), z.array(waitingRun))),
  lifecycle: measured(z.record(lifecycleKind, z.array(lifecycleRun))),
  details: measured(z.record(z.string(), jobDetail)),
  upstream: measured(z.record(z.string(), upstreamFact)),
  radar: measured(radarFacts),
  template: measured(templateFacts),
  auth: measured(authFacts),
  security: measured(z.record(z.string(), repoAlerts)),
  sweep: z
    .object({ at: z.string(), ms: z.number(), calls: z.number(), errors: z.number() })
    .optional(),
});

// Identical, not merely mutually assignable: an optional field added to one side fails typecheck.
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const drift: Same<z.infer<typeof schema>, Facts> = true;
void drift;

/** Validates a whole Facts value at the sweep's commit, replay and load boundaries. */
export const factsSchema: z.ZodType<Facts> = schema;
