// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import {
  emptyLedgerState,
  loadLedgerState,
  mrRefs,
  readMerged,
  readPortPrs,
} from "../../src/collect/ledgers.js";
import { fleetOf } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { RecordingExec } from "../../src/exec/recording.js";
import { Gh, Glab, GraphqlBudget } from "../../src/forge.js";
import { FIXTURE_NOW } from "../harness.js";

const ENT = "osdu/platform/security-and-compliance/entitlements";
const services = [
  {
    id: "partition",
    upstream: "osdu/platform/system/partition",
    repo: "Azure/osdu-spi-partition",
    seeded: "2026-08-04",
  },
  { id: "entitlements", upstream: ENT, repo: "Azure/osdu-spi-entitlements", seeded: "2026-08-04" },
];
const ctx = createContext({ fleet: fleetOf(services), clock: { now: () => FIXTURE_NOW } });
const later = createContext({
  fleet: ctx.fleet,
  clock: { now: () => new Date("2026-10-13T00:00:00Z") },
});
const pageInfo = { hasNextPage: false };
const search = (nodes: unknown[] = [], issueCount = nodes.length) => ({
  issueCount,
  nodes,
  pageInfo,
});
const pr = (number: number, mergedAt: string | null, bodyText: string) => ({
  number,
  url: `https://github.com/Azure/osdu-spi-partition/pull/${number}`,
  mergedAt,
  bodyText,
  commits: { totalCount: 0, pageInfo, nodes: [] },
});
const node = {
  iid: "826",
  title: "fix",
  webUrl: "u",
  mergedAt: "2026-09-14T00:00:00Z",
  diffHeadSha: "abc",
};
const mr = (hasNextPage = false) => ({
  mergeRequests: { pageInfo: { hasNextPage }, nodes: [node] },
});

function exec(data: unknown, errors: unknown[] = []) {
  const queries: string[] = [];
  return {
    queries,
    exec: new RecordingExec(
      async (_cmd, args) => {
        queries.push(args.join(" "));
        return data instanceof Error
          ? { stdout: "", stderr: data.message, exit: 1 }
          : {
              stdout: JSON.stringify({ data, errors }),
              stderr: "",
              exit: 0,
            };
      },
      () => {},
    ),
  };
}

test("a fork PR cites an upstream MR URL, not a bare GitLab reference, without duplicates", () => {
  expect(
    mrRefs([
      `Ports https://community.opengroup.org/${ENT}/-/merge_requests/956 into the fork.`,
      `fix: tomcat\n\nSee merge request ${ENT}!963`,
      `https://community.opengroup.org/${ENT}/-/merge_requests/956`,
    ]),
  ).toEqual([`${ENT}!956`]);
});

test("merged fork PRs are kept by number and later reads ask only since the newest merge", async () => {
  const state = emptyLedgerState();
  const first = exec({
    port_o0: search([pr(3, null, "draft port")]),
    port_m0: search([
      pr(
        2,
        "2026-09-01T10:00:00Z",
        "community.opengroup.org/osdu/platform/system/partition/-/merge_requests/826",
      ),
    ]),
  });
  const result = await readPortPrs(
    new Gh(first.exec, undefined, new GraphqlBudget(ctx.clock)),
    state,
    ctx,
  );
  expect(result.prs.partition?.map((p) => [p.number, p.state, p.refs])).toEqual([
    [3, "open", []],
    [2, "merged", ["osdu/platform/system/partition!826"]],
  ]);
  expect(result.read).toEqual({ prs: 2, commits: 0 });
  expect(first.queries[0]).toContain("merged:>=2026-08-04");
  const second = exec({ port_o0: search(), port_m0: search() });
  const again = await readPortPrs(
    new Gh(second.exec, undefined, new GraphqlBudget(ctx.clock)),
    state,
    ctx,
  );
  expect(second.queries[0]).toContain("merged:>=2026-09-01");
  expect(again.prs.partition?.map((p) => p.number)).toEqual([2]);
  const failed = async () =>
    readPortPrs(
      new Gh(exec(new Error("HTTP 502")).exec, undefined, new GraphqlBudget(ctx.clock)),
      state,
      later,
    );
  for (const result of [await failed(), await failed()]) {
    expect(result.prs.partition?.map((p) => p.number)).toEqual([2]);
    expect(result.reads[0]).toMatchObject({
      failure: expect.stringContaining("cut the response short"),
      retainedFrom: FIXTURE_NOW.toISOString(),
    });
  }
});

