// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import { serviceRuns } from "../../src/brief/service-runs.js";
import { readServiceRuns } from "../../src/collect/service-runs.js";
import { fleetOf } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { RecordingExec } from "../../src/exec/recording.js";
import { Gh } from "../../src/forge.js";
import type { ServiceRunsFact } from "../../src/service-runs.js";

const repo = "test/search";
const now = "2026-11-16T09:00:00Z";
const ctx = createContext({
  fleet: fleetOf([{ id: "search", repo, upstream: "test/search" }]),
  clock: { now: () => new Date(now) },
});
const run = (id: number, overrides = {}) => ({
  id,
  workflowId: 31,
  name: "Validation",
  attempt: 1,
  status: "completed",
  conclusion: "success",
  createdAt: "2026-11-16T03:00:00Z",
  startedAt: "2026-11-16T03:01:00Z",
  url: `https://github.com/${repo}/actions/runs/${id}`,
  ...overrides,
});
const workflowRunsPath = `repos/${repo}/actions/workflows/31/runs?per_page=10`;
const carriedFailure = {
  run: run(1, {
    conclusion: "failure",
    createdAt: "2026-10-01T03:00:00Z",
    startedAt: "2026-10-01T03:01:00Z",
  }),
  job: "Build",
  step: "Run Maven",
};
const previousSweep = {
  [repo]: {
    history: { cut: false, runs: [], failures: [carriedFailure] },
    read: { source: "runs", object: repo, observedAt: now, completeness: { kind: "complete" } },
    jobs: [],
  },
} satisfies Record<string, ServiceRunsFact>;
const emptyPage = { total: 0, runs: [] };
const recentPage = { total: 1, runs: [run(2, { workflowId: 32 })] };
const job = {
  id: 91,
  name: "Build",
  status: "completed",
  conclusion: "failure",
  started_at: "2026-11-16T03:02:00Z",
  completed_at: "2026-11-16T03:05:00Z",
  html_url: `https://github.com/${repo}/actions/runs/1/job/91`,
  steps: [{ number: 1, name: "Run Maven", status: "completed", conclusion: "failure" }],
};

async function fixture(
  output: unknown,
  jobsFor: (path: string) => unknown = () => ({ total: 1, jobs: [job] }),
  previous: Record<string, ServiceRunsFact> = {},
  workflowRuns: unknown = emptyPage,
) {
  const paths: string[] = [];
  const gh = new Gh(
    new RecordingExec(
      async (command, args) => {
        expect(command).toBe("gh");
        expect(args[0]).toBe("api");
        const path = args[1] ?? "";
        paths.push(path);
        if (!path.includes("/jobs?")) expect(args[3]).toMatch(/\bpath\b/);
        const reply = path.includes("/jobs?")
          ? jobsFor(path)
          : path === workflowRunsPath
            ? workflowRuns
            : output;
        return reply instanceof Error
          ? { exit: 1, stderr: reply.message, stdout: "" }
          : { exit: 0, stderr: "", stdout: JSON.stringify(reply) };
      },
      () => {},
    ),
  );
  const facts = await readServiceRuns(gh, ctx, previous);
  expect(paths[0]).toBe(
    `repos/${repo}/actions/runs?per_page=60&created=%3E%3D2026-11-02T09%3A00%3A00Z`,
  );
  return { facts, paths, view: serviceRuns(facts[repo]) };
}

test("parses one bounded page, groups by workflow ID and orders by start time", async () => {
  const newer = run(2, { name: "Validate", startedAt: "2026-11-16T04:00:00Z" });
  const older = run(1);
  const waiting = run(3, {
    workflowId: 32,
    name: "Validate",
    conclusion: null,
    path: null,
    startedAt: null,
    status: "queued",
  });
  const { view, paths } = await fixture({ total: 3, runs: [newer, waiting, older] });
  expect(paths).toHaveLength(1);
  expect(view).toMatchObject({
    kind: "read",
    cut: false,
    count: 0,
    failing: [],
    workflows: [
      { id: 31, name: "Validate", runs: [{ id: 1, result: "success" }, newer] },
      {
        id: 32,
        name: "Validate",
        runs: [{ id: 3, result: "queued", tone: "work", startedAt: undefined }],
      },
    ],
  });
});

test("shows a workflow by ID when the forge supplies no name or status", async () => {
  const { view } = await fixture({
    total: 1,
    runs: [run(1, { name: null, status: null, conclusion: null })],
  });
  expect(view).toMatchObject({
    kind: "read",
    count: 0,
    workflows: [{ id: 31, name: "Workflow #31", runs: [{ result: "unknown" }] }],
  });
});

test("reports an empty page as read with zero failures and no workflows", async () => {
  const { view } = await fixture({ total: 0, runs: [] });
  expect(view).toEqual({ kind: "read", cut: false, count: 0, failing: [], workflows: [] });
});

