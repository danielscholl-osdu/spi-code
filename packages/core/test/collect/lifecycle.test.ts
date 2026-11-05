// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import {
  JOB_LOG_LIMIT,
  jobsKey,
  loadDetailCache,
  pollRun,
  readJob,
  readLifecycle,
  readRunJobs,
} from "../../src/collect/lifecycle.js";
import { DECLARATION_PATH, STACK_REPO as STACK } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { RecordingExec, ReplayExec } from "../../src/exec/recording.js";
import type { LifecycleRun } from "../../src/facts.js";
import { Gh } from "../../src/forge.js";
import { inferMaintenance } from "../../src/model/stack.js";
import { judgeRun } from "../../src/rollout.js";

const NOW = new Date("2026-11-03T18:00:00Z");
const context = (now = NOW) => createContext({ clock: { now: () => now } });
const rawRun = (attempt = 1) => ({
  id: 7,
  name: "env-upgrade",
  path: ".github/workflows/env-upgrade.yml",
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
  created_at: "2026-11-03T13:11:58Z",
  updated_at: "2026-11-03T13:46:16Z",
  head_branch: "main",
  head_sha: "abc",
  display_title: "Bump stackVersion to v0.35.1",
  html_url: `https://github.com/${STACK}/actions/runs/7`,
  run_attempt: attempt,
});
const rawJob = (id = 1, name = "quiesce-existing-environment", attempt = 1) => ({
  id,
  name,
  status: "completed",
  conclusion: "success",
  started_at: "2026-11-03T13:12:00Z",
  completed_at: "2026-11-03T13:13:00Z",
  html_url: `https://github.com/${STACK}/actions/runs/7/job/${id}`,
  run_attempt: attempt,
  steps: [
    {
      number: 1,
      name: id === 1 ? "Set maintenance" : "Clear maintenance",
      status: "completed",
      conclusion: "success",
      started_at: "2026-11-03T13:12:00Z",
      completed_at: "2026-11-03T13:13:00Z",
    },
  ],
});
type Fixture = (path: string) => unknown;
async function replay<T>(action: (gh: Gh) => Promise<T>, fixture: Fixture) {
  let log = "";
  const exec = new RecordingExec(
    async (_cmd, args) => {
      const path =
        args[args.includes("--paginate") ? 2 : args.includes("--allow-escape-sequences") ? 2 : 1] ??
        "";
      const value = fixture(path);
      if (value instanceof Error) return { stdout: "", stderr: value.message, exit: 1 };
      const stdout =
        typeof value === "string"
          ? value
          : args.includes("--paginate")
            ? (value as unknown[]).map((v) => JSON.stringify(v)).join("\n")
            : JSON.stringify(value);
      return { stdout, stderr: "", exit: 0 };
    },
    (line) => {
      log += line;
    },
  );
  const expected = await action(new Gh(exec));
  const recorded = new ReplayExec(log);
  const actual = await action(new Gh(recorded));
  expect(actual).toEqual(expected);
  recorded.assertExhausted();
  return actual;
}
const run: LifecycleRun = {
  id: 7,
  name: "env-upgrade",
  path: rawRun().path,
  event: "workflow_dispatch",
  status: "in_progress",
  createdAt: rawRun().created_at,
  updatedAt: rawRun().updated_at,
  sha: "abc",
  title: rawRun().display_title,
  url: rawRun().html_url,
  branch: "main",
  attempt: 1,
  kind: "upgrade",
};
const empty = () => ({ runJobs: {}, files: {} });
function lifecycle(attempt = 1): Fixture {
  return (path) => {
    if (path.includes("/workflows/env-upgrade.yml/runs"))
      return { total: 1, runs: [rawRun(attempt)] };
    if (path.includes("/workflows/")) return { total: 0, runs: [] };
    if (path.includes("/jobs?"))
      return {
        total: attempt,
        jobs: attempt === 1 ? [rawJob()] : [rawJob(), rawJob(2, "verify", attempt)],
      };
    throw new Error(`Unexpected read ${path}`);
  };
}

