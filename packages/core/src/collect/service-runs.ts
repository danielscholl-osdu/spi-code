// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import { ForgeError, type Gh } from "../forge.js";
import { workflowFailure, workflowRunFailed } from "../model/workflow-failure.js";
import { serviceRun, type ServiceRun, type ServiceRunsFact, workflowGroups } from "../service-runs.js";
import { errorText, pool } from "../util.js";
import { jobsKey, type LifecycleState, readRunJobs, settledJobReads } from "./lifecycle.js";

const LIMIT = 60;
const WORKFLOW_LIMIT = 10;
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const PAGE_JQ = '{total: .total_count, runs: [.workflow_runs[] | {id, workflowId: .workflow_id, name, path, attempt: .run_attempt, status, conclusion, createdAt: .created_at, startedAt: .run_started_at, url: .html_url}]}';
const pageSchema = z.object({
  total: z.int().nonnegative(),
  runs: z.array(serviceRun.extend({
    name: z.string().trim().nullish(),
    path: z.string().trim().nullish().transform((value) => value || undefined),
    status: serviceRun.shape.status.nullish().transform((value) => value ?? "unknown"),
    startedAt: serviceRun.shape.startedAt.unwrap().nullish().transform((value) => value ?? undefined),
    conclusion: z.string().nullish().transform((value) => value ?? undefined),
  }).transform(({ name, ...run }) => ({ ...run, name: name || `Workflow #${run.workflowId}` }))).max(LIMIT),
}).refine(({ total, runs }) => total >= runs.length && new Set(runs.map(({ id }) => id)).size === runs.length,
  "Run counts or IDs are inconsistent");

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
    const priorFailures = prior?.failures ?? [];
    const carriedByRun = new Map(priorFailures.map((entry) => [entry.run, entry]));
    const workflowReads: ReadRecord[] = [];
    const failures: NonNullable<ServiceRunsFact["history"]>["failures"] = [];
    for (const group of workflowGroups([...runs, ...priorFailures.map(({ run }) => run)])) {
      const workflowId = group.find((run) => carriedByRun.has(run))?.workflowId;
      const pageSettles = group.some((run) => !carriedByRun.has(run) &&
        (workflowRunFailed(run) || (run.status === "completed" && run.conclusion === "success")));
      if (workflowId !== undefined && !pageSettles) {
        const object = `repos/${repo}/actions/workflows/${workflowId}/runs?per_page=${WORKFLOW_LIMIT}`;
        const workflowRead = { ...read, object };
        try {
          const latest = pageSchema.parse(await gh.rest<unknown>(object, PAGE_JQ));
          if (latest.runs.length > WORKFLOW_LIMIT || latest.runs.some((run) => run.workflowId !== workflowId)) {
            throw new Error(`Unexpected run history for workflow ${workflowId}`);
          }
          group.push(...latest.runs);
          workflowReads.push(workflowRead);
        } catch (error) {
          const failure = errorText(error);
          if (error instanceof ForgeError && /\bHTTP 404\b/.test(failure)) {
            workflowReads.push(workflowRead);
            continue;
          }
          workflowReads.push({ ...workflowRead, failure });
        }
      }
      const failed = workflowFailure(group);
      if (!failed) continue;
      const carried = carriedByRun.get(failed);
      const path = failed.path ?? group.find((run) => run.path)?.path;
      const run = path && !failed.path ? { ...failed, path } : failed;
      failures.push(carried ? { ...carried, run } : await readFailure(gh, ctx, repo, run, jobCache, jobs));
    }
    const historyCut = cut || workflowReads.some(({ failure }) => failure !== undefined);
    return [repo, {
      history: { cut: historyCut, runs, failures },
      read: { ...read, completeness },
      jobs,
      ...(workflowReads.length ? { workflowReads } : {}),
    }];
  });
  return Object.fromEntries(results);
}
