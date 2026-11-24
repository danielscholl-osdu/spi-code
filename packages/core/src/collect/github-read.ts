// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  DECLARATION_PATH,
  LANE_ENVIRONMENT,
  LANE_DEPLOYMENT_PAGE,
  LIFECYCLE_WORKFLOWS,
  type LifecycleKind,
  MARKER_PATH,
  PAST_PR_PAGE,
  plannedRepo,
  SYNC_TEMPLATE_WORKFLOW,
  TEMPLATE_REPO,
} from "../config.js";
import type { CoreContext } from "../context.js";
import type { ReadCompleteness, ReadRecord } from "../evidence/index.js";
import { ForgeError, type Gh, type GqlError } from "../forge.js";
import { pool } from "../util.js";

const PULLS = `pullRequests(states: OPEN, first: 40, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes {
  number title url createdAt updatedAt isDraft headRefName baseRefName headRefOid mergeStateStatus reviewDecision
  author { __typename login } authorAssociation
  reviewRequests(first: 5) { totalCount nodes { requestedReviewer { ... on Actor { login } ... on Team { slug } ... on EnterpriseTeam { slug } } } }
  latestReviews(first: 5) { totalCount nodes { author { login } state } }
  headRef { target { ... on Commit { file(path: "${MARKER_PATH}") { object { ... on Blob { text } } } } } }
  labels(first: 15) { totalCount nodes { name } }
  commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { contexts(first: 80) { totalCount nodes {
    __typename
    ... on CheckRun { databaseId name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { databaseId workflow { name } } } }
  } } } } } }
} }`;

const ISSUES = `issues(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes {
  number title url createdAt updatedAt author { __typename login } authorAssociation
  labels(first: 15) { totalCount nodes { name } } comments { totalCount } body
} }`;

const PAST_PULLS = `pastPrs: pullRequests(states: [MERGED, CLOSED], first: ${PAST_PR_PAGE}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
  number title url createdAt updatedAt mergedAt closedAt headRefName baseRefName author { login }
} }`;

const CLOSED_ISSUES = `closedIssues: issues(states: CLOSED, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
  number title url createdAt updatedAt closedAt author { __typename login }
  labels(first: 15) { totalCount nodes { name } }
} }`;

const HALT_LABELS = Object.freeze(["sync-failed", "conflict", "cascade-blocked", "cascade-failed"]);
const PAST_ISSUES = `pastIssues: issues(states: CLOSED, first: 30, labels: ${JSON.stringify(HALT_LABELS)}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
  number url createdAt closedAt labels(first: 15) { totalCount nodes { name } }
} }`;

const LIFECYCLE_KINDS = Object.freeze(Object.keys(LIFECYCLE_WORKFLOWS) as LifecycleKind[]);
const WORKFLOW_FILES = LIFECYCLE_KINDS.map(
  (k) =>
    `wf_${k}: object(expression: "main:.github/workflows/${LIFECYCLE_WORKFLOWS[k]}") { ... on Blob { text } }`,
).join("\n  ");

const FRAGMENTS = `
fragment Base on Repository {
  nameWithOwner url autoMergeAllowed
  defaultBranchRef { target { ... on Commit { oid committedDate } } }
  latestRelease { tagName publishedAt url }
  ${PULLS}
  ${ISSUES}
}
fragment Template on Repository {
  ${PAST_PULLS}
  releases(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName publishedAt url isDraft } }
}
fragment Fork on Repository {
  syncTemplate: object(expression: "main:.github/workflows/${SYNC_TEMPLATE_WORKFLOW}") { ... on Blob { text } }
  marker: object(expression: "main:${MARKER_PATH}") { ... on Blob { text } }
  upstreamLog: ref(qualifiedName: "refs/heads/fork_upstream") { target { ... on Commit { history(first: 10) { nodes { oid message committedDate } } } } }
  deployments(environments: ["${LANE_ENVIRONMENT}"], first: ${LANE_DEPLOYMENT_PAGE}, orderBy: {field: CREATED_AT, direction: DESC}) {
    nodes { id databaseId createdAt commitOid ref { name } latestStatus { state createdAt logUrl } }
    pageInfo { hasNextPage }
  }
  ${PAST_PULLS}
  ${PAST_ISSUES}
  ${CLOSED_ISSUES}
}
fragment Stack on Repository {
  declaration: object(expression: "main:${DECLARATION_PATH}") { ... on Blob { text } }
  releases(first: 40, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName publishedAt url isDraft } }
  ${WORKFLOW_FILES}
}`;

