// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test, vi } from "vitest";
import { z } from "zod";
import { fleetOf, STACK_REPO as STACK } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import type { ReadRecord } from "../../src/evidence/index.js";
import type { Exec, ExecOutput } from "../../src/exec/port.js";
import { RecordingExec, ReplayExec } from "../../src/exec/recording.js";
import { AREAS, emptyFacts, type Facts, type LifecycleRun, type RunFact } from "../../src/facts.js";
import { createSweeper } from "../../src/sweep/areas.js";
import { type CollectorCache, cacheSchema, emptyCache } from "../../src/sweep/cache.js";
import { collectorInflight, progress } from "../../src/sweep/inflight.js";
import { Sweeper, type SweepReads } from "../../src/sweep/sweeper.js";

const T0 = Date.parse("2026-10-12T21:50:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const FORK = "owner/partition";
const RUN = 900;
const RUN_PATH = `repos/${STACK}/actions/runs/${RUN}`;
const JOBS_PATH = `${RUN_PATH}/attempts/1/jobs?per_page=100&page=1`;
const LISTING = `repos/${STACK}/actions/workflows/env-upgrade.yml/runs?per_page=60&created=%3E%3D2026-09-12&page=1`;
const TEMPLATE_RUNS = `repos/${FORK}/actions/workflows/sync-template.yml/runs?per_page=5`;
const factsSchema = z.custom<Facts>(
  (v) => !!v && typeof v === "object" && AREAS.every((a) => a in v),
);

function record(object: string, observedAt: string, source = "github"): ReadRecord {
  return { source, object, observedAt, completeness: { kind: "complete" } };
}

function job(done: boolean) {
  return {
    id: 901,
    name: "verify",
    status: done ? "completed" : "in_progress",
    conclusion: done ? "success" : null,
    started_at: "2026-10-12T21:50:00Z",
    completed_at: done ? "2026-10-12T22:20:00Z" : null,
    html_url: `https://github.com/${STACK}/actions/runs/${RUN}/job/901`,
    steps: [
      {
        number: 1,
        name: "Wait for Flux Kustomizations to be Ready",
        status: done ? "completed" : "in_progress",
        conclusion: done ? "success" : null,
      },
      {
        number: 2,
        name: "Clear maintenance",
        status: done ? "completed" : "queued",
        conclusion: done ? "success" : null,
      },
    ],
  };
}

function rawRun(done: boolean) {
  return {
    id: RUN,
    name: "Environment Upgrade",
    path: ".github/workflows/env-upgrade.yml",
    event: "push",
    status: done ? "completed" : "in_progress",
    conclusion: done ? "success" : null,
    created_at: "2026-10-12T21:42:00Z",
    updated_at: done ? "2026-10-12T22:20:00Z" : "2026-10-12T21:50:00Z",
    head_branch: "main",
    head_sha: "abc",
    display_title: "chore(env): bump shared stackVersion to v0.28.2 (#335)",
    html_url: `https://github.com/${STACK}/actions/runs/${RUN}`,
    run_attempt: 1,
  };
}

function inflightRun(): LifecycleRun {
  return {
    id: RUN,
    kind: "upgrade",
    name: "Environment Upgrade",
    path: ".github/workflows/env-upgrade.yml",
    event: "push",
    status: "in_progress",
    createdAt: "2026-10-12T21:42:00Z",
    updatedAt: "2026-10-12T21:50:00Z",
    branch: "main",
    sha: "abc",
    title: "chore(env): bump shared stackVersion to v0.28.2 (#335)",
    url: `https://github.com/${STACK}/actions/runs/${RUN}`,
    attempt: 1,
    target: "v0.28.2",
    jobs: [
      {
        id: 901,
        name: "verify",
        status: "in_progress",
        startedAt: "2026-10-12T21:50:00Z",
        url: `https://github.com/${STACK}/actions/runs/${RUN}/job/901`,
        steps: [
          { number: 1, name: "Wait for Flux Kustomizations to be Ready", status: "in_progress" },
          { number: 2, name: "Clear maintenance", status: "queued" },
        ],
      },
    ],
  };
}

function templateRun(status: string, conclusion: string | null) {
  return {
    id: 77,
    name: "Sync Template",
    path: ".github/workflows/sync-template.yml",
    event: "workflow_dispatch",
    status,
    conclusion,
    created_at: "2026-10-12T21:48:33Z",
    updated_at: "2026-10-12T21:48:40Z",
    head_branch: "main",
    head_sha: "abc",
    display_title: "Sync Template",
    html_url: `https://github.com/${FORK}/actions/runs/77`,
    run_attempt: 1,
  };
}

function toRunFact(raw: ReturnType<typeof templateRun>): RunFact {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.path,
    event: raw.event,
    status: raw.status,
    ...(raw.conclusion ? { conclusion: raw.conclusion } : {}),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    branch: raw.head_branch,
    sha: raw.head_sha,
    title: raw.display_title,
    url: raw.html_url,
    attempt: raw.run_attempt,
  };
}