test.each([
  ["a forge failure", new Error("HTTP 403 Forbidden")],
  ["a malformed page", { total: 1, runs: [run(1, { workflowId: null })] }],
  ["an invalid date", { total: 1, runs: [run(1, { startedAt: "yesterday" })] }],
  ["a duplicate run", { total: 2, runs: [run(1), run(1)] }],
])("reports not read for %s, even when a previous page read", async (_label, output) => {
  const previous = (await fixture({ total: 1, runs: [run(1)] })).facts;
  const { facts, view } = await fixture(output, undefined, previous);
  expect(view).toEqual({ kind: "unread", count: null });
  expect(facts[repo]?.read.failure).toBeTruthy();
});

test("marks 60 runs as cut even if the forge says there are exactly 60", async () => {
  const runs = Array.from({ length: 60 }, (_, index) => run(index + 1));
  const { facts, view, paths } = await fixture({ total: 60, runs });
  expect(paths).toHaveLength(1);
  expect(facts[repo]?.read.completeness).toMatchObject({ kind: "cut", read: 60, total: 60 });
  expect(view).toMatchObject({ kind: "read", cut: true, count: 0 });
  expect(view.kind === "read" && view.workflows[0]?.runs).toHaveLength(60);
});

test("preserves a cut when the forge returns no runs", async () => {
  const { view } = await fixture({ total: 1, runs: [] });
  expect(view).toMatchObject({ kind: "read", cut: true, workflows: [] });
});

test("leaves an out-of-window item out of the strip", async () => {
  const outside = run(1, { createdAt: "2026-11-02T08:59:59Z" });
  const { view } = await fixture({ total: 2, runs: [outside, run(2)] });
  expect(view).toMatchObject({ kind: "read", cut: true, workflows: [{ runs: [{ id: 2 }] }] });
});

test("reads the latest failed attempt once per failing workflow, including pagination", async () => {
  const earlier = run(1, { conclusion: "failure" });
  const failed = run(2, { attempt: 2, conclusion: "failure", startedAt: "2026-11-16T04:00:00Z" });
  const active = run(3, {
    status: "in_progress",
    conclusion: null,
    startedAt: "2026-11-16T05:00:00Z",
  });
  const passed = run(4, { workflowId: 32 });
  const completed = await fixture({ total: 4, runs: [active, failed, passed, earlier] }, (path) =>
    path.endsWith("&page=1")
      ? { total: 2, jobs: [{ ...job, id: 90, conclusion: "success", steps: [] }] }
      : { total: 2, jobs: [job] },
  );
  expect(completed.paths.slice(1)).toEqual([
    `repos/${repo}/actions/runs/2/attempts/2/jobs?per_page=100&page=1`,
    `repos/${repo}/actions/runs/2/attempts/2/jobs?per_page=100&page=2`,
  ]);
  expect(completed.view).toMatchObject({
    count: 1,
    failing: [{ run: { id: 2, attempt: 2 }, job: "Build", step: "Run Maven" }],
  });
});

test("a retry of the same run retains the observed failure until it passes", async () => {
  const failed = run(1, { conclusion: "failure" });
  const retry = run(1, { attempt: 2, startedAt: "2026-11-16T06:00:00Z" });
  const first = await fixture({ total: 1, runs: [failed] });
  const running = await fixture(
    { total: 1, runs: [{ ...retry, status: "in_progress", conclusion: null }] },
    undefined,
    first.facts,
  );
  const cancelled = await fixture(
    { total: 1, runs: [{ ...retry, conclusion: "cancelled" }] },
    undefined,
    running.facts,
  );
  for (const result of [running, cancelled]) {
    expect(result.view).toMatchObject({
      count: 1,
      failing: [{ run: { id: 1, attempt: 1 }, step: "Run Maven" }],
      workflows: [{ runs: [{ id: 1, attempt: 2 }] }],
    });
  }
  const passed = await fixture(
    { total: 1, runs: [{ ...retry, attempt: 3 }] },
    undefined,
    cancelled.facts,
  );
  expect(passed.view).toMatchObject({ count: 0, failing: [] });
  expect(passed.paths).toHaveLength(1);
});

