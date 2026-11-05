// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import { readUpstream, type UpstreamCompares } from "../../src/collect/upstream.js";
import { fleetOf } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import type { Exec } from "../../src/exec/index.js";
import { RecordingExec, ReplayExec } from "../../src/exec/recording.js";
import { Glab } from "../../src/forge.js";
import fixture from "../fixtures/upstream.json";
import { FIXTURE_NOW } from "../harness.js";

const fork = { id: "partition", repo: "Azure/osdu-spi-partition", upstream: "osdu/partition" };
const ctx = createContext({ fleet: fleetOf([fork]), clock: { now: () => FIXTURE_NOW } });
const expected = fixture.upstream.data.partition;
const repos = fixture.github.data.repos;

function recording(timeout = false) {
  let log = "";
  const calls: string[] = [];
  const exec = new RecordingExec(
    async (_cmd, args) => {
      const path = args.at(-1) ?? "";
      calls.push(path);
      if (path.includes("broken")) return { stdout: "", stderr: "project unavailable", exit: 1 };
      const data = path.includes("/compare?")
        ? {
            commits: expected.commits.map((c) => ({
              id: c.sha,
              title: c.title,
              created_at: c.at,
              web_url: c.url,
            })),
            compare_timeout: timeout,
          }
        : {
            commit: {
              id: expected.head.sha,
              committed_date: expected.head.at,
              web_url: expected.head.url,
            },
          };
      return { stdout: JSON.stringify(data), stderr: "", exit: 0 };
    },
    (line) => {
      log += line;
    },
  );
  return { exec, calls, replay: () => new ReplayExec(log) };
}

test("a glab compare replay reproduces fixture commits and caches the fixed SHA pair", async () => {
  const recorded = recording();
  const scenario = async (exec: Exec) => {
    const compares: UpstreamCompares = {};
    const result = await readUpstream(new Glab(exec), repos, compares, ctx);
    expect(result.upstream.partition).toEqual(expected);
    expect(result.reads).toHaveLength(2);
    expect(result.reads.every((r) => r.observedAt === FIXTURE_NOW.toISOString())).toBe(true);
    expect(Object.values(compares)).toEqual([expected.commits]);
    const warm = await readUpstream(new Glab(exec), repos, compares, ctx);
    expect(warm.upstream.partition?.commits).toEqual(expected.commits);
  };
  await scenario(recorded.exec);
  expect(recorded.calls.filter((path) => path.includes("/compare?"))).toHaveLength(1);
  const replay = recorded.replay();
  await scenario(replay);
  replay.assertExhausted();
});

test("one failed project records its own failure without losing another project's facts", async () => {
  const other = { ...fork, id: "broken", upstream: "osdu/broken", repo: "owner/broken" };
  const context = createContext({ fleet: fleetOf([fork, other]), clock: ctx.clock });
  const result = await readUpstream(new Glab(recording().exec), repos, {}, context);
  expect(result.upstream.partition).toEqual(expected);
  expect(result.upstream.broken).toBeUndefined();
  expect(result.reads.filter((r) => r.failure)).toEqual([
    expect.objectContaining({
      source: "osdu/broken",
      failure: expect.stringContaining("project unavailable"),
    }),
  ]);
});

test("a timed-out compare is incomplete, is not cached, and never reports a measured lag", async () => {
  const compares: UpstreamCompares = {};
  const result = await readUpstream(new Glab(recording(true).exec), repos, compares, ctx);
  expect(result.reads.at(-1)?.completeness).toMatchObject({
    kind: "cut",
    read: expected.commits.length,
    total: expected.commits.length + 1,
  });
  expect(result.upstream.partition?.lag).toBeUndefined();
  expect(compares).toEqual({});
});

test("equal head and synced SHAs need no compare; a missing trailer leaves lag unmeasured", async () => {
  const repo = repos["Azure/osdu-spi-partition"];
  for (const upstreamSha of [undefined, { sha: expected.head.sha, at: "", url: "" }]) {
    const result = await readUpstream(
      new Glab(recording().exec),
      {
        [fork.repo]: { ...repo, upstreamSha },
      },
      {},
      ctx,
    );
    expect(result.reads).toHaveLength(1);
    expect(result.upstream.partition?.lag).toBe(upstreamSha ? 0 : undefined);
  }
});
