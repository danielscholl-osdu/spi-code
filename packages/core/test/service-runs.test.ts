// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { expect, test } from "vitest";
import { serviceRuns } from "../src/brief/service-runs.js";
import { type ServiceRunsFact, serviceRun } from "../src/service-runs.js";
import { sweep1116Facts, sweep1116Model } from "./sweep-1116.js";

const schema = ViewSnapshotSchema.shape.services.unwrap().element.shape.runHistory.unwrap();
const repo = "Azure/osdu-spi-search";
const observedAt = "2026-11-17T01:00:00Z";
const later = "2026-11-17T00:55:00Z";

function fact(history: NonNullable<ServiceRunsFact["history"]>): ServiceRunsFact {
  return {
    history,
    read: { source: "runs", object: repo, observedAt, completeness: { kind: "complete" } },
    jobs: [],
  };
}

test("keeps Main's proving run and Blocked run evidence together across bounded history cases", () => {
  const facts = sweep1116Facts();
  const forkRuns = facts.runs.data?.[repo];
  const failed = forkRuns?.main[0];
  const job =
    failed && forkRuns?.mainRunJobs?.[failed.id]?.find(({ name }) => /Java Build/i.test(name));
  if (!failed || !job) throw new Error("Expected search's proving run and Java Build job");
  failed.conclusion = "failure";
  job.conclusion = "failure";
  job.failedStep = "Build with Maven";
  failed.updatedAt = new Date(Date.parse(failed.createdAt) + 40 * 60_000).toISOString();
  const model = sweep1116Model(facts);
  const mainRed = model.lines.find(({ fork }) => fork.repo === repo)?.mainRed;
  const proof = mainRed?.run;
  if (!mainRed?.job || !proof) throw new Error("Main must be red with a failed job");
  const blocked = model.queue.items.find(({ id }) => id === "main:search");
  const runUrl = blocked?.cause.find(({ label }) => label === "run")?.url;
  expect(blocked?.url).toBe(job.url);
  expect(runUrl).toBe(proof.url);
  expect(blocked?.since).toBe(failed.updatedAt);
  const named = { job: mainRed.job.name, step: mainRed.job.failedStep };
  const fail = serviceRun.parse({ ...proof, workflowId: 31 });
  const active = {
    ...fail,
    id: fail.id + 1,
    path: `${proof.path}@refs/heads/pull-request`,
    createdAt: later,
    url: `${fail.url}1`,
  };
  const pass = { ...active, conclusion: "success" };

  for (const { runs, failures, displayed, cause } of [
    { runs: [pass], failures: [], displayed: fail, cause: named },
    { runs: [fail], failures: [{ run: fail }], displayed: fail, cause: named },
    { runs: [active], failures: [{ run: active }], displayed: active, cause: {} },
    { runs: [], failures: [], displayed: fail, cause: named },
  ]) {
    const history = schema.parse(serviceRuns(fact({ cut: true, runs, failures }), mainRed));
    expect(history).toMatchObject({
      kind: "read",
      count: 1,
      failing: [
        {
          run: { id: displayed.id, attempt: displayed.attempt, name: displayed.name },
          main: { id: proof.id, attempt: proof.attempt, url: runUrl, failedAt: blocked?.since },
        },
      ],
    });
    if (history.kind === "read") {
      expect({ job: history.failing[0]?.job, step: history.failing[0]?.step }).toEqual({
        job: undefined,
        step: undefined,
        ...cause,
      });
    }
    if (history.kind !== "read") throw new Error("Runs must be read");
    expect(history.failing).toHaveLength(1);
    expect(history.failing[0]?.run.workflowId).toBe(failures.length ? 31 : undefined);
  }

  const onMain = { ...fail, branch: "main", updatedAt: failed.updatedAt };
  const passedOnPr = { ...pass, branch: "pull-request", startedAt: later };
  const indexer = schema.parse(
    serviceRuns(fact({ cut: true, runs: [onMain, passedOnPr], failures: [] }), mainRed),
  );
  if (indexer.kind !== "read") throw new Error("Runs must be read");
  expect(indexer.workflows[0]?.label).toEqual({
    result: "failure",
    tone: "error",
    at: blocked?.since,
    branch: "main",
  });
  expect(indexer.failing).toMatchObject([{ ...named, main: { failedAt: blocked?.since } }]);

  const page = fact({ cut: true, runs: [pass], failures: [] });
  expect(serviceRuns(page)).toMatchObject({ count: 0, failing: [] });
  expect(serviceRuns({ ...page, read: { ...page.read, failure: "not read" } }, mainRed)).toEqual({
    kind: "unread",
    count: null,
  });
});

