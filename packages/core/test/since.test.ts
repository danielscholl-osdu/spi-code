// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { sinceOf } from "../src/brief/since.js";
import type { ForkRuns, RunFact } from "../src/facts.js";
import { buildModel } from "../src/model/index.js";
import type { RolloutModel } from "../src/model/rollout.js";
import { fixtureContext } from "./briefing-setup.js";
import { FIXTURE_NOW, fixtureFacts } from "./harness.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing since fixture value");
  return value;
}

const from = "2026-10-11T21:58:30.000Z";
const run = (over: Partial<RunFact> = {}): RunFact => ({
  id: 1,
  name: "Sync Upstream",
  path: ".github/workflows/sync.yml",
  event: "schedule",
  status: "completed",
  conclusion: "success",
  createdAt: "2026-10-12T18:00:00Z",
  updatedAt: "2026-10-12T18:27:00Z",
  sha: "abc",
  title: "Sync",
  url: "https://example.com/run/1",
  attempt: 1,
  ...over,
});
function setup() {
  const facts = fixtureFacts();
  const model = buildModel(facts, FIXTURE_NOW, {}, fixtureContext);
  model.sweptAt = FIXTURE_NOW.toISOString();
  model.rollout = undefined;
  const data: Record<string, ForkRuns> = {};
  facts.runs = { at: model.sweptAt, data };
  for (const line of model.lines) {
    line.syncPr = undefined;
    line.templatePr = undefined;
    line.past = [];
    data[line.fork.repo] = {
      sync: [run()],
      template: [run()],
      cascade: [],
      main: [],
      history: { sync: { from, complete: false }, template: { from, complete: false } },
    };
  }
  const line = required(model.lines[0]);
  const history = required(data[line.fork.repo]);
  const read = (baseline?: string, now = FIXTURE_NOW) =>
    required(sinceOf(model, facts, now, 300_000, baseline));
  return { facts, model, line, history, read };
}