interface Seed {
  upgrade?: LifecycleRun[];
  template?: RunFact[];
  reads?: SweepReads;
}

function seeded({ upgrade = [inflightRun()], template = [], reads }: Seed) {
  const facts = emptyFacts();
  facts.lifecycle = {
    at: at(0),
    data: { refresh: [], upgrade, smoke: [], sweeper: [] },
  };
  facts.runs = {
    at: at(0),
    data: { [FORK]: { sync: [], template, cascade: [], main: [] } },
  };
  return {
    facts,
    cache: emptyCache(),
    reads: reads ?? {
      lifecycle: [record(LISTING, at(0)), record(JOBS_PATH, at(0))],
      runs: [record("fork-runs", at(0), FORK)],
    },
  };
}

type Route = (path: string) => unknown;

function harness(seed: Seed, route: Route, opts: { exec?: Exec; stackRepo?: string } = {}) {
  let time = T0;
  let log = "";
  const calls: string[] = [];
  const clock = { now: () => new Date(time) };
  const ctx = createContext({
    fleet: fleetOf([
      { id: "partition", repo: FORK, upstream: "osdu/partition", seeded: "2026-10-01" },
    ]),
    clock,
    ...(opts.stackRepo ? { stackRepo: opts.stackRepo } : {}),
  });
  const exec =
    opts.exec ??
    new RecordingExec(
      async (_cmd, args): Promise<ExecOutput> => {
        const path = args.find((a) => a.startsWith("repos/")) ?? "";
        calls.push(path);
        const value = route(path);
        if (value instanceof Error) return { stdout: "", stderr: value.message, exit: 1 };
        return { stdout: JSON.stringify(value), stderr: "", exit: 0 };
      },
      (line) => {
        log += line;
      },
    );
  const state = seeded(seed);
  let saves = 0;
  const sweeper = new Sweeper<CollectorCache>({
    ctx,
    clock,
    exec,
    persist: {
      load: async () => structuredClone(state),
      save: async () => {
        saves++;
      },
    },
    areas: [],
    factsSchema,
    cacheSchema,
    emptyCache,
    inflight: collectorInflight,
  });
  return {
    sweeper,
    calls,
    log: () => log,
    saves: () => saves,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function stackRoute(state: { done: boolean; offline?: boolean }): Route {
  return (path) => {
    if (state.offline) return new Error("gh offline");
    if (path === RUN_PATH) return rawRun(state.done);
    if (path === JOBS_PATH) return { total: 1, jobs: [job(state.done)] };
    return new Error(`unrouted ${path}`);
  };
}

const runRecord = (reads: SweepReads) => reads.lifecycle?.find((r) => r.object === RUN_PATH);

test("polls an in-flight run in the context's own stack repository and retains from its listing", async () => {
  const custom = "custom/environment";
  const run = `repos/${custom}/actions/runs/${RUN}`;
  const jobs = `${run}/attempts/1/jobs?per_page=100&page=1`;
  const listing = LISTING.replace(STACK, custom);
  const state = { offline: false };
  const h = harness(
    { reads: { lifecycle: [record(listing, at(0)), record(jobs, at(0))], runs: [] } },
    (path) => {
      if (state.offline) return new Error("gh offline");
      if (path === run) return rawRun(false);
      if (path === jobs) return { total: 1, jobs: [job(false)] };
      return new Error(`unrouted ${path}`);
    },
    { stackRepo: custom },
  );
  state.offline = true;
  h.advance(15_000);
  await h.sweeper.pollInflight();
  expect(h.calls[0]).toBe(run);
  const failed = h.sweeper.reads.lifecycle?.find((r) => r.object === run);
  expect(failed?.failure).toBeDefined();
  expect(failed?.retainedFrom).toBe(at(0));
  expect(h.sweeper.reads.lifecycle?.some((r) => r.object.includes(STACK))).toBe(false);
});

test("on replay an in-flight run is polled until done, updating Facts with each poll's observedAt", async () => {
  const state = { done: false };
  const h = harness({}, stackRoute(state));
  const trace: unknown[] = [];
  const step = async (sweeper: Sweeper<CollectorCache>) => {
    await sweeper.pollInflight();
    trace.push(structuredClone({ facts: sweeper.facts, reads: sweeper.reads }));
  };

  h.advance(15_000);
  await step(h.sweeper);
  expect(h.sweeper.facts.lifecycle.data?.upgrade[0]?.status).toBe("in_progress");
  expect(runRecord(h.sweeper.reads)?.observedAt).toBe(at(15_000));
  expect(h.sweeper.reads.lifecycle?.find((r) => r.object === JOBS_PATH)?.observedAt).toBe(
    at(15_000),
  );
  expect(h.sweeper.reads.lifecycle?.filter((r) => r.object === JOBS_PATH)).toHaveLength(1);
  expect(h.sweeper.reads.lifecycle?.find((r) => r.object === LISTING)?.observedAt).toBe(at(0));
  expect(h.sweeper.hasInflight()).toBe(true);

  state.done = true;
  h.advance(15_000);
  await step(h.sweeper);
  const done = h.sweeper.facts.lifecycle.data?.upgrade[0];
  expect(done).toMatchObject({ status: "completed", conclusion: "success" });
  expect(done?.jobs?.[0]?.steps.map((s) => s.conclusion)).toEqual(["success", "success"]);
  expect(runRecord(h.sweeper.reads)?.observedAt).toBe(at(30_000));
  expect(h.sweeper.hasInflight()).toBe(false);
  expect(h.sweeper.facts.sweep?.at).toBe(at(30_000));
  expect(h.saves()).toBe(1);
  expect(h.calls).toEqual([RUN_PATH, JOBS_PATH, RUN_PATH, JOBS_PATH]);

  const recorded = new ReplayExec(h.log());
  const replay = harness({}, () => new Error("replay only"), { exec: recorded });
  replay.advance(15_000);
  await replay.sweeper.pollInflight();
  expect(structuredClone({ facts: replay.sweeper.facts, reads: replay.sweeper.reads })).toEqual(
    trace[0],
  );
  replay.advance(15_000);
  await replay.sweeper.pollInflight();
  expect(structuredClone({ facts: replay.sweeper.facts, reads: replay.sweeper.reads })).toEqual(
    trace[1],
  );
  recorded.assertExhausted();
});

test("a failed poll keeps the last state with a failure record and its retained observation", async () => {
  const state = { done: false, offline: true };
  const h = harness({}, stackRoute(state));

  h.advance(15_000);
  await h.sweeper.pollInflight();
  expect(h.sweeper.facts.lifecycle.data?.upgrade[0]).toEqual(inflightRun());
  expect(runRecord(h.sweeper.reads)).toMatchObject({
    observedAt: at(15_000),
    failure: expect.stringContaining("gh offline"),
    retainedFrom: at(0),
  });
  expect(h.sweeper.hasInflight()).toBe(true);

  state.offline = false;
  h.advance(15_000);
  await h.sweeper.pollInflight();
  const polled = structuredClone(h.sweeper.facts.lifecycle.data?.upgrade[0]);
  expect(runRecord(h.sweeper.reads)?.failure).toBeUndefined();

  state.offline = true;
  h.advance(15_000);
  await h.sweeper.pollInflight();
  expect(h.sweeper.facts.lifecycle.data?.upgrade[0]).toEqual(polled);
  expect(runRecord(h.sweeper.reads)).toMatchObject({
    observedAt: at(45_000),
    failure: expect.stringContaining("gh offline"),
    retainedFrom: at(30_000),
  });
  expect(h.sweeper.reads.lifecycle?.find((r) => r.object === JOBS_PATH)?.observedAt).toBe(
    at(30_000),
  );
  expect(h.sweeper.facts.sweep).toBeUndefined();

  const fork = harness(
    { upgrade: [], template: [toRunFact(templateRun("queued", null))] },
    () => new Error("gh offline"),
  );
  fork.advance(15_000);
  await fork.sweeper.pollInflight();
  expect(fork.sweeper.facts.runs.data?.[FORK]?.template).toEqual([
    toRunFact(templateRun("queued", null)),
  ]);
  expect(fork.sweeper.reads.runs).toEqual([
    record("fork-runs", at(0), FORK),
    {
      ...record("template-runs", at(15_000), FORK),
      failure: expect.stringContaining("gh offline"),
      retainedFrom: at(0),
    },
  ]);
  expect(fork.sweeper.hasInflight()).toBe(true);
});

test("nothing is polled when nothing is in flight", async () => {
  const completed: LifecycleRun = { ...inflightRun(), status: "completed", conclusion: "success" };
  const h = harness(
    { upgrade: [completed], template: [toRunFact(templateRun("completed", "success"))] },
    () => new Error("must not be called"),
  );
  await h.sweeper.pollInflight();
  const loaded = structuredClone({ facts: h.sweeper.facts, reads: h.sweeper.reads });
  const model = h.sweeper.model;
  expect(h.sweeper.hasInflight()).toBe(false);
  h.advance(15_000);
  await h.sweeper.pollInflight();
  expect(h.calls).toEqual([]);
  expect(h.saves()).toBe(0);
  expect(h.sweeper.model).toBe(model);
  expect({ facts: h.sweeper.facts, reads: h.sweeper.reads }).toEqual(loaded);

  const snapshot = seeded({});
  let snapshotCalls = 0;
  const replayed = createSweeper({
    ctx: createContext({ clock: { now: () => new Date(T0) } }),
    exec: {
      runJSON: async () => {
        snapshotCalls++;
        return { ok: false, error: "offline", code: null };
      },
      runText: async () => {
        snapshotCalls++;
        return { ok: false, error: "offline", code: null };
      },
    },
    persist: { load: async () => undefined, save: async () => {} },
    factsSchema,
    replay: async () => structuredClone(snapshot),
  });
  await replayed.sweep();
  expect(replayed.facts.lifecycle.data?.upgrade[0]?.status).toBe("in_progress");
  expect(replayed.hasInflight()).toBe(false);
  await replayed.pollInflight();
  expect(snapshotCalls).toBe(0);
});

test("the collector sweeper loads persisted in-flight runs and polls them", async () => {
  const state = { done: false };
  const calls: string[] = [];
  const route = stackRoute(state);
  const sweeper = createSweeper({
    ctx: createContext({ clock: { now: () => new Date(T0 + 15_000) } }),
    exec: {
      runJSON: async <T>(_cmd: string, args: string[]) => {
        const path = args.find((a) => a.startsWith("repos/")) ?? "";
        calls.push(path);
        const value = route(path);
        return value instanceof Error
          ? { ok: false as const, error: value.message, code: 1 }
          : { ok: true as const, data: value as T };
      },
      runText: async () => ({ ok: false, error: "offline", code: 1 }),
    },
    persist: { load: async () => seeded({}), save: async () => {} },
    factsSchema,
  });
  expect(sweeper.hasInflight()).toBe(false);
  await sweeper.pollInflight();
  expect(calls).toEqual([RUN_PATH, JOBS_PATH]);
  expect(sweeper.hasInflight()).toBe(true);
  expect(runRecord(sweeper.reads)?.observedAt).toBe(at(15_000));
});

// Ported from keelson-rib-spi@59d6895 test/sweep.test.ts "the in-flight poll".
test("recomposes only when the run moved, and sweeps once it settles", async () => {
  const state = { done: false };
  const h = harness({}, stackRoute(state));
  await h.sweeper.pollInflight();
  const loaded = h.sweeper.model;
  expect(h.sweeper.hasInflight()).toBe(true);

  h.advance(15_000);
  await h.sweeper.pollInflight();
  expect(h.sweeper.model).toBe(loaded);

  state.done = true;
  h.advance(15_000);
  await h.sweeper.pollInflight();
  expect(h.sweeper.model).not.toBe(loaded);
  expect(h.sweeper.hasInflight()).toBe(false);
  expect(h.sweeper.model.stack.maintenance.state).toBe("clear");
  expect(h.sweeper.facts.sweep?.at).toBe(at(30_000));
});

// Ported from the same rib case's Sync Template run; its dispatch hold stays in the rib (M4).
test("a Sync Template run reads queued, then settles into a sweep", async () => {
  const run: { status: string; conclusion: string | null } = {
    status: "queued",
    conclusion: null,
  };
  const reads: string[] = [];
  const h = harness({ upgrade: [], template: [toRunFact(templateRun("queued", null))] }, (path) => {
    if (path !== TEMPLATE_RUNS) return new Error(`unrouted ${path}`);
    reads.push(path);
    return { total: 1, runs: [templateRun(run.status, run.conclusion)] };
  });
  await h.sweeper.pollInflight();
  const loaded = h.sweeper.model;
  expect(reads).toHaveLength(1);
  expect(h.sweeper.model).toBe(loaded);
  expect(h.sweeper.hasInflight()).toBe(true);

  run.status = "in_progress";
  h.advance(15_000);
  await h.sweeper.pollInflight();
  expect(h.sweeper.model).not.toBe(loaded);
  expect(h.sweeper.facts.runs.data?.[FORK]?.template[0]?.status).toBe("in_progress");
  expect(h.sweeper.reads.runs?.filter((r) => r.object === "template-runs")).toEqual([
    record("template-runs", at(15_000), FORK),
  ]);
  expect(h.sweeper.facts.sweep).toBeUndefined();

  run.status = "completed";
  run.conclusion = "success";
  h.advance(15_000);
  await h.sweeper.pollInflight();
  expect(h.sweeper.hasInflight()).toBe(false);
  expect(h.sweeper.facts.runs.data?.[FORK]?.template[0]).toMatchObject({
    status: "completed",
    conclusion: "success",
  });
  expect(h.sweeper.facts.sweep?.at).toBe(at(30_000));
});

test("a poll never overlaps a sweep, and a sweep that starts mid-poll wins", async () => {
  const state = { done: true };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const route = stackRoute(state);
  const calls: string[] = [];
  const exec: Exec = {
    runJSON: async <T>(_cmd: string, args: string[]) => {
      const path = args.find((a) => a.startsWith("repos/")) ?? "";
      calls.push(path);
      await gate;
      return { ok: true as const, data: route(path) as T };
    },
    runText: async () => ({ ok: false, error: "offline", code: 1 }),
  };
  const h = harness({}, route, { exec });
  await h.sweeper.sweep();
  expect(h.saves()).toBe(1);
  const polling = h.sweeper.pollInflight();
  expect(h.sweeper.pollInflight()).toBe(polling);
  await vi.waitFor(() => expect(calls).toEqual([RUN_PATH]));
  const sweeping = h.sweeper.sweep();
  await h.sweeper.pollInflight();
  release();
  await Promise.all([polling, sweeping]);
  expect(calls).toEqual([RUN_PATH, JOBS_PATH]);
  expect(h.sweeper.facts.lifecycle.data?.upgrade[0]?.status).toBe("in_progress");
  expect(runRecord(h.sweeper.reads)).toBeUndefined();
  expect(h.saves()).toBe(2);
});

test("progress follows status and conclusions, not timestamps", () => {
  const run = inflightRun();
  const moved = structuredClone(run);
  moved.updatedAt = "2026-10-12T22:00:00Z";
  expect(progress(moved)).toBe(progress(run));
  const stepped = structuredClone(run);
  const step = stepped.jobs?.[0]?.steps[1];
  if (step) step.status = "in_progress";
  expect(progress(stepped)).not.toBe(progress(run));
  expect(progress({ ...run, jobs: undefined })).toBe(progress({ ...run, jobs: [] }));
});
