// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { Gh } from "../forge.js";
import { workflowFailure, workflowRunFailed } from "../model/workflow-failure.js";
import { serviceRun, type ServiceRun, type ServiceRunsFact, workflowGroups } from "../service-runs.js";
import { errorText, pool } from "../util.js";
import { jobsKey, type LifecycleState, readRunJobs, settledJobReads } from "./lifecycle.js";

const LIMIT = 60;
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const PAGE_JQ = '{total: .total_count, runs: [.workflow_runs[] | {id, workflowId: .workflow_id, name, attempt: .run_attempt, status, conclusion, createdAt: .created_at, startedAt: .run_started_at, url: .html_url}]}';
const pageSchema = z.object({
  total: z.int().nonnegative(),
  runs: z.array(serviceRun.extend({
    name: z.string().trim().nullish(),
    status: serviceRun.shape.status.nullish().transform((value) => value ?? "unknown"),
    startedAt: serviceRun.shape.startedAt.unwrap().nullish().transform((value) => value ?? undefined),
    conclusion: z.string().nullish().transform((value) => value ?? undefined),
  }).transform(({ name, ...run }) => ({ ...run, name: name || `Workflow #${run.workflowId}` }))).max(LIMIT),
}).refine(({ total, runs }) => total >= runs.length && new Set(runs.map(({ id }) => id)).size === runs.length,
  "Run counts or IDs are inconsistent");

function activeFailure(runs: ServiceRun[]) {
  return workflowFailure(runs.map((run) => ({
    ...run,
    createdAt: run.startedAt ?? run.createdAt,
    original: run,
  })))?.original;
}

async function readFailure(
  gh: Gh, ctx: CoreContext, repo: string, run: ServiceRun,
  cache: LifecycleState["runJobs"], reads: ReadRecord[],
) {
  const key = jobsKey(run);
  const known = cache[key];
  const listing = known?.reads.filter((record) => record.object.startsWith(
    `repos/${repo}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?`,
  ));
  let jobs = known && listing?.length && settledJobReads(listing) ? known.data : undefined;
  if (!jobs) {
    try {
      const result = await readRunJobs(gh, {}, repo, run, ctx, undefined, true);
      reads.push(...result.reads);
      if (settledJobReads(result.reads)) jobs = result.data;
    } catch (error) {
      reads.push({
        source: "github", object: `repos/${repo}/actions/runs/${run.id}/attempts/${run.attempt}/jobs`,
        observedAt: ctx.clock.now().toISOString(), completeness: { kind: "complete" },
        failure: errorText(error),
      });
    }
  }
  const failed = jobs?.filter(workflowRunFailed).map((job) => ({
    name: job.name,
    step: job.failedStep ?? job.steps.find(workflowRunFailed)?.name,
  }));
  const job = failed?.find(({ step }) => step) ?? failed?.[0];
  return { run, job: job?.name.trim() || undefined, step: job?.step?.trim() || undefined };
}

export async function readServiceRuns(
  gh: Gh, ctx: CoreContext, previous: Record<string, ServiceRunsFact> = {},
  jobCache: LifecycleState["runJobs"] = {},
): Promise<Record<string, ServiceRunsFact>> {
  const now = ctx.clock.now();
  const cutoff = now.getTime() - WINDOW_MS;
  const since = new Date(Math.floor(cutoff / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const results = await pool(ctx.fleet.forks, 3, async ({ repo }): Promise<[string, ServiceRunsFact]> => {
    const object = `repos/${repo}/actions/runs?per_page=${LIMIT}&created=${encodeURIComponent(`>=${since}`)}`;
    const read: ReadRecord = { source: "runs", object, observedAt: now.toISOString(), completeness: { kind: "complete" } };
    const prior = previous[repo]?.history;
    const jobs: ReadRecord[] = [];
    let page: z.infer<typeof pageSchema>;
    try {
      page = pageSchema.parse(await gh.rest<unknown>(object, PAGE_JQ));
    } catch (error) {
      return [repo, { history: prior, read: { ...read, failure: errorText(error) }, jobs }];
    }
    const runs = page.runs.filter((run) => Date.parse(run.createdAt) >= cutoff);
    const cut = page.runs.length === LIMIT || page.total > runs.length;
    const completeness: ReadRecord["completeness"] = cut ? {
      kind: "cut", read: runs.length, total: page.total, reason: "Recent workflow runs history limited",
    } : { kind: "complete" };
    const priorFailures = new Map(prior?.failures.map(({ run }) => [run.id, run]));
    const failures: NonNullable<ServiceRunsFact["history"]>["failures"] = [];
    for (const group of workflowGroups(runs)) {
      const candidates = group.flatMap((run) => {
        // GitHub lists only the current attempt. Keep the observed failure while its retry is on the page.
        const failed = priorFailures.get(run.id);
        return failed && failed.workflowId === run.workflowId && failed.attempt < run.attempt
          ? [run, failed] : [run];
      });
      const failed = activeFailure(candidates);
      if (failed) failures.push(await readFailure(gh, ctx, repo, failed, jobCache, jobs));
    }
    return [repo, { history: { cut, runs, failures }, read: { ...read, completeness }, jobs }];
  });
  return Object.fromEntries(results);
}