describe("since pips", () => {
  it("a failed Sync Upstream on one fork draws broken with its text", () => {
    const { history, read, line } = setup();
    history.sync = [run({ conclusion: "failure" })];
    const row = required(read().rows[0]);
    expect(row.slots[0]).toEqual({
      service: line.fork.id,
      state: "broken",
      text: `Sync Upstream failed on ${line.fork.id}.`,
    });
    expect(row.countText).toBe("4/5 ran ok");
  });
  it.each(["createdAt", "updatedAt"] as const)(
    "a sync PR %s in the run window proves occupied",
    (field) => {
      const { line, read } = setup();
      line.syncPr = {
        prClass: "sync",
        failures: [],
        pr: {
          repo: line.fork.repo,
          number: 42,
          title: "Sync",
          url: "https://example.com/pr/42",
          head: "sync/upstream",
          base: "main",
          headSha: "abc",
          draft: false,
          labels: [],
          checks: [],
          createdAt: "2026-10-10T00:00:00Z",
          updatedAt: "2026-10-12T20:00:00Z",
          [field]: "2026-10-12T18:10:00Z",
        },
      };
      expect(read().rows[0]?.slots[0]).toMatchObject({
        state: "occupied",
        text: expect.stringContaining("PR #42"),
      });
    },
  );
  it("a successful run with no provable effect draws unknown, not empty", () => {
    const { read } = setup();
    expect(read().rows[0]?.slots[0]).toMatchObject({
      state: "unknown",
      text: expect.stringContaining("ran, effect unknown"),
    });
  });
  it("template merged on 7 of 13 draws done on 7 and 7/13 merged from the rollout", () => {
    const { model, facts, line, history, read } = setup();
    model.lines = Array.from({ length: 13 }, (_, i) => ({
      ...line,
      fork: { ...line.fork, id: `fork${i}`, repo: `test/fork${i}` },
    }));
    facts.runs.data = Object.fromEntries(model.lines.map((l) => [l.fork.repo, history]));
    model.rollout = {
      target: { sha: "d3ddff5", label: "d3ddff5", url: "https://example.com/template" },
      merged: 7,
      total: 13,
      forks: model.lines.map((l, i) => ({
        service: l.fork.id,
        onTarget: i < 7,
        carries: i >= 7,
        pr: i >= 7 ? { number: 50 + i } : undefined,
      })),
    } as RolloutModel;
    const row = required(read().rows[1]);
    expect(row.countText).toBe("7/13 merged");
    expect(row.slots.map((s) => s.state)).toEqual([
      ...Array(7).fill("done"),
      ...Array(6).fill("occupied"),
    ]);
    expect(row.slots.map((s) => s.service)).toEqual(model.lines.map((l) => l.fork.id));
    expect(row.slots[0]?.text).toContain("d3ddff5");
  });
  it("uses completion rather than creation, excludes active and out-of-window runs, and accepts a seen baseline", () => {
    const { history, read } = setup();
    history.sync = [
      run({ id: 2, status: "in_progress" }),
      run({ id: 3, createdAt: "2026-10-11T18:00:00Z" }),
    ];
    expect(read("2026-10-12T18:10:00Z")).toMatchObject({
      basis: "seen",
      from: "2026-10-12T18:10:00.000Z",
    });
    expect(read().rows[0]?.countText).toBe("5/5 ran ok");
    history.sync = [run({ updatedAt: from }), run({ updatedAt: "2026-10-13T00:00:00Z" })];
    expect(read().rows[0]?.countText).toBe("4/5 ran ok");
    history.sync = [run({ status: "in_progress" })];
    expect(read().rows[0]?.slots[0]?.state).toBe("unknown");
  });
  it("reports history-short from the latest coverage boundary across forks and workflows", () => {
    const { history, read } = setup();
    required(history.history).template.from = "2026-10-12T02:10:00Z";
    expect(read()).toMatchObject({ basis: "history-short", from: "2026-10-12T02:10:00.000Z" });
  });
  it("an unread runs area is As of; stale wins when history is short too", () => {
    const { facts, history, read } = setup();
    facts.runs.at = "2026-10-12T20:00:00Z";
    required(history.history).sync.from = "2026-10-12T02:10:00Z";
    expect(read()).toMatchObject({
      basis: "stale",
      asOf: facts.runs.at,
      from: "2026-10-12T02:10:00.000Z",
    });
  });
  it("a snapshot older than twice the interval keeps the last successful runs read as asOf", () => {
    const { read, facts } = setup();
    expect(read(undefined, new Date(FIXTURE_NOW.getTime() + 600_001))).toMatchObject({
      basis: "stale",
      asOf: facts.runs.at,
      from,
    });
    expect(read()).toMatchObject({ basis: "fallback", from });
    expect(read()).not.toHaveProperty("asOf");
  });
  it("uses retained fork-run observations rather than newer failed attempts or job reads", () => {
    const { facts, model } = setup();
    const observed = "2026-10-12T20:00:00Z";
    const since = sinceOf(model, facts, FIXTURE_NOW, 300_000, undefined, [
      {
        source: "test/fork",
        object: "fork-runs",
        observedAt: facts.runs.at ?? "",
        retainedFrom: observed,
        failure: "offline",
        completeness: { kind: "complete" },
      },
      {
        source: "test/fork",
        object: "old-job",
        observedAt: "2026-10-01T00:00:00Z",
        completeness: { kind: "complete" },
      },
    ]);
    expect(since).toMatchObject({ basis: "stale", asOf: observed, from });
  });
  it("keeps missing coverage unknown and uses empty only with proof no run finished", () => {
    const { history, read, facts, line } = setup();
    line.repoRead = true;
    line.upstream = { ...line.upstream, lag: 0 } as typeof line.upstream;
    history.sync = [];
    expect(read().rows[0]?.slots[0]?.state).toBe("empty");
    history.history = undefined;
    expect(read().rows[0]?.slots[0]?.state).toBe("unknown");
    facts.runs = {};
    expect(sinceOf(setup().model, facts, FIXTURE_NOW, 300_000)).toBeUndefined();
  });
});
