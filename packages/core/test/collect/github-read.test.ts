// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { parseGithub } from "../../src/collect/github-parse.js";
import { buildQueries, cutsOf, mergeReads, readGithub } from "../../src/collect/github-read.js";
import { fleetOf, plannedRepo, STACK_REPO, TEMPLATE_REPO } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { envelopeOf } from "../../src/evidence/index.js";
import { type Exec, RecordingExec, ReplayExec } from "../../src/exec/index.js";
import { Gh, GraphqlBudget } from "../../src/forge.js";

const now = "2026-11-05T07:00:00.000Z";
const resetAt = "2026-11-05T08:00:00Z";
const clock = { now: () => new Date(now) };
const context = (forks: number) =>
  createContext({
    clock,
    fleet: fleetOf([
      ...Array.from({ length: forks }, (_, i) => ({
        id: `fork${i}`,
        repo: `example/fork${i}`,
        upstream: `upstream/fork${i}`,
      })),
      { id: "planned", upstream: "upstream/planned" },
    ]),
  });
const ctx = context(5);
const base = {
  r_template: { nameWithOwner: TEMPLATE_REPO },
  r_stack: { nameWithOwner: STACK_REPO },
  p_0: null,
};
const forks = (start: number, end: number) =>
  Object.fromEntries(
    Array.from({ length: end - start }, (_, offset) => {
      const i = start + offset;
      return [`r_fork${i}`, { nameWithOwner: `example/fork${i}` }];
    }),
  );
const response = (data: Record<string, unknown>, cost: number, remaining: number) => ({
  stdout: JSON.stringify({ data: { ...data, spicodeBudget: { cost, remaining, resetAt } } }),
  stderr: "",
  exit: 0,
});
const parse = (data: Record<string, unknown>) => data;

async function replay(
  outputs: { stdout: string; stderr: string; exit: number }[],
  scenario: (exec: Exec) => Promise<void>,
) {
  let log = "";
  const pending = [...outputs];
  await scenario(
    new RecordingExec(
      async () => {
        const output = pending.shift();
        if (!output) throw new Error("unexpected command");
        return output;
      },
      (line) => {
        log += line;
      },
    ),
  );
  expect(pending).toEqual([]);
  const exec = new ReplayExec(log);
  await scenario(exec);
  exec.assertExhausted();
}

describe("GraphQL query", () => {
  it("reads template, stack, forks, planned probes and the original fields", () => {
    const q = buildQueries(ctx).join("\n");
    for (const repo of ctx.fleet.repos) expect(q).toContain(`name: "${repo.split("/")[1]}"`);
    for (const p of ctx.fleet.planned)
      expect(q).toContain(`name: "${plannedRepo(p).split("/")[1]}"`);
    for (const selection of [
      'environments: ["spi-stack"]',
      "main:.github/.template-sync-commit",
      "main:ops/environments/shared.yaml",
      "pastPrs: pullRequests(states: [MERGED, CLOSED]",
      'labels: ["sync-failed","conflict","cascade-blocked","cascade-failed"]',
      'wf_refresh: object(expression: "main:.github/workflows/env-refresh.yml")',
      'r_template: repository(owner: "Azure", name: "osdu-spi") { ...Base ...Template }',
      'syncTemplate: object(expression: "main:.github/workflows/sync-template.yml")',
    ])
      expect(q).toContain(selection);
  });

  it("batches forks and includes only used fragments, leaving rate accounting to FORGE", () => {
    const queries = buildQueries(ctx, 2);
    expect(queries).toHaveLength(4);
    expect(queries[0]).toContain("r_template:");
    expect(queries[0]).not.toContain("fragment Fork");
    expect(queries[1]).toContain("r_fork0:");
    expect(queries[1]).not.toContain("r_fork2:");
    expect(queries[1]).not.toContain("fragment Stack");
    expect(queries[1]).not.toContain("fragment Template");
    expect(queries.join("")).not.toContain("rateLimit");
    expect(
      mergeReads([
        { rateLimit: { cost: 3 }, r_template: { a: 1 } },
        { rateLimit: { cost: 9 }, r_fork0: { b: 2 } },
      ]),
    ).toEqual({ r_template: { a: 1 }, r_fork0: { b: 2 } });
  });

  it.each([0, -1, 0.5, Number.NaN])("rejects invalid batch size %s", (size) => {
    expect(() => buildQueries(ctx, size)).toThrow("positive integer");
  });
});

it("replays two queries, merges repos and charges both costs only to the account", async () => {
  await replay([response(base, 3, 97), response(forks(0, 5), 9, 88)], async (exec) => {
    const gh = new Gh(exec, undefined, new GraphqlBudget(clock));
    const { facts, records } = await readGithub(gh, ctx, parse);
    expect(facts).toEqual({ ...base, ...forks(0, 5) });
    expect(records).toHaveLength(8);
    expect(records.every((r) => !r.failure && r.completeness.kind === "complete")).toBe(true);
    expect(gh.budget.snapshot()).toEqual({ spent: 12, remaining: 88, resetAt, calls: 2 });
  });
});

it("passes the query fleet to the GitHub parser for planned aliases", async () => {
  const custom = createContext({
    clock,
    fleet: fleetOf([
      { id: "next-service", upstream: "upstream/next" },
      { id: "later-service", upstream: "upstream/later" },
    ]),
  });
  const raw = { ...base, p_0: { nameWithOwner: "Azure/osdu-spi-next-service" }, p_1: null };
  await replay([response(raw, 3, 97)], async (exec) => {
    const { facts } = await readGithub(
      new Gh(exec, undefined, new GraphqlBudget(clock)),
      custom,
      parseGithub,
    );
    expect(facts.planned).toEqual({ "next-service": true, "later-service": false });
  });
});