function repoField(alias: string, repo: string, spread: string): string {
  const [owner = "", name = ""] = repo.split("/");
  return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${spread} }`;
}

/** Most GraphQL requests one GitHub read keeps in flight. Each fork is its own request, so a
 * slow fork stays well under GitHub's time limit and fails alone. */
export const GITHUB_READS_AT_ONCE = 4;

/** Most queries one sweep may spend splitting a cut or gateway-failed request: enough to isolate
 * two heavy repos in the shared template, stack and planned request. A half past the limit
 * records its own failure for its repos. */
export const SPLIT_QUERIES_PER_SWEEP = 12;

interface Field {
  alias: string;
  repo: string;
  text: string;
}

function query(fields: readonly Field[]): string {
  const body = fields.map((f) => f.text).join("\n  ");
  const used = FRAGMENTS.split(/\n(?=fragment )/)
    .filter((f) => {
      const name = /^\s*fragment (\w+)/.exec(f)?.[1];
      return name && body.includes(`...${name}`);
    })
    .join("\n");
  return `query {\n  ${body}\n}\n${used}`;
}

function batches(ctx: CoreContext): Field[][] {
  const field = (alias: string, repo: string, spread: string): Field => ({
    alias, repo, text: repoField(alias, repo, spread),
  });
  return [
    [
      field("r_template", TEMPLATE_REPO, "...Base ...Template"),
      field("r_stack", ctx.stackRepo, "...Base ...Stack"),
      ...ctx.fleet.planned.map((p, i) => field(`p_${i}`, plannedRepo(p), "nameWithOwner")),
    ],
    ...ctx.fleet.forks.map((f, i) => [field(`r_fork${i}`, f.repo, "...Base ...Fork")]),
  ];
}

export function buildQueries(ctx: CoreContext): string[] {
  return batches(ctx).map(query);
}

export function mergeReads(reads: Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const { rateLimit: _rateLimit, ...rest } of reads) Object.assign(merged, rest);
  return merged;
}

type Cut = Extract<ReadCompleteness, { kind: "cut" }>;

function objectOf(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cutsOf(raw: unknown): Cut[] {
  const cuts: Cut[] = [];
  function visit(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((node, i) => {
        visit(node, `${path}[${i}]`);
      });
    } else if (objectOf(value)) {
      if (typeof value.totalCount === "number" && Array.isArray(value.nodes)) {
        const read = value.nodes.filter((node) => node !== null).length;
        if (value.totalCount > read)
          cuts.push({ kind: "cut", reason: path || "root", read, total: value.totalCount });
      }
      for (const [key, child] of Object.entries(value))
        visit(child, path ? `${path}.${key}` : key);
    }
  }
  visit(raw, "");
  return cuts;
}

function missingMarker(error: GqlError): boolean {
  if (error.type !== "NOT_FOUND" || !error.path) return false;
  const [, field, nodes, index, ref, target, file] = error.path;
  if (error.path.length === 2 && field === "marker") return true;
  return error.path.length === 7 &&
    field === "pullRequests" && nodes === "nodes" &&
    typeof index === "number" && Number.isSafeInteger(index) && index >= 0 &&
    ref === "headRef" && target === "target" && file === "file";
}

interface Read {
  fields: readonly Field[];
  data: Record<string, unknown>;
  errors: GqlError[];
  observedAt: string;
}

export async function readGithub<T>(
  gh: Pick<Gh, "graphql">,
  ctx: CoreContext,
  parse: (raw: Record<string, unknown>, ctx: CoreContext) => T,
): Promise<{ facts: T; records: ReadRecord[] }> {
  let splits = SPLIT_QUERIES_PER_SWEEP;
  // A request cut short or failed at the gateway is split in halves down to one repo, so one
  // repo too heavy to read fails alone. Halves go in turn, inside the caller's in-flight slot.
  async function read(fields: readonly Field[], split: boolean): Promise<Read[]> {
    try {
      const result = await gh.graphql<Record<string, unknown>>(query(fields), 1, { resend: !split });
      return [{ fields, ...result, observedAt: ctx.clock.now().toISOString() }];
    } catch (error) {
      const splittable = error instanceof ForgeError && (error.kind === "cut" || error.kind === "gateway");
      if (fields.length > 1 && splittable && splits >= 2) {
        splits -= 2;
        const half = Math.ceil(fields.length / 2);
        const first = await read(fields.slice(0, half), half > 1);
        const second = await read(fields.slice(half), fields.length - half > 1);
        return [...first, ...second];
      }
      return [{
        fields,
        data: {},
        errors: [{ message: error instanceof Error ? error.message : String(error) }],
        observedAt: ctx.clock.now().toISOString(),
      }];
    }
  }
  const reads = (await pool(batches(ctx), GITHUB_READS_AT_ONCE, (b) => read(b, false))).flat();
  const data = mergeReads(reads.map((read) => read.data));
  const records = reads.flatMap((result) => result.fields.flatMap(({ alias, repo }): ReadRecord[] => {
    const raw = result.data[alias];
    const errors = result.errors.filter(
      (error) => (!error.path?.length || error.path[0] === alias) &&
        !(objectOf(raw) && missingMarker(error)),
    );
    const closedErrors = errors.filter((error) => error.path?.[1] === "closedIssues");
    if (closedErrors.length && objectOf(raw)) {
      const { closedIssues: _closed, ...rest } = raw;
      data[alias] = rest;
    }
    const repoErrors = errors.filter((error) => error.path?.[1] !== "closedIssues");
    const absentPlanned = alias.startsWith("p_") && raw === null &&
      repoErrors.every((error) => error.type === "NOT_FOUND");
    const failure = absentPlanned ? undefined : repoErrors.length
      ? repoErrors.map((error) => error.message).join("; ")
      : raw == null ? `GraphQL did not return ${repo}` : undefined;
    const closedFailure = closedErrors.map((error) => error.message).join("; ");
    const observedAt = result.observedAt;
    const complete = { kind: "complete" } as const;
    return [{
      source: "github", object: repo, observedAt,
      completeness: cutsOf(data[alias])[0] ?? complete,
      ...(failure === undefined ? {} : { failure }),
    }, ...(closedFailure ? [{
      source: "github", object: `${repo}@closed-issues`, observedAt,
      completeness: complete, failure: closedFailure,
    }] : [])];
  }));
  return { facts: parse(data, ctx), records };
}
