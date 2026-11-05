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
import { RecordingExec, ReplayExec } from "../../src/exec/recording.js";
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

function exec(data: unknown, errors: unknown[] = [], commits: string[] | Error = []) {
  const queries: string[] = [];
  return {
    queries,
    exec: new RecordingExec(
      async (_cmd, args) => {
        queries.push(args.join(" "));
        if (args.includes("--paginate")) {
          return commits instanceof Error
            ? { stdout: "", stderr: commits.message, exit: 1 }
            : {
                stdout: commits
                  .map((message) =>
                    args.at(-1)?.endsWith("| tojson") ? JSON.stringify(message) : message,
                  )
                  .join("\n"),
                stderr: "",
                exit: 0,
              };
        }
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
      `fix: port changes\n\nSee https://community.opengroup.org/${ENT}/-/merge_requests/956\nand preserve "quotes" and \\backslashes`,
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
      failure: expect.stringContaining("GitHub answered HTTP 502 twice"),
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

test("incomplete PR searches remain explicitly cut without advancing the watermark", async () => {
  const state = emptyLedgerState();
  const result = await readPortPrs(
    new Gh(
      exec({ port_o0: search([pr(3, null, "")], 101), port_m0: search() }).exec,
      undefined,
      new GraphqlBudget(ctx.clock),
    ),
    state,
    ctx,
  );
  expect(result.prs.partition).toBeUndefined();
  expect(result.reads[0]?.completeness.kind).toBe("cut");
  expect(state.portPrs).toEqual({});
});

const singleFork = createContext({
  fleet: fleetOf(services.slice(0, 1)),
  clock: ctx.clock,
});
const searchPage = (nodes: unknown[], issueCount: number, endCursor: string | null = null) => ({
  ...search(nodes, issueCount),
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});

test.each(["merged", "open"] as const)(
  "150 %s PRs across two pages publish completely on recording and replay",
  async (kind) => {
    const nodes = Array.from({ length: 150 }, (_, i) =>
      pr(i + 1, kind === "merged" ? "2026-10-01T10:00:00Z" : null, ""),
    );
    const alias = kind === "merged" ? "port_m0" : "port_o0";
    const log: string[] = [];
    const queries: string[] = [];
    const recording = new RecordingExec(
      async (_cmd, args) => {
        const query = args.at(-1) ?? "";
        queries.push(query);
        const data =
          queries.length === 1
            ? {
                port_o0: search(),
                port_m0: search(),
                [alias]: searchPage(nodes.slice(0, 100), 150, 'cursor"100'),
              }
            : { port_page: searchPage(nodes.slice(100), 150) };
        return { stdout: JSON.stringify({ data }), stderr: "", exit: 0 };
      },
      (line) => {
        log.push(line);
      },
    );
    const state = emptyLedgerState();
    const budget = new GraphqlBudget(ctx.clock);
    const result = await readPortPrs(new Gh(recording, undefined, budget), state, singleFork);
    expect(result.prs.partition?.map((p) => p.number)).toEqual(nodes.map((p) => p.number));
    expect(result.read).toEqual({ prs: 150, commits: 0 });
    expect(result.reads[0]?.completeness.kind).toBe("complete");
    expect(state.portPrs.partition?.watermark).toBe(
      kind === "merged" ? nodes[0]?.mergedAt : undefined,
    );
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain('after: "cursor\\"100"');
    expect(budget.snapshot()).toMatchObject({ calls: 2, spent: 6 });
    const replay = new ReplayExec(log.join(""));
    const restored = emptyLedgerState();
    expect(await readPortPrs(new Gh(replay), restored, singleFork)).toEqual(result);
    expect(restored).toEqual(state);
    replay.assertExhausted();
  },
);

test("merged searches over 1000 split into disjoint date windows and page every window", async () => {
  const nodes = Array.from({ length: 1200 }, (_, i) =>
    pr(i + 1, i < 600 ? "2026-08-04T10:00:00Z" : "2026-10-12T10:00:00Z", ""),
  );
  const queries: string[] = [];
  const calls = new RecordingExec(
    async (_cmd, args) => {
      const query = args.at(-1) ?? "";
      queries.push(query);
      const dates = /merged:>=([\d-]+) merged:<=([\d-]+)/.exec(query);
      expect(dates).not.toBeNull();
      const matching = nodes.filter((p) => {
        const day = p.mergedAt?.slice(0, 10) ?? "";
        return day >= (dates?.[1] ?? "") && day <= (dates?.[2] ?? "");
      });
      const offset = Number(/after: "(\d+)"/.exec(query)?.[1] ?? 0);
      const page = searchPage(
        matching.slice(offset, offset + 100),
        matching.length,
        offset + 100 < matching.length ? String(offset + 100) : null,
      );
      const data =
        queries.length === 1 ? { port_o0: search(), port_m0: page } : { port_page: page };
      return { stdout: JSON.stringify({ data }), stderr: "", exit: 0 };
    },
    () => {},
  );
  const state = emptyLedgerState();
  const budget = new GraphqlBudget(ctx.clock);
  const result = await readPortPrs(new Gh(calls, undefined, budget), state, singleFork);
  expect(result.prs.partition).toHaveLength(1200);
  expect(new Set(result.prs.partition?.map((p) => p.number)).size).toBe(1200);
  expect(state.portPrs.partition?.watermark).toBe("2026-10-12T10:00:00Z");
  expect(result.reads[0]?.completeness.kind).toBe("complete");
  expect(queries).toHaveLength(13);
  expect(budget.snapshot()).toMatchObject({ calls: 13, spent: 28 });
});

test.each(["open cap", "single-day merged cap", "missing cursor", "repeated cursor", "page error"])(
  "%s retains the last good ledger and watermark with explicit evidence",
  async (scenario) => {
    const state = emptyLedgerState();
    state.portPrs.partition = {
      watermark: "2026-10-12T00:00:00Z",
      prs: { "1": { number: 1, url: "u", state: "merged", refs: [] } },
      open: [],
    };
    state.observed["port:partition"] = "2026-10-11T00:00:00Z";
    const previous = structuredClone(state);
    const nodes = [pr(2, "2026-10-12T10:00:00Z", "")];
    const overCap = scenario.endsWith("cap");
    const first =
      scenario === "missing cursor"
        ? { ...search(nodes, 150), pageInfo: { hasNextPage: true } }
        : searchPage(nodes, overCap ? 1001 : 150, "same");
    let count = 0;
    const calls = new RecordingExec(
      async () => {
        count++;
        const data =
          count === 1
            ? {
                port_o0: scenario === "open cap" ? first : search(),
                port_m0: scenario === "open cap" ? search() : first,
              }
            : { port_page: first };
        return {
          stdout: JSON.stringify({
            data,
            errors:
              count > 1 && scenario === "page error"
                ? [{ path: ["port_page"], message: "page denied" }]
                : [],
          }),
          stderr: "",
          exit: 0,
        };
      },
      () => {},
    );
    const result = await readPortPrs(new Gh(calls), state, singleFork);
    expect(state).toEqual(previous);
    expect(result.prs.partition).toEqual(Object.values(previous.portPrs.partition?.prs ?? {}));
    expect(result.reads[0]?.retainedFrom).toBe("2026-10-11T00:00:00Z");
    if (scenario === "page error") expect(result.reads[0]?.failure).toBe("page denied");
    else expect(result.reads[0]?.completeness.kind).toBe("cut");
    expect(count).toBe(scenario === "repeated cursor" || scenario === "page error" ? 2 : 1);
  },
);

const longPr = {
  ...pr(37, "2026-09-01T10:00:00Z", `https://community.opengroup.org/${ENT}/-/merge_requests/955`),
  commits: {
    totalCount: 51,
    pageInfo: { hasNextPage: true },
    nodes: Array.from({ length: 50 }, () => ({ commit: { message: "first fifty" } })),
  },
};
const fullMessages = [
  ...Array.from({ length: 50 }, () => "first fifty"),
  `Port "the \\fix"\n\nhttps://community.opengroup.org/${ENT}/-/merge_requests/956\n`,
];

test("a 51-commit merged PR pages all commits through Gh and advances the watermark", async () => {
  const calls = exec({ port_o0: search(), port_m0: search([longPr]) }, [], fullMessages);
  const counter = { calls: 0 };
  const budget = new GraphqlBudget(ctx.clock);
  const state = emptyLedgerState();
  const result = await readPortPrs(new Gh(calls.exec, counter, budget), state, ctx);
  expect(result.prs.partition?.[0]?.refs).toEqual([`${ENT}!955`, `${ENT}!956`]);
  expect(result.read).toEqual({ prs: 1, commits: 51 });
  expect(state.portPrs.partition?.watermark).toBe(longPr.mergedAt);
  expect(state.portPrs.partition?.pending).toEqual({});
  expect(calls.queries[1]).toBe(
    "api --paginate repos/Azure/osdu-spi-partition/pulls/37/commits?per_page=100 --jq .[].commit.message | tojson",
  );
  expect(counter.calls).toBe(3);
  expect(budget.snapshot()).toMatchObject({ calls: 2, spent: 8 });
});

test("failed commit paging does not freeze other PRs or lose retries behind the watermark", async () => {
  const state = emptyLedgerState();
  const complete = pr(39, "2026-10-01T10:00:00Z", "");
  const first = exec(
    { port_o0: search(), port_m0: search([longPr, complete]) },
    [],
    new Error("HTTP 502"),
  );
  const failed = await readPortPrs(
    new Gh(first.exec, undefined, new GraphqlBudget(ctx.clock)),
    state,
    ctx,
  );
  expect(failed.prs.partition?.map((p) => p.number)).toEqual([37, 39]);
  expect(state.portPrs.partition?.watermark).toBe(complete.mergedAt);
  expect(failed.reads.find((r) => r.object === "pulls/37/commits")).toMatchObject({
    failure: expect.stringContaining("502"),
    completeness: { kind: "cut", read: 50, total: 51 },
  });
  expect(
    failed.reads.find((r) => r.object === "port PRs" && r.source === services[0]?.repo)
      ?.completeness.kind,
  ).toBe("cut");
  expect(state.observed["port:partition"]).toBeUndefined();
  const restored = loadLedgerState(JSON.parse(JSON.stringify(state)), ctx).state;
  for (const response of [new Error("still unavailable"), fullMessages]) {
    const calls = exec({ port_o0: search(), port_m0: search() }, [], response);
    const result = await readPortPrs(
      new Gh(calls.exec, undefined, new GraphqlBudget(ctx.clock)),
      restored,
      later,
    );
    expect(calls.queries[0]).toContain("merged:>=2026-10-01");
    expect(calls.queries[1]).toContain("/pulls/37/commits");
    expect(result.prs.partition?.map((p) => p.number)).toEqual([37, 39]);
    if (response instanceof Error) {
      expect(restored.portPrs.partition?.pending?.["37"]).toBeDefined();
    } else {
      expect(result.prs.partition?.[0]?.refs).toEqual([`${ENT}!955`, `${ENT}!956`]);
      expect(restored.portPrs.partition?.pending).toEqual({});
      expect(result.reads.some((r) => r.failure && r.source === services[0]?.repo)).toBe(false);
    }
  }
});

test("a short REST commit read keeps its references before reporting failure", async () => {
  const truncated = { ...longPr, commits: { ...longPr.commits, totalCount: 60 } };
  const state = emptyLedgerState();
  const calls = exec({ port_o0: search(), port_m0: search([truncated]) }, [], fullMessages);
  const result = await readPortPrs(
    new Gh(calls.exec, undefined, new GraphqlBudget(ctx.clock)),
    state,
    ctx,
  );
  expect(result.prs.partition?.[0]?.refs).toEqual([`${ENT}!955`, `${ENT}!956`]);
  expect(result.read).toEqual({ prs: 1, commits: 51 });
  expect(result.reads.find((r) => r.object === "pulls/37/commits")).toMatchObject({
    failure: expect.stringContaining("Expected 60 commits, read 51"),
    completeness: { kind: "cut", read: 51, total: 60 },
  });
  expect(state.portPrs.partition?.pending?.["37"]?.fact.refs).toEqual([`${ENT}!955`, `${ENT}!956`]);
  expect(state.portPrs.partition?.watermark).toBe(longPr.mergedAt);
  const retry = exec(
    { port_o0: search(), port_m0: search([truncated]) },
    [],
    new Error("HTTP 502"),
  );
  const failed = await readPortPrs(
    new Gh(retry.exec, undefined, new GraphqlBudget(ctx.clock)),
    state,
    later,
  );
  expect(failed.prs.partition?.[0]?.refs).toEqual([`${ENT}!955`, `${ENT}!956`]);
});

test("the 250-commit REST cap preserves read references and persists a cut without re-queuing", async () => {
  const capped = { ...longPr, commits: { ...longPr.commits, totalCount: 251 } };
  const messages = [...Array.from({ length: 249 }, () => "commit"), fullMessages[50] ?? ""];
  const state = emptyLedgerState();
  state.observed["port:partition"] = "2026-10-01T00:00:00Z";
  const calls = exec({ port_o0: search(), port_m0: search([capped]) }, [], messages);
  const result = await readPortPrs(
    new Gh(calls.exec, undefined, new GraphqlBudget(ctx.clock)),
    state,
    ctx,
  );
  expect(result.prs.partition?.[0]?.refs).toEqual([`${ENT}!955`, `${ENT}!956`]);
  expect(result.read).toEqual({ prs: 1, commits: 250 });
  expect(result.reads.find((r) => r.object === "pulls/37/commits")).toMatchObject({
    completeness: {
      kind: "cut",
      read: 250,
      total: 251,
      reason: expect.stringContaining("REST limit"),
    },
  });
  expect(state.portPrs.partition?.pending).toEqual({});
  expect(state.portPrs.partition?.permanentCuts?.["37"]?.read).toBe(250);
  const portRead = (reads: typeof result.reads) =>
    reads.find((r) => r.object === "port PRs" && r.source === services[0]?.repo);
  expect(portRead(result.reads)).toEqual({
    source: services[0]?.repo,
    object: "port PRs",
    observedAt: FIXTURE_NOW.toISOString(),
    completeness: expect.objectContaining({ kind: "cut", read: 250, total: 251 }),
  });
  const restored = loadLedgerState(JSON.parse(JSON.stringify(state)), ctx).state;
  for (const nodes of [[capped], []]) {
    const laterCalls = exec(
      { port_o0: search(), port_m0: search(nodes) },
      [],
      new Error("must not retry"),
    );
    const laterResult = await readPortPrs(
      new Gh(laterCalls.exec, undefined, new GraphqlBudget(ctx.clock)),
      restored,
      later,
    );
    expect(laterCalls.queries).toHaveLength(2);
    expect(laterResult.prs.partition?.[0]?.refs).toEqual([`${ENT}!955`, `${ENT}!956`]);
    expect(
      laterResult.reads.find((r) => r.object === "pulls/37/commits")?.completeness,
    ).toMatchObject({
      kind: "cut",
      read: 250,
      total: 251,
    });
    expect(portRead(laterResult.reads)).toEqual({
      source: services[0]?.repo,
      object: "port PRs",
      observedAt: "2026-10-13T00:00:00.000Z",
      completeness: expect.objectContaining({ kind: "cut", read: 250, total: 251 }),
    });
    expect(restored.portPrs.partition?.pending).toEqual({});
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
    spent: 34,
    remaining: 79,
    calls: 2,
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

const NGINX_502 =
  "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";
const thirteen = createContext({
  fleet: fleetOf(
    Array.from({ length: 13 }, (_, i) => ({
      id: `svc${i}`,
      upstream: `osdu/platform/svc${i}`,
      repo: `Azure/osdu-spi-svc${i}`,
      seeded: "2026-08-04",
    })),
  ),
  clock: { now: () => FIXTURE_NOW },
});

/** GitHub as the radar met it: a query holding more than one fork's searches gets nginx's 502
 * page, a query for one fork gets its PRs; `answer` overrides a fork's reply by index. */
function gateway(answer: (fork: number) => ExecOutputLike | undefined = () => undefined) {
  const queries: string[] = [];
  return {
    queries,
    exec: new RecordingExec(
      async (_cmd, args) => {
        const query = args.find((arg) => arg.startsWith("query=")) ?? "";
        queries.push(query);
        const forks = [...query.matchAll(/port_o(\d+):/g)].map((m) => Number(m[1]));
        if (forks.length !== 1) return { stdout: NGINX_502, stderr: "gh: HTTP 502\n", exit: 1 };
        const i = forks[0] ?? 0;
        return (
          answer(i) ?? {
            stdout: JSON.stringify({
              data: { [`port_o${i}`]: search([pr(i + 1, null, "")]), [`port_m${i}`]: search() },
            }),
            stderr: "",
            exit: 0,
          }
        );
      },
      () => {},
    ),
  };
}
type ExecOutputLike = { stdout: string; stderr: string; exit: number };

test("a 13-fork sweep reads every fork's port PRs where one batched search got HTTP 502", async () => {
  const calls = gateway();
  const result = await readPortPrs(
    new Gh(calls.exec, undefined, new GraphqlBudget(thirteen.clock)),
    emptyLedgerState(),
    thirteen,
  );
  expect(result.reads.filter((r) => r.failure)).toEqual([]);
  expect(Object.keys(result.prs)).toHaveLength(13);
  expect(result.read).toEqual({ prs: 13, commits: 0 });
  expect(calls.queries).toHaveLength(13);
});

test("a throttled port search stops the sweep's later searches and names the throttle", async () => {
  const limited = {
    stdout: JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
    stderr: "gh: You have exceeded a secondary rate limit. (HTTP 403)\n",
    exit: 1,
  };
  const calls = gateway((i) => (i === 2 ? limited : undefined));
  const sleeps: number[] = [];
  const budget = new GraphqlBudget(thirteen.clock, async (ms) => {
    sleeps.push(ms);
  });
  const result = await readPortPrs(
    new Gh(calls.exec, undefined, budget),
    emptyLedgerState(),
    thirteen,
  );
  expect(calls.queries).toHaveLength(4);
  expect(sleeps).toEqual([60_000]);
  const failures = result.reads.filter((r) => r.failure);
  expect(failures.map((r) => r.source)).toEqual(
    Array.from({ length: 11 }, (_, i) => `Azure/osdu-spi-svc${i + 2}`),
  );
  for (const failure of failures) expect(failure.failure).toContain("GitHub throttled the query");
});
