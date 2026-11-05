// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import { z } from "zod";
import {
  fleetOf,
  GITLAB_EVERY_MS,
  RELEASES_EVERY_MS,
  SECURITY_EVERY_MS,
} from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { RecordingExec, ReplayExec } from "../../src/exec/index.js";
import { AREAS, emptyFacts, type Facts } from "../../src/facts.js";
import { createSweeper } from "../../src/sweep/areas.js";
import { cacheSchema, emptyCache, pruneCache } from "../../src/sweep/cache.js";
import { due } from "../../src/sweep/cadence.js";
import type { SweepState } from "../../src/sweep/sweeper.js";

const START = "2026-10-14T00:00:00.000Z";
const factsSchema = z.custom<Facts>(
  (v) => !!v && typeof v === "object" && AREAS.every((a) => a in v),
);

function harness(repo = "owner/partition", remaining = 4000) {
  let time = Date.parse(START);
  let offline = false;
  let retry = true;
  let stored: unknown;
  const costs: number[] = [];
  const queries: string[] = [];
  const log: string[] = [];
  const ctx = createContext({
    fleet: fleetOf([{ id: "partition", repo, upstream: "osdu/partition", seeded: "2026-10-13" }]),
    clock: { now: () => new Date(time) },
  });
  const exec = new RecordingExec(
    async (cmd, args) => {
      if (offline) return { stdout: "", stderr: `${cmd} unavailable`, exit: 1 };
      const path =
        args.find(
          (a) => a.startsWith("repos/") || a.startsWith("projects/") || a.startsWith("groups/"),
        ) ?? "";
      const query = args.find((a) => a.startsWith("query=")) ?? "";
      let data: unknown;
      if (cmd === "gh" && query) {
        queries.push(query);
        if (query.includes("port_o0") && retry) {
          retry = false;
          costs.push(4);
          return { stdout: "", stderr: "", exit: 0 };
        }
        let payload: object;
        if (query.includes("stack: repository"))
          payload = {
            stack: { object: { text: `forks:\n  - service: partition\n    repo: ${repo}\n` } },
            template: { object: null },
          };
        else if (query.includes("r_template:") || query.includes("r_fork0:")) {
          const raw = (nameWithOwner: string) => ({
            nameWithOwner,
            url: `https://github.com/${nameWithOwner}`,
          });
          payload = query.includes("r_template:")
            ? { r_template: raw("Azure/osdu-spi"), r_stack: raw("Azure/osdu-spi-stack") }
            : { r_fork0: raw(repo) };
        } else if (query.includes("port_o0"))
          payload = {
            port_o0: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
            port_m0: { issueCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
          };
        else if (query.includes("pom0:")) payload = { pom0: { root: { oid: "blob" } } };
        else if (query.includes("createdAt"))
          payload = Object.fromEntries(
            ctx.fleet.releaseRepos.map((_, i) => [`r${i}`, { createdAt: START }]),
          );
        else payload = { repository: { p0: { text: "<java.version>21</java.version>" } } };
        const cost = query.includes("port_o0") ? 7 : query.includes("createdAt") ? 3 : 2;
        costs.push(cost);
        data = {
          data: {
            ...payload,
            spicodeBudget: {
              cost,
              remaining,
              resetAt: "2099-01-01T00:00:00Z",
            },
          },
        };
      } else if (cmd === "glab" && query)
        data = {
          data: {
            p0: { mergeRequests: { nodes: [], pageInfo: { hasNextPage: false } } },
          },
        };
      else if (args.includes("status")) return { stdout: "", stderr: "", exit: 0 };
      else if (path.endsWith("actions/variables?per_page=100&page=1"))
        data = { total_count: 0, variables: [] };
      else if (path.includes("/attempts/")) data = { total: 0, jobs: [] };
      else if (path.includes("/workflows/cascade.yml/"))
        data = {
          total: 1,
          runs: [
            {
              id: 5,
              name: "Cascade",
              path: "cascade.yml",
              event: "push",
              status: "completed",
              conclusion: "failure",
              created_at: START,
              updated_at: START,
              head_branch: "main",
              head_sha: "cascade",
              display_title: "Cascade",
              html_url: "u",
              run_attempt: 1,
            },
          ],
        };
      else if (path.includes("/actions/")) data = { total: 0, runs: [] };
      else if (path.endsWith("/commits/fork_integration")) data = { sha: "integration", at: START };
      else if (path.includes("/releases?"))
        return {
          stdout: JSON.stringify({ tag: "v1.0.0", at: START, body: "" }),
          stderr: "",
          exit: 0,
        };
      else if (path.includes("/git/trees/")) data = { paths: [], truncated: false };
      else if (path.includes("/git/blobs/"))
        data = {
          content: Buffer.from("<os-core-common.version>1.0.0</os-core-common.version>").toString(
            "base64",
          ),
        };
      else if (path.includes("upstream-filter.yml"))
        data = {
          sha: "filter",
          content: Buffer.from("top_level:\n  docs: shared\n").toString("base64"),
        };
      else if (path.includes("/repository/branches/"))
        data = { commit: { id: "head", committed_date: START } };
      else if (path.includes("/repository/files/"))
        data = { content: Buffer.from("<project/>").toString("base64") };
      else if (path.includes("/repository/tags")) data = [{ name: "v1.0.0" }];
      else if (cmd === "glab") data = [];
      else if (path.includes("/dependabot/") || path.includes("/code-scanning/"))
        return { stdout: "", stderr: "", exit: 0 };
      else return { stdout: "", stderr: `unhandled ${cmd} ${args.join(" ")}`, exit: 1 };
      return { stdout: JSON.stringify(data), stderr: "", exit: 0 };
    },
    (line) => {
      log.push(line);
    },
  );
  const persist = {
    load: async () => structuredClone(stored),
    save: async (state: SweepState<ReturnType<typeof emptyCache>>) => {
      stored = structuredClone(state);
    },
  };
  const options = { ctx, exec, persist, factsSchema };
  return {
    options,
    costs,
    queries,
    log,
    setOffline: () => {
      offline = true;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("multi-area exec replay accounts for ledger, release, pin and retried GraphQL calls", async () => {
  const h = harness();
  const sweeper = createSweeper(h.options);
  await sweeper.sweep();
  expect(sweeper.facts.github.error).toBeUndefined();
  expect(sweeper.facts.radar.error).toBeUndefined();
  expect(sweeper.facts.runs.data?.["owner/partition"]?.integration).toEqual({
    sha: "integration",
    at: START,
  });
  expect(sweeper.cache.releases.pins).toHaveProperty("owner/partition@v1.0.0");
  expect(h.queries.filter((q) => q.includes("port_o0"))).toHaveLength(2);
  expect(sweeper.cache.budget.cost).toBe(h.costs.reduce((sum, cost) => sum + cost, 0));
  expect(sweeper.cache.budget.calls).toBe(h.costs.length);
  expect(sweeper.cache.budget.deferred).toEqual([]);
  const replay = createSweeper({
    ...h.options,
    exec: new ReplayExec(h.log.join("")),
    persist: { load: async () => undefined, save: async () => {} },
  });
  await replay.sweep();
  expect(replay.facts).toEqual(sweeper.facts);
  expect(replay.cache.budget).toEqual(sweeper.cache.budget);
});

test("low and unknown budgets defer optional work with reasons while core reads run", async () => {
  const low = harness("owner/partition", 50);
  const sweeper = createSweeper(low.options);
  await sweeper.sweep();
  expect(sweeper.facts.github.data?.repos["owner/partition"]).toBeDefined();
  expect(sweeper.facts.upstream.data?.partition).toBeDefined();
  expect(sweeper.cache.budget.deferred).toEqual(
    ["details", "radar", "security", "releases"].map((area) => ({
      area,
      reason: "insufficient budget",
    })),
  );
  low.setOffline();
  const cold = createSweeper({
    ...low.options,
    persist: { load: async () => undefined, save: async () => {} },
  });
  await cold.sweep({ force: true });
  expect(cold.cache.budget.deferred).toEqual(
    ["details", "radar", "security", "releases"].map((area) => ({
      area,
      reason: "budget unknown",
    })),
  );
  expect(cold.facts.github.error).toContain("gh");
  expect(cold.facts.auth.data?.gh.ok).toBe(false);
  expect(cold.model.measured).toBe(false);
  expect(cold.facts.sweep?.errors).toBeGreaterThan(0);
});

test("cadences include the exact boundary, force and missing-fork retry", async () => {
  for (const interval of [GITLAB_EVERY_MS, SECURITY_EVERY_MS, RELEASES_EVERY_MS]) {
    expect(due(START, interval, new Date(Date.parse(START) + interval - 1))).toBe(false);
    expect(due(START, interval, new Date(Date.parse(START) + interval))).toBe(true);
    expect(due(START, interval, new Date(START), true)).toBe(true);
  }
  const h = harness();
  const sweeper = createSweeper(h.options);
  await sweeper.sweep();
  const upstream = sweeper.facts.upstream.at;
  const radar = sweeper.facts.radar.at;
  h.advance(1);
  await sweeper.sweep();
  expect(sweeper.facts.upstream.at).toBe(upstream);
  expect(sweeper.facts.radar.at).toBe(radar);
  delete sweeper.facts.upstream.data?.partition;
  await sweeper.sweep();
  expect(sweeper.facts.upstream.at).not.toBe(upstream);
  expect(sweeper.facts.radar.at).not.toBe(radar);
  const retried = sweeper.facts.upstream.at;
  h.advance(GITLAB_EVERY_MS - 1);
  await sweeper.sweep();
  expect(sweeper.facts.upstream.at).toBe(retried);
  expect(sweeper.facts.security.at).toBe(h.options.ctx.clock.now().toISOString());
  h.advance(1);
  await sweeper.sweep();
  expect(sweeper.facts.upstream.at).toBe(h.options.ctx.clock.now().toISOString());
  h.advance(RELEASES_EVERY_MS - GITLAB_EVERY_MS - 1);
  await sweeper.sweep();
  expect(sweeper.cache.releases.at).toBe(h.options.ctx.clock.now().toISOString());
});

test("two interleaved fleets keep facts, caches and budgets independent", async () => {
  const a = harness("owner/one");
  const b = harness("owner/two", 50);
  const one = createSweeper(a.options);
  const two = createSweeper(b.options);
  await Promise.all([one.sweep(), two.sweep()]);
  const budget = structuredClone(two.cache.budget);
  a.advance(1);
  await one.sweep({ force: true });
  expect(Object.keys(one.facts.runs.data ?? {})).toEqual(["owner/one"]);
  expect(Object.keys(two.facts.runs.data ?? {})).toEqual(["owner/two"]);
  expect(one.cache.radar.pins.forks).toHaveProperty("owner/one:main:pom.xml");
  expect(Object.keys(two.cache.radar.pins.forks)).toEqual([]);
  expect(one.cache.budget.deferred).toEqual([]);
  expect(two.cache.budget).toEqual(budget);
});

test("a total outage keeps last-good radar and per-fork/approval evidence through repeated sweeps", async () => {
  const h = harness();
  const sweeper = createSweeper(h.options);
  await sweeper.sweep();
  const radar = structuredClone(sweeper.facts.radar);
  const reads = structuredClone(sweeper.reads);
  h.setOffline();
  for (let i = 0; i < 2; i++) {
    h.advance(60_000);
    await sweeper.sweep({ force: true });
    expect(sweeper.facts.radar.data).toEqual(radar.data);
    expect(sweeper.facts.radar.at).toBe(radar.at);
    expect(sweeper.facts.radar.error).toContain("glab");
    for (const area of ["runs", "approvals"] as const) {
      expect(sweeper.reads[area]?.[0]?.retainedFrom).toBe(reads[area]?.[0]?.observedAt);
    }
  }
});

test("snapshot replay performs no reads or writes and keeps recorded envelopes", async () => {
  const h = harness();
  const frame = { facts: emptyFacts(), cache: emptyCache(), reads: {} };
  const sweeper = createSweeper({
    ...h.options,
    replay: async () => frame,
    persist: {
      load: async () => undefined,
      save: async () => {
        throw new Error("must not save");
      },
    },
  });
  await sweeper.sweep();
  expect(h.log).toHaveLength(0);
  expect(sweeper.facts).toEqual(frame.facts);
});

test("cache loading rejects malformed pin times and pruning bounds every collector cache", () => {
  const facts = emptyFacts();
  const cache = emptyCache();
  const read = {
    source: "github",
    object: "old",
    observedAt: START,
    completeness: { kind: "complete" as const },
  };
  cache.lifecycle.runJobs.old = { data: [], reads: [read] };
  cache.lifecycle.files.old = { data: "v1", reads: [read] };
  cache.approvals.old = { files: [], changedFiles: 0, additions: 0, deletions: 0 };
  const job = { id: 1, name: "job", status: "completed", url: "u", steps: [] };
  cache.details["repo#1"] = { data: job, reads: [read] };
  cache.details["repo#2"] = { data: { ...job, id: 2 }, reads: [read] };
  facts.details.data = { "repo#1": job };
  for (let i = 0; i < 210; i++) cache.radar.commitDiffs[String(i)] = { paths: [] };
  cache.radar.pins.latestAt = "bad";
  expect(cacheSchema.safeParse(cache).success).toBe(false);
  delete cache.radar.pins.latestAt;
  pruneCache(facts, cache);
  expect(cache.lifecycle.runJobs).toEqual({});
  expect(cache.lifecycle.files).toEqual({});
  expect(cache.approvals).toEqual({});
  expect(Object.keys(cache.details)).toEqual(["repo#1"]);
  expect(Object.keys(cache.radar.commitDiffs)).toHaveLength(200);
});
