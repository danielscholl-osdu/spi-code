// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  DECLARATION_PATH,
  LANE_ENVIRONMENT,
  LIFECYCLE_WORKFLOWS,
  type LifecycleKind,
  MARKER_PATH,
  plannedRepo,
  STACK_REPO,
  SYNC_TEMPLATE_WORKFLOW,
  TEMPLATE_REPO,
} from "../config.js";
import type { CoreContext } from "../context.js";
import type { ReadCompleteness, ReadRecord } from "../evidence/index.js";
import type { Gh, GqlError } from "../forge.js";

const PULLS = `pullRequests(states: OPEN, first: 40, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes {
  number title url createdAt updatedAt isDraft headRefName baseRefName headRefOid mergeStateStatus reviewDecision
  author { __typename login } authorAssociation
  headRef { target { ... on Commit { file(path: "${MARKER_PATH}") { object { ... on Blob { text } } } } } }
  labels(first: 15) { totalCount nodes { name } }
  commits(last: 1) { totalCount nodes { commit { statusCheckRollup { contexts(first: 80) { totalCount nodes {
    __typename
    ... on CheckRun { databaseId name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { databaseId workflow { name } } } }
  } } } } } }
} }`;

const ISSUES = `issues(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes {
  number title url createdAt updatedAt author { __typename login } authorAssociation
  labels(first: 15) { totalCount nodes { name } } comments { totalCount } body
} }`;

const PAST_PULLS = `pastPrs: pullRequests(states: [MERGED, CLOSED], first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) { totalCount nodes {
  number title url createdAt mergedAt closedAt headRefName baseRefName author { login }
} }`;

const HALT_LABELS = Object.freeze(["sync-failed", "conflict", "cascade-blocked", "cascade-failed"]);
const PAST_ISSUES = `pastIssues: issues(states: CLOSED, first: 30, labels: ${JSON.stringify(HALT_LABELS)}, orderBy: {field: UPDATED_AT, direction: DESC}) { totalCount nodes {
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
  releases(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes { tagName publishedAt url isDraft } }
}
fragment Fork on Repository {
  syncTemplate: object(expression: "main:.github/workflows/${SYNC_TEMPLATE_WORKFLOW}") { ... on Blob { text } }
  marker: object(expression: "main:${MARKER_PATH}") { ... on Blob { text } }
  upstreamLog: ref(qualifiedName: "refs/heads/fork_upstream") { target { ... on Commit { history(first: 10) { totalCount nodes { oid message committedDate } } } } }
  deployments(environments: ["${LANE_ENVIRONMENT}"], first: 60, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes { createdAt commitOid ref { name } latestStatus { state createdAt } } }
  ${PAST_PULLS}
  ${PAST_ISSUES}
}
fragment Stack on Repository {
  declaration: object(expression: "main:${DECLARATION_PATH}") { ... on Blob { text } }
  releases(first: 40, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes { tagName publishedAt url isDraft } }
  ${WORKFLOW_FILES}
}`;

function repoField(alias: string, repo: string, spread: string): string {
  const [owner, name] = repo.split("/");
  return `${alias}: repository(owner: "${owner}", name: "${name}") { ${spread} }`;
}

export const FORKS_PER_QUERY = 5;

function query(fields: string[]): string {
  const body = fields.join("\n  ");
  const used = FRAGMENTS.split(/\n(?=fragment )/)
    .filter((f) => {
      const name = /^\s*fragment (\w+)/.exec(f)?.[1];
      return name && body.includes(`...${name}`);
    })
    .join("\n");
  return `query {\n  ${body}\n}\n${used}`;
}

export function buildQueries(ctx: CoreContext, perQuery = FORKS_PER_QUERY): string[] {
  if (!Number.isSafeInteger(perQuery) || perQuery < 1)
    throw new RangeError("perQuery must be a positive integer");
  const forks = ctx.fleet.forks.map((f, i) => repoField(`r_fork${i}`, f.repo, "...Base ...Fork"));
  const queries = [
    query([
      repoField("r_template", TEMPLATE_REPO, "...Base ...Template"),
      repoField("r_stack", STACK_REPO, "...Base ...Stack"),
      ...ctx.fleet.planned.map((p, i) => repoField(`p_${i}`, plannedRepo(p), "nameWithOwner")),
    ]),
  ];
  for (let i = 0; i < forks.length; i += perQuery)
    queries.push(query(forks.slice(i, i + perQuery)));
  return queries;
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
          cuts.push({ kind: "cut", reason: path, read, total: value.totalCount });
      }
      for (const [key, child] of Object.entries(value))
        visit(child, path ? `${path}.${key}` : key);
    }
  }
  visit(raw, "");
  return cuts;
}

export async function readGithub<T>(
  gh: Pick<Gh, "graphql">,
  ctx: CoreContext,
  parse: (raw: Record<string, unknown>, ctx: CoreContext) => T,
): Promise<{ facts: T; records: ReadRecord[] }> {
  const reads = await Promise.all(
    buildQueries(ctx).map(async (q): Promise<{
      data: Record<string, unknown>; errors: GqlError[]; observedAt: string;
    }> => {
      try {
        const result = await gh.graphql<Record<string, unknown>>(q);
        return { ...result, observedAt: ctx.clock.now().toISOString() };
      } catch (error) {
        return {
          data: {},
          errors: [{ message: error instanceof Error ? error.message : String(error) }],
          observedAt: ctx.clock.now().toISOString(),
        };
      }
    }),
  );
  const entries = [
    { alias: "r_template", repo: TEMPLATE_REPO, batch: 0 },
    { alias: "r_stack", repo: STACK_REPO, batch: 0 },
    ...ctx.fleet.forks.map((f, i) => ({
      alias: `r_fork${i}`, repo: f.repo, batch: 1 + Math.floor(i / FORKS_PER_QUERY),
    })),
    ...ctx.fleet.planned.map((p, i) => ({
      alias: `p_${i}`, repo: plannedRepo(p), batch: 0,
    })),
  ];
  const records = entries.map(({ alias, repo, batch }): ReadRecord => {
    const result = reads[batch];
    if (!result) throw new Error(`Missing GraphQL batch ${batch}`);
    const raw = result.data[alias];
    const errors = result.errors.filter(
      (error) => !error.path?.length || error.path[0] === alias,
    );
    const absentPlanned = alias.startsWith("p_") && raw === null &&
      errors.every((error) => error.type === "NOT_FOUND");
    const failure = absentPlanned ? undefined : errors.length
      ? errors.map((error) => error.message).join("; ")
      : raw == null ? `GraphQL did not return ${repo}` : undefined;
    return {
      source: "github",
      object: repo,
      observedAt: result.observedAt,
      completeness: cutsOf(raw)[0] ?? { kind: "complete" },
      ...(failure === undefined ? {} : { failure }),
    };
  });
  return { facts: parse(mergeReads(reads.map((r) => r.data)), ctx), records };
}