test("a failed merged-MR read keeps the last good list; a paged-out project stays unread", async () => {
  const state = emptyLedgerState();
  const result = await readMerged(new Glab(exec({ p0: mr(), p1: mr(true) }).exec), state, ctx);
  expect(result.merged.partition?.map((m) => m.iid)).toEqual([826]);
  expect(result.merged.entitlements).toBeUndefined();
  expect(result.reads[1]?.completeness).toMatchObject({ kind: "cut", read: 1, total: 2 });
  const failed = await readMerged(new Glab(exec(new Error("timeout")).exec), state, later);
  expect(failed.merged.partition?.map((m) => m.iid)).toEqual([826]);
  expect(failed.reads[0]).toMatchObject({
    failure: expect.stringContaining("timeout"),
    retainedFrom: FIXTURE_NOW.toISOString(),
  });
});

test("unread projects and alias-scoped GraphQL errors have their own failure records", async () => {
  const merged = await readMerged(
    new Glab(exec({ p0: mr(), p1: null }).exec),
    emptyLedgerState(),
    ctx,
  );
  expect(merged.reads.filter((r) => r.failure).map((r) => r.source)).toEqual([ENT]);
  const result = await readPortPrs(
    new Gh(
      exec(
        {
          port_o0: search(),
          port_m0: search(),
          port_o1: search(),
          port_m1: search(),
        },
        [{ path: ["port_o1", "nodes"], message: "denied" }],
      ).exec,
      undefined,
      new GraphqlBudget(ctx.clock),
    ),
    emptyLedgerState(),
    ctx,
  );
  expect(result.prs).toEqual({ partition: [] });
  expect(result.reads.filter((r) => r.failure).map((r) => r.source)).toEqual([services[1]?.repo]);
});

test("PR searches and nested commit connections cannot silently truncate or advance the watermark", async () => {
  for (const open of [
    search([pr(3, null, "")], 101),
    search([
      {
        ...pr(3, null, ""),
        commits: { totalCount: 51, nodes: [], pageInfo: { hasNextPage: true } },
      },
    ]),
  ]) {
    const state = emptyLedgerState();
    const result = await readPortPrs(
      new Gh(
        exec({ port_o0: open, port_m0: search() }).exec,
        undefined,
        new GraphqlBudget(ctx.clock),
      ),
      state,
      ctx,
    );
    expect(result.prs.partition).toBeUndefined();
    expect(result.reads[0]?.completeness.kind).toBe("cut");
    expect(state.portPrs).toEqual({});
  }
});

test("ledger GraphQL cost is charged to the shared forge account and commit messages match MRs", async () => {
  const budget = new GraphqlBudget(ctx.clock);
  const withMessages = {
    ...pr(7, null, ""),
    commits: {
      totalCount: 1,
      pageInfo,
      nodes: [
        { commit: { message: `https://community.opengroup.org/${ENT}/-/merge_requests/956` } },
      ],
    },
  };
  const result = await readPortPrs(
    new Gh(
      exec({
        port_o0: search([withMessages]),
        port_m0: search(),
        port_o1: search(),
        port_m1: search(),
        spicodeBudget: { cost: 17, remaining: 83, resetAt: "2026-10-12T23:00:00Z" },
      }).exec,
      undefined,
      budget,
    ),
    emptyLedgerState(),
    ctx,
  );
  expect(budget.snapshot()).toEqual({
    spent: 17,
    remaining: 83,
    calls: 1,
    resetAt: "2026-10-12T23:00:00Z",
  });
  expect(result.prs.partition?.[0]?.refs).toEqual([`${ENT}!956`]);
  expect(result.read).toEqual({ prs: 1, commits: 1 });
});

test("persisted ledger state round-trips; invalid JSON values are discarded with evidence", () => {
  const state = emptyLedgerState();
  state.observed["merged:partition"] = FIXTURE_NOW.toISOString();
  expect(loadLedgerState(JSON.parse(JSON.stringify(state)), ctx)).toEqual({ state, reads: [] });
  for (const invalid of [
    null,
    { merged: [], portPrs: {} },
    { ...state, observed: { bad: "yesterday" } },
  ]) {
    const loaded = loadLedgerState(invalid, ctx);
    expect(loaded.state).toEqual(emptyLedgerState());
    expect(loaded.reads[0]?.failure).toContain("Invalid ledger state");
  }
});

test("an unseeded fleet makes no ledger queries", async () => {
  const unseeded = createContext({
    fleet: fleetOf([{ id: "other", repo: "owner/other", upstream: "other/project" }]),
    clock: ctx.clock,
  });
  const calls = exec(new Error("must not call"));
  expect((await readMerged(new Glab(calls.exec), emptyLedgerState(), unseeded)).merged).toEqual({});
  expect((await readPortPrs(new Gh(calls.exec), emptyLedgerState(), unseeded)).prs).toEqual({});
  expect(calls.queries).toEqual([]);
});