test("ported lifecycle rerun reads the second attempt and clears maintenance on replay", async () => {
  const first = await replay((gh) => readLifecycle(gh, {}, empty(), context()), lifecycle());
  expect(inferMaintenance(first.data.upgrade).state).toBe("set");
  const second = await replay(
    (gh) =>
      readLifecycle(
        gh,
        JSON.parse(JSON.stringify(first.cache)),
        JSON.parse(JSON.stringify(first.state)),
        context(),
      ),
    lifecycle(2),
  );
  expect(inferMaintenance(second.data.upgrade).state).toBe("clear");
  expect(jobsKey(second.data.upgrade[0] ?? run)).toBe("7#2");
  const settled = await replay(
    (gh) => readLifecycle(gh, second.cache, second.state, context()),
    (path) => {
      expect(path).not.toContain("/jobs?");
      return lifecycle(2)(path);
    },
  );
  expect(settled.data).toEqual(second.data);
  expect(settled.reads.every((r) => !r.failure)).toBe(true);
});

test("lifecycle lists, job reads, declarations and polling use the context stack", async () => {
  const stackRepo = "custom/environment";
  const ctx = createContext({ ...context(), stackRepo });
  const fixture: Fixture = (path) => {
    expect(path).toMatch(/^repos\/custom\/environment\//);
    if (path.includes("/contents/")) return { text: "stackVersion: v0.35.2\n" };
    if (path.endsWith("/actions/runs/7")) return rawRun();
    const value = lifecycle()(path);
    if (path.includes("/workflows/env-upgrade.yml/runs"))
      return { total: 1, runs: [{ ...rawRun(), display_title: "Upgrade" }] };
    return value;
  };
  const result = await replay((gh) => readLifecycle(gh, {}, empty(), ctx), fixture);
  expect(Object.keys(result.cache)).toEqual([`${stackRepo}#1`]);
  const upgrade = result.data.upgrade[0];
  if (!upgrade) throw new Error("fixture has an upgrade run");
  expect(upgrade.target).toBe("v0.35.2");
  const polled = await replay(
    (gh) =>
      pollRun(
        gh,
        result.cache,
        {
          data: upgrade,
          reads: result.reads,
        },
        ctx,
      ),
    fixture,
  );
  expect(polled.reads.some((r) => r.object.startsWith(`repos/${STACK}/`))).toBe(false);
  expect(polled.reads.some((r) => r.object.startsWith(`repos/${stackRepo}/contents/`))).toBe(true);
});

test.each([
  ["Environment", "failure", 1, "environment"],
  [null, "failure", 1, "real"],
  ["Environment", "notice", 1, "real"],
  ["Environment", "failure", 2, "real"],
])(
  "ported annotation title %s level %s attempt %s judges %s",
  async (title, level, attempt, expected) => {
    const result = await replay(
      (gh) => readJob(gh, {}, STACK, 1, "Deploy and Test", context()),
      (path) => {
        if (path.includes("/annotations"))
          return [
            { level, title, message: "environment is not deployable after 10 minutes" },
            { level: "failure", message: "Process completed with exit code 1." },
          ];
        if (path.endsWith("/logs")) return new Error("no log");
        return { ...rawJob(), conclusion: "failure", run_attempt: attempt };
      },
    );
    expect(judgeRun([result.data])?.class).toBe(expected);
    expect(result.data?.failedStep).toBeUndefined();
    expect(result.data?.attempt).toBe(attempt);
  },
);

test("DetailCache round-trips JSON, never caches active jobs, and rejects corrupt entries explicitly", async () => {
  const first = await replay(
    (gh) => readJob(gh, {}, STACK, 1, "build", context()),
    () => rawJob(),
  );
  const restored = JSON.parse(JSON.stringify(first.cache));
  const cached = await replay(
    (gh) => readJob(gh, restored, STACK, 1, "build", context()),
    () => {
      throw new Error("Cache miss");
    },
  );
  expect(cached.data).toEqual(first.data);
  expect(cached.reads).toEqual(first.reads);
  expect(restored).toEqual(JSON.parse(JSON.stringify(first.cache)));
  const running = await replay(
    (gh) => readJob(gh, {}, STACK, 1, "build", context()),
    () => ({
      ...rawJob(),
      status: "in_progress",
      conclusion: null,
      started_at: null,
      completed_at: null,
    }),
  );
  expect(running.cache).toEqual({});
  expect(running.data?.conclusion).toBeUndefined();
  expect(running.data?.startedAt).toBeUndefined();
  const bad = { ...restored, bad: { data: {}, reads: [] } };
  expect(loadDetailCache(bad).dropped).toEqual(["bad"]);
  const loaded = await replay(
    (gh) => readJob(gh, bad, STACK, 1, "build", context()),
    () => {
      throw new Error("Cache miss");
    },
  );
  expect(loaded.reads[0]).toMatchObject({
    source: "persist",
    failure: expect.stringContaining("bad"),
  });
});

test("Java Build caches a final size-cut log and retries failed explanations", async () => {
  const fixture: Fixture = (path) =>
    path.includes("/annotations")
      ? [{ level: "failure", message: "annotation reason" }]
      : path.endsWith("/logs")
        ? `${"x".repeat(JOB_LOG_LIMIT)}\n[ERROR] concrete log reason\n`
        : { ...rawJob(), conclusion: "failure" };
  const result = await replay((gh) => readJob(gh, {}, STACK, 1, "Java Build", context()), fixture);
  expect(result.data?.reason).toBe("concrete log reason");
  expect(result.reads.find((r) => r.object.endsWith("/logs"))?.completeness).toMatchObject({
    kind: "cut",
    read: JOB_LOG_LIMIT,
    total: JOB_LOG_LIMIT + 29,
  });
  expect(result.cache[`${STACK}#1`]?.reads).toEqual(result.reads);
  const cached = await replay(
    (gh) =>
      readJob(gh, JSON.parse(JSON.stringify(result.cache)), STACK, 1, "Java Build", context()),
    () => {
      throw new Error("Final log should stay cached");
    },
  );
  expect(cached.data).toEqual(result.data);
  expect(cached.reads).toEqual(result.reads);
  const missing = await replay(
    (gh) => readJob(gh, {}, STACK, 1, "Java Build", context()),
    (path) => (path.endsWith("/logs") ? new Error("expired") : fixture(path)),
  );
  expect(missing.data?.reason).toBe("annotation reason");
  expect(missing.reads.some((r) => r.failure?.includes("expired"))).toBe(true);
  expect(missing.cache).toEqual({});
});

test("run jobs paginate oldest-first, keep step timing, and expose an early empty page as cut", async () => {
  const result = await replay(
    (gh) => readRunJobs(gh, {}, STACK, run, context()),
    (path) => {
      expect(path).toContain("/attempts/1/jobs?");
      return { total: 2, jobs: [path.endsWith("page=2") ? rawJob(2) : rawJob()] };
    },
  );
  expect(result.data?.map((j) => j.id)).toEqual([1, 2]);
  expect(result.data?.[0]?.steps[0]?.startedAt).toBe("2026-11-03T13:12:00Z");
  const cut = await replay(
    (gh) => readRunJobs(gh, {}, STACK, run, context()),
    (path) => ({ total: 2, jobs: path.endsWith("page=2") ? [] : [rawJob()] }),
  );
  expect(cut.reads.at(-1)?.completeness).toMatchObject({ kind: "cut", read: 1, total: 2 });
  expect(cut.cache).toEqual({});
});

test("manual targets read the declaration at the commit once and persist their original evidence", async () => {
  const fixture: Fixture = (path) =>
    path.includes("/contents/")
      ? { text: "stackVersion: v0.36.0\n" }
      : path.includes("/workflows/env-upgrade")
        ? { total: 1, runs: [{ ...rawRun(), display_title: "env-upgrade" }] }
        : lifecycle()(path);
  const first = await replay((gh) => readLifecycle(gh, {}, empty(), context()), fixture);
  expect(first.data.upgrade[0]?.target).toBe("v0.36.0");
  const next = new Date(NOW.getTime() + 60_000);
  const second = await replay(
    (gh) => readLifecycle(gh, first.cache, JSON.parse(JSON.stringify(first.state)), context(next)),
    (path) => {
      expect(path).not.toContain("/contents/");
      return fixture(path);
    },
  );
  expect(second.reads.find((r) => r.object.includes("/contents/"))?.observedAt).toBe(
    NOW.toISOString(),
  );
});

test("failed lifecycle and job reads keep prior data and the last good observation through repeated failures", async () => {
  const first = await replay((gh) => readLifecycle(gh, {}, empty(), context()), lifecycle());
  const next = new Date(NOW.getTime() + 60_000);
  for (const failedPath of ["/workflows/env-upgrade", "/jobs?"]) {
    const previous = failedPath.includes("jobs")
      ? {
          ...first.state,
          runJobs: {},
          lifecycle: first.state.lifecycle,
        }
      : first.state;
    const fixture: Fixture = (path) =>
      path.includes(failedPath) ? new Error("offline") : lifecycle()(path);
    const result = await replay((gh) => readLifecycle(gh, {}, previous, context(next)), fixture);
    if (failedPath.includes("workflows")) expect(result.data.upgrade).toEqual(first.data.upgrade);
    else expect(result.data.upgrade[0]?.jobs).toBeUndefined();
    expect(result.reads.some((r) => r.failure?.includes("offline"))).toBe(true);
    if (failedPath.includes("workflows")) {
      expect(result.reads.find((r) => r.failure)?.retainedFrom).toBe(NOW.toISOString());
      const again = await replay(
        (gh) => readLifecycle(gh, {}, result.state, context(next)),
        fixture,
      );
      expect(again.reads.find((r) => r.failure)?.retainedFrom).toBe(NOW.toISOString());
    }
  }
  const known = first.state.runJobs["7#1"];
  const failed = await replay(
    (gh) => readRunJobs(gh, {}, STACK, run, context(next), known),
    () => new Error("offline"),
  );
  expect(failed.data).toEqual(known?.data);
  expect(failed.reads.find((r) => r.failure)?.retainedFrom).toBe(NOW.toISOString());
});

test("pollRun stamps every poll with the injected clock and retains state on failure", async () => {
  const first = await replay(
    (gh) => pollRun(gh, {}, { data: run, reads: [] }, context()),
    (path) =>
      path.includes("/jobs?")
        ? { total: 1, jobs: [rawJob()] }
        : { ...rawRun(), status: "in_progress", conclusion: null },
  );
  const later = new Date(NOW.getTime() + 15_000);
  const second = await replay(
    (gh) => pollRun(gh, first.cache, first, context(later)),
    (path) => (path.includes("/jobs?") ? { total: 1, jobs: [rawJob()] } : rawRun()),
  );
  expect(first.reads[0]?.observedAt).toBe(NOW.toISOString());
  expect(second.reads[0]?.observedAt).toBe(later.toISOString());
  expect(second.data.status).toBe("completed");
  const failed = await replay(
    (gh) => pollRun(gh, second.cache, second, context(later)),
    () => new Error("offline"),
  );
  expect(failed.data).toEqual(second.data);
  expect(failed.reads[0]).toMatchObject({
    failure: expect.stringContaining("offline"),
    retainedFrom: later.toISOString(),
  });
  const jobsFailed = await replay(
    (gh) => pollRun(gh, {}, first, context(later)),
    (path) => (path.includes("/jobs?") ? new Error("jobs offline") : rawRun()),
  );
  expect(jobsFailed.data.jobs).toEqual(first.data.jobs);
  expect(jobsFailed.reads.find((r) => r.failure)?.retainedFrom).toBe(NOW.toISOString());
});

test("invalid lifecycle JSON is discarded with evidence and other workflows still read after one fails", async () => {
  const result = await replay(
    (gh) => readLifecycle(gh, {}, { runJobs: "bad" }, context()),
    (path) => (path.includes("env-upgrade") ? new Error("denied") : lifecycle()(path)),
  );
  expect(result.reads.filter((r) => r.failure)).toHaveLength(2);
  expect(result.reads[0]?.source).toBe("persist");
  expect(result.reads.filter((r) => !r.failure)).toHaveLength(3);
});

test("lifecycle pages deduplicate runs and report a non-progressing page as cut", async () => {
  const result = await replay(
    (gh) => readLifecycle(gh, {}, empty(), context()),
    (path) => {
      if (path.includes("/workflows/smoke.yml/"))
        return {
          total: 3,
          runs: path.endsWith("page=1") ? [rawRun()] : [{ ...rawRun(), id: 8 }],
        };
      if (path.includes("/workflows/")) return { total: 0, runs: [] };
      throw new Error(`Unexpected read ${path}`);
    },
  );
  expect(result.data.smoke.map((r) => r.id)).toEqual([7, 8]);
  expect(result.reads.find((r) => r.completeness.kind === "cut")?.completeness).toMatchObject({
    kind: "cut",
    read: 2,
    total: 3,
  });
});

test("legacy untimed jobs refresh once and failed active-job reads retain their previous state", async () => {
  const fixture: Fixture = (path) =>
    path.includes("/workflows/env-upgrade")
      ? { total: 1, runs: [{ ...rawRun(), status: "in_progress", conclusion: null }] }
      : lifecycle()(path);
  const first = await replay((gh) => readLifecycle(gh, {}, empty(), context()), fixture);
  const snapshot = JSON.stringify(first.state);
  const failed = await replay(
    (gh) => readLifecycle(gh, first.cache, first.state, context()),
    (path) => (path.includes("/jobs?") ? new Error("offline") : fixture(path)),
  );
  expect(failed.data.upgrade[0]?.jobs).toEqual(first.data.upgrade[0]?.jobs);
  expect(failed.reads.find((r) => r.failure)?.retainedFrom).toBe(NOW.toISOString());
  expect(JSON.stringify(first.state)).toBe(snapshot);
  const legacy = JSON.parse(snapshot);
  legacy.runJobs["7#1"].data[0].steps[0].startedAt = undefined;
  const refreshed = await replay((gh) => readLifecycle(gh, {}, legacy, context()), lifecycle());
  expect(refreshed.reads.some((r) => r.object.includes("/jobs?"))).toBe(true);
  expect(refreshed.data.upgrade[0]?.jobs?.[0]?.steps[0]?.startedAt).toBe(
    rawJob().steps[0]?.started_at,
  );
});

test("polling a new attempt never retains previous-attempt jobs when their read fails", async () => {
  const first = await replay(
    (gh) => pollRun(gh, {}, { data: run, reads: [] }, context()),
    (path) => (path.includes("/jobs?") ? { total: 1, jobs: [rawJob()] } : rawRun()),
  );
  const next = await replay(
    (gh) => pollRun(gh, first.cache, first, context()),
    (path) => (path.includes("/jobs?") ? new Error("offline") : rawRun(2)),
  );
  expect(next.data.attempt).toBe(2);
  expect(next.data.jobs).toBeUndefined();
  expect(next.reads.find((r) => r.failure)?.retainedFrom).toBeUndefined();
});

test("a missing declaration and unread job have failure evidence rather than success-shaped defaults", async () => {
  const job = await replay(
    (gh) => readJob(gh, {}, STACK, 1, "build", context()),
    () => new Error("not found"),
  );
  expect(job.data).toBeUndefined();
  expect(job.reads[0]?.failure).toContain("not found");
  const target = await replay(
    (gh) => readLifecycle(gh, {}, empty(), context()),
    (path) =>
      path.includes("/contents/")
        ? { text: "not-a-declaration" }
        : path.includes("/workflows/env-upgrade")
          ? {
              total: 1,
              runs: [{ ...rawRun(), display_title: "manual" }],
            }
          : lifecycle()(path),
  );
  expect(target.data.upgrade[0]?.target).toBeUndefined();
  expect(target.reads.find((r) => r.object.includes("/contents/"))?.failure).toContain(
    "stackVersion",
  );
  expect(target.state.files).toEqual({});
});

test.each([0, 1])(
  "active snapshot with %i jobs is fetched again after completion",
  async (count) => {
    const first = await replay(
      (gh) => readLifecycle(gh, {}, empty(), context()),
      (path) => {
        if (path.includes("/workflows/env-upgrade"))
          return {
            total: 1,
            runs: [{ ...rawRun(), status: "in_progress", conclusion: null }],
          };
        if (path.includes("/jobs?"))
          return {
            total: count,
            jobs: Array.from({ length: count }, (_, i) => rawJob(i + 1)),
          };
        return lifecycle()(path);
      },
    );
    const completed: Fixture = (path) =>
      path.includes("/jobs?")
        ? {
            total: count + 1,
            jobs: Array.from({ length: count + 1 }, (_, i) => rawJob(i + 1)),
          }
        : lifecycle()(path);
    const second = await replay(
      (gh) => readLifecycle(gh, first.cache, JSON.parse(JSON.stringify(first.state)), context()),
      completed,
    );
    expect(second.data.upgrade[0]?.jobs).toHaveLength(count + 1);
    const settled = await replay(
      (gh) => readLifecycle(gh, second.cache, second.state, context()),
      (path) => {
        if (path.includes("/jobs?")) throw new Error("Completed snapshot should settle");
        return completed(path);
      },
    );
    expect(settled.data).toEqual(second.data);
    expect(settled.reads.every((r) => !r.failure)).toBe(true);
  },
);

test("successful polls retain target declaration evidence but not superseded run and job reads", async () => {
  const declaration = `repos/${STACK}/contents/${DECLARATION_PATH}?ref=abc`;
  const first = await replay(
    (gh) => readLifecycle(gh, {}, empty(), context()),
    (path) =>
      path === declaration
        ? { text: "stackVersion: v0.36.0\n" }
        : path.includes("/workflows/env-upgrade")
          ? {
              total: 1,
              runs: [{ ...rawRun(), display_title: "manual", status: "in_progress" }],
            }
          : lifecycle()(path),
  );
  const data = first.data.upgrade[0];
  if (!data) throw new Error("Expected upgrade fixture");
  const supporting = first.reads.filter((r) => r.object === declaration);
  const support = supporting[0];
  if (!support) throw new Error("Expected declaration evidence");
  const next = new Date(NOW.getTime() + 15_000);
  const polled = await replay(
    (gh) =>
      pollRun(
        gh,
        {},
        {
          data,
          reads: [...first.reads, { ...support, object: `${declaration}-other` }],
        },
        context(next),
      ),
    (path) =>
      path.includes("/jobs?")
        ? { total: 1, jobs: [rawJob()] }
        : { ...rawRun(), display_title: "manual" },
  );
  expect(polled.data.target).toBe("v0.36.0");
  expect(polled.reads.filter((r) => r.object.includes("/contents/"))).toEqual(supporting);
  expect(
    polled.reads
      .filter((r) => !r.object.includes("/contents/"))
      .every((r) => r.observedAt === next.toISOString()),
  ).toBe(true);
  expect(polled.reads.some((r) => r.object.includes("/workflows/"))).toBe(false);
  const again = await replay(
    (gh) => pollRun(gh, {}, polled, context(next)),
    (path) =>
      path.includes("/jobs?")
        ? { total: 1, jobs: [rawJob()] }
        : { ...rawRun(), display_title: "manual" },
  );
  expect(again.reads.filter((r) => r.object === declaration)).toEqual(supporting);
});

test("completed runs settle with cached size-cut log evidence while other cuts and failures retry", async () => {
  const seed = await replay(
    (gh) => readJob(gh, {}, STACK, 1, "Java Build", context()),
    (path) =>
      path.endsWith("/logs")
        ? `${"x".repeat(JOB_LOG_LIMIT)}\n[ERROR] build failed\n`
        : path.includes("/annotations")
          ? []
          : { ...rawJob(), conclusion: "failure" },
  );
  expect(seed.cache[`${STACK}#1`]).toBeDefined();
  const fixture: Fixture = (path) =>
    path.includes("/annotations")
      ? [{ level: "failure", message: "retry explanation" }]
      : path.includes("/jobs?")
        ? { total: 1, jobs: [{ ...rawJob(), conclusion: "failure" }] }
        : lifecycle()(path);
  const first = await replay((gh) => readLifecycle(gh, seed.cache, empty(), context()), fixture);
  const second = await replay(
    (gh) =>
      readLifecycle(
        gh,
        JSON.parse(JSON.stringify(first.cache)),
        JSON.parse(JSON.stringify(first.state)),
        context(),
      ),
    (path) => {
      if (!path.includes("/workflows/")) throw new Error("Size-cut log must not be fetched again");
      return fixture(path);
    },
  );
  expect(second.data).toEqual(first.data);
  expect(second.reads.some((r) => r.failure)).toBe(false);
  expect(second.reads.find((r) => r.object.endsWith("/logs"))).toMatchObject({
    completeness: { kind: "cut", read: JOB_LOG_LIMIT },
  });
  for (const change of ["failure", "other-cut"]) {
    const state = JSON.parse(JSON.stringify(first.state));
    const cache = JSON.parse(JSON.stringify(first.cache));
    for (const reads of [state.runJobs["7#1"].reads, cache[`${STACK}#1`].reads]) {
      const log = reads.find((r: { object: string }) => r.object.endsWith("/logs"));
      if (change === "failure") log.failure = "expired";
      else log.completeness.reason = "Run jobs page limit or short read";
    }
    let reread = false;
    await replay(
      (gh) => readLifecycle(gh, cache, state, context()),
      (path) => {
        if (path.includes("/jobs?")) reread = true;
        return fixture(path);
      },
    );
    expect(reread).toBe(true);
  }
});

test("readJob sees refreshed steps written back by a run-jobs cache hit", async () => {
  const job = { ...rawJob(), conclusion: "failure" };
  const first = await replay(
    (gh) => readJob(gh, {}, STACK, 1, "Java Build", context()),
    (path) =>
      path.includes("/annotations")
        ? [{ level: "failure", title: "Environment", message: "annotation reason" }]
        : path.endsWith("/logs")
          ? "[ERROR] reused log reason\n"
          : job,
  );
  const explanation = first.reads.filter(
    (r) => r.object.includes("/annotations") || r.object.endsWith("/logs"),
  );
  expect(explanation).toHaveLength(2);
  expect(explanation.every((r) => r.observedAt === NOW.toISOString())).toBe(true);
  const step = job.steps[0];
  if (!step) throw new Error("Expected step fixture");
  const later = new Date(NOW.getTime() + 60_000);
  const fresh = {
    ...job,
    steps: [{ ...step, name: "Refreshed step", completed_at: later.toISOString() }],
  };
  const refreshed = await replay(
    (gh) => readRunJobs(gh, first.cache, STACK, run, context(later)),
    () => ({ total: 1, jobs: [fresh] }),
  );
  const single = await replay(
    (gh) => readJob(gh, refreshed.cache, STACK, 1, "Java Build", context(later)),
    () => {
      throw new Error("Expected refreshed cache hit");
    },
  );
  expect(single.data?.steps).toEqual(refreshed.data?.[0]?.steps);
  expect(single.data?.steps[0]?.name).toBe("Refreshed step");
  expect(single.data?.steps[0]?.completedAt).toBe(later.toISOString());
  expect(single.data?.reason).toBe("reused log reason");
  expect(single.data?.environment).toEqual(["annotation reason"]);
  expect(first.data?.steps[0]?.name).toBe("Set maintenance");
  const listingPath = `repos/${STACK}/actions/runs/7/attempts/1/jobs?per_page=100&page=1`;
  expect(single.reads).toEqual([
    {
      source: "github",
      object: listingPath,
      observedAt: later.toISOString(),
      completeness: { kind: "complete" },
    },
    ...explanation,
  ]);
  expect(refreshed.reads).toEqual(single.reads);
  const latest = new Date(later.getTime() + 60_000);
  const reread = await replay(
    (gh) => readRunJobs(gh, JSON.parse(JSON.stringify(single.cache)), STACK, run, context(latest)),
    () => ({ total: 1, jobs: [fresh] }),
  );
  const last = await replay(
    (gh) => readJob(gh, reread.cache, STACK, 1, "Java Build", context(latest)),
    () => {
      throw new Error("Expected refreshed cache hit");
    },
  );
  expect(last.reads).toEqual([
    {
      source: "github",
      object: listingPath,
      observedAt: latest.toISOString(),
      completeness: { kind: "complete" },
    },
    ...explanation,
  ]);
  expect(reread.reads).toEqual(last.reads);
});

test.each([undefined, null])(
  "cold lifecycle state %s starts empty without a persistence failure",
  async (previous) => {
    const result = await replay((gh) => readLifecycle(gh, {}, previous, context()), lifecycle());
    expect(result.data.upgrade).toHaveLength(1);
    expect(result.reads.some((r) => r.source === "persist")).toBe(false);
    const malformed = await replay(
      (gh) => readLifecycle(gh, {}, { runJobs: "bad" }, context()),
      lifecycle(),
    );
    expect(malformed.reads.find((r) => r.source === "persist")).toMatchObject({
      object: "lifecycle-cache",
      failure: "Dropped invalid lifecycle cache",
    });
  },
);