it("marks a truncated pulls connection cut without affecting other repos", async () => {
  const raw = { ...forks(0, 5), r_fork0: { pullRequests: { totalCount: 41, nodes: [{}] } } };
  await replay([response(base, 3, 97), response(raw, 9, 88)], async (exec) => {
    const { records } = await readGithub(
      new Gh(exec, undefined, new GraphqlBudget(clock)),
      ctx,
      parse,
    );
    expect(records.find((r) => r.object === "example/fork0")?.completeness).toEqual({
      kind: "cut",
      reason: "pullRequests",
      read: 1,
      total: 41,
    });
    expect(records.filter((r) => r.completeness.kind === "complete")).toHaveLength(7);
    expect(envelopeOf(records, { intervalMs: 300_000, now: Date.parse(now) }).state).toBe(
      "incomplete",
    );
  });
});

it("a failed batch reports failures only for its five repos and leaves the rest fresh", async () => {
  const failed = {
    stdout: JSON.stringify({ errors: [{ message: "batch unavailable" }] }),
    stderr: "",
    exit: 1,
  };
  await replay([response(base, 3, 97), failed, response(forks(5, 6), 2, 93)], async (exec) => {
    const { facts, records } = await readGithub(
      new Gh(exec, undefined, new GraphqlBudget(clock)),
      context(6),
      parse,
    );
    expect(facts).toEqual({ ...base, ...forks(5, 6) });
    expect(records.filter((r) => r.failure).map((r) => r.object)).toEqual(
      Array.from({ length: 5 }, (_, i) => `example/fork${i}`),
    );
    const fresh = records.filter((r) => !r.failure);
    expect(fresh).toHaveLength(4);
    expect(envelopeOf(fresh, { intervalMs: 300_000, now: Date.parse(now) }).state).toBe("fresh");
  });
});

it("scopes partial GraphQL errors to their repo, ignores absent planned probes, and detects missing repos", async () => {
  const gh = {
    graphql: async <T>(query: string) => ({
      data: (query.includes("r_template:") ? base : { ...forks(0, 4), r_fork0: null }) as T,
      errors: query.includes("r_template:")
        ? [{ type: "NOT_FOUND", path: ["p_0"], message: "not yet created" }]
        : [{ path: ["r_fork0"], message: "forbidden" }],
    }),
  };
  const { records } = await readGithub(gh, ctx, parse);
  expect(records.filter((r) => r.failure)).toMatchObject([
    { object: "example/fork0", failure: "forbidden" },
    { object: "example/fork4", failure: "GraphQL did not return example/fork4" },
  ]);
});

it("detects nested and nullable-node cuts, not total-only counts or complete connections", () => {
  expect(
    cutsOf({
      issues: {
        totalCount: 1,
        nodes: [{ labels: { totalCount: 2, nodes: [null, {}] }, comments: { totalCount: 20 } }],
      },
      releases: { totalCount: 0, nodes: [] },
    }),
  ).toEqual([{ kind: "cut", reason: "issues.nodes[0].labels", read: 1, total: 2 }]);
});

it("keeps recency windows out of cut detection so a healthy fork is complete", () => {
  const q = buildQueries(ctx).join("\n");
  for (const window of [
    "commits(last: 1) { nodes",
    "history(first: 10) { nodes",
    "first: 60, orderBy: {field: CREATED_AT, direction: DESC}) { nodes",
    "pastPrs: pullRequests(states: [MERGED, CLOSED], first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes",
    "releases(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { nodes",
    "releases(first: 40, orderBy: {field: CREATED_AT, direction: DESC}) { nodes",
  ])
    expect(q).toContain(window);
  const fork = {
    pullRequests: {
      totalCount: 2,
      nodes: [{ commits: { nodes: [{}] }, labels: { totalCount: 1, nodes: [{}] } }, {}],
    },
    issues: { totalCount: 0, nodes: [] },
    upstreamLog: { target: { history: { nodes: Array.from({ length: 10 }, () => ({})) } } },
    deployments: { nodes: Array.from({ length: 60 }, () => ({})) },
    pastPrs: { nodes: Array.from({ length: 100 }, () => ({})) },
  };
  expect(cutsOf(fork)).toEqual([]);
  expect(cutsOf({ ...fork, pullRequests: { totalCount: 41, nodes: [{}] } })).toEqual([
    { kind: "cut", reason: "pullRequests", read: 1, total: 41 },
  ]);
});

it("encodes repository names so a malformed repo cannot alter the query", () => {
  const evil = createContext({
    clock,
    fleet: fleetOf([{ id: "x", repo: 'a/b") { id } evil: repository(owner: "c', upstream: "u/x" }]),
  });
  const q = buildQueries(evil)[1] ?? "";
  expect(q).toContain('name: "b\\") { id } evil: repository(owner: \\"c"');
  expect(q).not.toContain('evil: repository(owner: "c');
});

it("uses the supplied batch size for queries and batch numbering", async () => {
  const seen: string[] = [];
  const gh = {
    graphql: async <T>(query: string) => {
      seen.push(query);
      const data = query.includes("r_template:")
        ? base
        : Object.fromEntries(
            [...query.matchAll(/(r_fork\d+):/g)].map((m) => [m[1], { nameWithOwner: "x" }]),
          );
      return { data: data as T, errors: [] };
    },
  };
  const { records } = await readGithub(gh, context(4), parse, 2);
  expect(seen).toHaveLength(3);
  expect(records.every((r) => !r.failure)).toBe(true);
});
