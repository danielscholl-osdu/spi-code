// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import { fleetOf, STACK_REPO } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { emptyFacts, type JobDetail, type LifecycleRun } from "../../src/facts.js";
import { emptyCache, pruneCache } from "../../src/sweep/cache.js";

test("interleaved stack contexts retain only their own live lifecycle detail entries", () => {
  const at = "2026-11-05T07:00:00.000Z";
  const job: JobDetail = { id: 9, name: "Deploy", status: "completed", url: "u", steps: [] };
  const run: LifecycleRun = {
    id: 7,
    name: "Refresh",
    path: "env-refresh.yml",
    event: "workflow_dispatch",
    status: "completed",
    createdAt: at,
    updatedAt: at,
    sha: "abc",
    title: "Refresh",
    url: "u",
    attempt: 1,
    kind: "refresh",
    jobs: [job],
  };
  const contexts = ["one/stack", "two/stack"].map((stackRepo, i) =>
    createContext({
      stackRepo,
      fleet: fleetOf([{ id: `fork${i}`, repo: `owner/fork${i}`, upstream: `upstream/fork${i}` }]),
    }),
  );
  const states = contexts.map((ctx) => {
    const facts = emptyFacts();
    facts.lifecycle.data = { refresh: [run], upgrade: [], smoke: [], sweeper: [] };
    const cache = emptyCache();
    for (const repo of ["one/stack", "two/stack", STACK_REPO])
      cache.details[`${repo}#9`] = {
        data: job,
        reads: [
          { source: "github", object: repo, observedAt: at, completeness: { kind: "complete" } },
        ],
      };
    return { ctx, facts, cache };
  });
  for (const state of [...states, ...[...states].reverse()]) {
    pruneCache(state.facts, state.cache, state.ctx);
    expect(Object.keys(state.cache.details)).toEqual([`${state.ctx.stackRepo}#9`]);
  }
});