test("keeps the last observed failure by workflow across later runs and an unread sweep", async () => {
  const failed = run(1, { conclusion: "failure" });
  const later = { startedAt: "2026-11-16T06:00:00Z" };
  const path = ".github/workflows/validate.yml";
  let { facts } = await fixture({ total: 1, runs: [failed] });
  const pages = [
    [run(2, { ...later, conclusion: "cancelled", path })],
    [run(3, { ...later, status: "in_progress", conclusion: null })],
    [run(4, { ...later, workflowId: 32, conclusion: "cancelled" })],
    [run(5, { startedAt: "2026-11-16T03:00:00Z" })],
  ];
  for (const runs of pages) {
    const next = await fixture({ total: runs.length, runs }, undefined, facts);
    expect(next.view).toMatchObject({
      count: 1,
      failing: [{ run: { id: failed.id, path }, step: "Run Maven" }],
    });
    expect(next.paths.slice(1)).toEqual(
      runs[0]?.conclusion === "success" ? [] : [workflowRunsPath],
    );
    facts = next.facts;
  }
  const unread = await fixture(new Error("HTTP 403 Forbidden"), undefined, facts);
  expect(unread.view).toEqual({ kind: "unread", count: null });
  expect(unread.paths).toHaveLength(1);
  const recovered = await fixture({ total: 0, runs: [] }, undefined, unread.facts);
  expect(recovered.view).toMatchObject({ count: 1, failing: [{ run: { id: failed.id } }] });
  const passed = await fixture({ total: 1, runs: [run(6, later)] }, undefined, recovered.facts);
  expect(passed.view).toMatchObject({ count: 0, failing: [] });
  const afterPass = await fixture({ total: 0, runs: [] }, undefined, passed.facts);
  expect(afterPass.view).toMatchObject({ count: 0, failing: [] });
});

test("clears a carried failure after a later pass off the page", async () => {
  const { paths, view } = await fixture(recentPage, undefined, previousSweep, {
    total: 1,
    runs: [run(3)],
  });
  expect(view).toMatchObject({ cut: false, count: 0, failing: [] });
  expect(paths.slice(1)).toEqual([workflowRunsPath]);
});

test("clears a carried failure when its workflow returns 404", async () => {
  const { paths, view } = await fixture(
    recentPage,
    undefined,
    previousSweep,
    new Error("gh: Not Found (HTTP 404)"),
  );
  expect(view).toMatchObject({ cut: false, count: 0, failing: [] });
  expect(paths.slice(1)).toEqual([workflowRunsPath]);
});

test("replaces a carried failure with a newer failure off the page and reads its job", async () => {
  const { paths, view } = await fixture(recentPage, undefined, previousSweep, {
    total: 1,
    runs: [run(3, { conclusion: "failure", attempt: 2 })],
  });
  expect(view).toMatchObject({
    count: 1,
    failing: [{ run: { id: 3, attempt: 2 }, job: "Build", step: "Run Maven" }],
    workflows: [{ runs: [{ id: 2 }] }],
  });
  expect(paths.slice(1)).toEqual([
    workflowRunsPath,
    `repos/${repo}/actions/runs/3/attempts/2/jobs?per_page=100&page=1`,
  ]);
});

test("keeps a carried failure when the only later run was cancelled", async () => {
  const { paths, view } = await fixture(recentPage, undefined, previousSweep, {
    total: 2,
    runs: [run(3, { conclusion: "cancelled" }), carriedFailure.run],
  });
  expect(view).toMatchObject({ cut: false, count: 1, failing: [carriedFailure] });
  expect(paths.slice(1)).toEqual([workflowRunsPath]);
});

test("keeps a carried failure and marks history incomplete when the workflow read fails", async () => {
  const { facts, paths, view } = await fixture(
    recentPage,
    undefined,
    previousSweep,
    new Error("gh: Forbidden (HTTP 403)"),
  );
  expect(facts[repo]?.workflowReads).toEqual([
    expect.objectContaining({
      object: workflowRunsPath,
      failure: expect.stringContaining("HTTP 403"),
    }),
  ]);
  expect(view).toMatchObject({ kind: "read", cut: true, count: 1, failing: [carriedFailure] });
  expect(paths.slice(1)).toEqual([workflowRunsPath]);
});

test("uses only the page when it already shows a newer failure for the workflow", async () => {
  const failed = run(3, { conclusion: "failure" });
  const { paths, view } = await fixture({ total: 1, runs: [failed] }, undefined, previousSweep);
  expect(view).toMatchObject({ count: 1, failing: [{ run: failed }] });
  expect(paths.slice(1)).toEqual([
    `repos/${repo}/actions/runs/3/attempts/1/jobs?per_page=100&page=1`,
  ]);
});

test("shows the failure without claiming the job or step when that read failed", async () => {
  const { view, facts } = await fixture(
    { total: 1, runs: [run(1, { conclusion: "failure" })] },
    () => new Error("HTTP 403 Forbidden"),
  );
  expect(view).toMatchObject({ count: 1, failing: [{ job: undefined, step: undefined }] });
  expect(facts[repo]?.jobs[0]?.failure).toContain("Forbidden");
});

test("makes no extra request with no carried failure, even for an unobserved older attempt", async () => {
  const { view, paths } = await fixture({
    total: 1,
    runs: [run(1, { attempt: 2, conclusion: "cancelled" })],
  });
  expect(view).toMatchObject({ count: 0, failing: [] });
  expect(paths).toHaveLength(1);
});