test("puts failing workflows first and folds only known automation", () => {
  const run = (id: number, name: string, path?: string) => ({
    id,
    workflowId: id,
    name,
    path,
    attempt: 1,
    status: "completed",
    conclusion: "success",
    createdAt: later,
    url: `https://github.com/${repo}/actions/runs/${id}`,
  });
  const failing = {
    ...run(1, "Validation", ".github/workflows/validate.yml"),
    conclusion: "failure",
  };
  const own = run(2, "Build", ".github/workflows/build.yml");
  const dynamic = run(3, "Dependabot Updates", "dynamic/dependabot/dependabot-updates");
  const unknown = run(4, "Another workflow");
  const page = fact({
    cut: false,
    runs: [dynamic, own, failing, unknown],
    failures: [{ run: failing }],
  });
  const history = schema.parse(serviceRuns(page));
  if (history.kind !== "read") throw new Error("Runs must be read");
  expect(history.workflows.map(({ id, automation }) => [id, automation])).toEqual([
    [1, undefined],
    [4, undefined],
    [2, undefined],
    [3, true],
  ]);
});

test("Q3 raises and clears Sync failed from the dedicated sync read", () => {
  const facts = sweep1116Facts();
  const forkRuns = facts.runs.data?.[repo];
  const github = facts.github.data?.repos[repo];
  const failed = forkRuns?.sync.find(({ conclusion }) => conclusion === "failure");
  if (!failed || !github || !forkRuns)
    throw new Error("Expected search's failed sync and open sync PR");
  github.issues = github.issues.filter(({ labels }) => !labels.includes("sync-failed"));
  forkRuns.sync = [failed];
  const q3 = () => sweep1116Model(facts).queue.items.find(({ id }) => id === "sync-run:search");

  const page = fact({ cut: true, runs: [], failures: [] });
  facts.serviceRuns = { [repo]: page };
  expect(q3()).toMatchObject({ text: "Sync failed", url: failed.url });
  facts.serviceRuns[repo] = { ...page, read: { ...page.read, failure: "unread" } };
  expect(q3()).toMatchObject({ text: "Sync failed", url: failed.url });

  const run = serviceRun.parse({ ...failed, workflowId: 32 });
  facts.serviceRuns[repo] = fact({ cut: true, runs: [], failures: [{ run }] });
  expect(q3()).toMatchObject({ text: "Sync failed", url: failed.url });
  forkRuns.sync = [
    { ...failed, id: failed.id + 1, conclusion: "success", createdAt: later },
    failed,
  ];
  expect(q3()).toBeUndefined();
});

test("parses a completed run with an empty conclusion as neutral", () => {
  const run = {
    id: 1,
    workflowId: 1,
    name: "Validation",
    attempt: 1,
    status: "completed",
    conclusion: "",
    createdAt: later,
    url: `https://github.com/${repo}/actions/runs/1`,
  };
  const history = schema.parse(serviceRuns(fact({ cut: false, runs: [run], failures: [] })));
  expect(history).toMatchObject({
    workflows: [{ runs: [{ result: "completed", tone: "neutral" }] }],
  });
});
