// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  DECLARATION_PATH, HISTORY_DAYS, LIFECYCLE_WORKFLOWS, type LifecycleKind, STACK_REPO,
} from "../config.js";
import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { JobDetail, LifecycleRun, RunFact } from "../facts.js";
import type { Gh } from "../forge.js";
import { type Annotation, reasonFromAnnotations, reasonFromLog } from "../model/reason.js";
import { ENVIRONMENT_TITLE } from "../rollout.js";
import { clip, errorText, pool } from "../util.js";
import { parseDeclaration } from "./github-parse.js";
import { type RawRun, toRun } from "./runs.js";

export interface LifecycleRead<T> {
  data: T;
  reads: ReadRecord[];
}
export type DetailCache = Record<string, LifecycleRead<JobDetail>>;
type LifecycleData = Record<LifecycleKind, LifecycleRun[]>;
export interface LifecycleState {
  runJobs: Record<string, LifecycleRead<JobDetail[]> & {
    run?: Pick<RunFact, "status" | "updatedAt">;
  }>;
  files: Record<string, LifecycleRead<string>>;
  lifecycle?: Partial<Record<LifecycleKind, LifecycleRead<LifecycleRun[]>>>;
}

const time = z.iso.datetime({ offset: true });
const stepSchema = z.strictObject({
  number: z.int().nonnegative(), name: z.string(), status: z.string(),
  conclusion: z.string().optional(), startedAt: time.optional(), completedAt: time.optional(),
});
export const jobSchema = z.strictObject({
  id: z.int().nonnegative(), name: z.string(), status: z.string(), conclusion: z.string().optional(),
  startedAt: time.optional(), completedAt: time.optional(), url: z.string(),
  steps: z.array(stepSchema), failedStep: z.string().optional(), reason: z.string().optional(),
  environment: z.array(z.string()).optional(), attempt: z.int().positive().optional(),
});
const recordSchema = z.strictObject({
  source: z.string(), object: z.string(), observedAt: time,
  completeness: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("complete") }),
    z.strictObject({
      kind: z.literal("cut"), reason: z.string(), read: z.int().nonnegative(), total: z.int().nonnegative(),
    }),
  ]),
  failure: z.string().optional(), retainedFrom: time.optional(), inferred: z.boolean().optional(),
});
const runSchema = z.strictObject({
  id: z.int().nonnegative(), name: z.string(), path: z.string(), event: z.string(),
  status: z.string(), conclusion: z.string().optional(), createdAt: time, updatedAt: time,
  branch: z.string().optional(), sha: z.string(), title: z.string(), url: z.string(),
  attempt: z.int().positive(), kind: z.enum(["refresh", "upgrade", "smoke", "sweeper"]),
  jobs: z.array(jobSchema).optional(), target: z.string().optional(),
});
const saved = <T extends z.ZodType>(schema: T) =>
  z.strictObject({ data: schema, reads: z.array(recordSchema).min(1) });
export const lifecycleStateSchema = z.strictObject({
  runJobs: z.record(z.string(), saved(z.array(jobSchema)).extend({
    run: z.strictObject({ status: z.string(), updatedAt: time }).optional(),
  })),
  files: z.record(z.string(), saved(z.string())),
  lifecycle: z.strictObject({
    refresh: saved(z.array(runSchema)).optional(), upgrade: saved(z.array(runSchema)).optional(),
    smoke: saved(z.array(runSchema)).optional(), sweeper: saved(z.array(runSchema)).optional(),
  }).optional(),
});

function record(ctx: CoreContext, source: string, object: string): ReadRecord {
  return { source, object, observedAt: ctx.clock.now().toISOString(), completeness: { kind: "complete" } };
}
const JOB_LOG_CUT = "Job log character limit";
const good = (reads: readonly ReadRecord[]) =>
  reads.every((r) => r.failure === undefined &&
    (r.completeness.kind === "complete" || r.completeness.reason === JOB_LOG_CUT));

export function loadDetailCache(state: unknown): { cache: DetailCache; dropped: string[] } {
  const cache: DetailCache = {};
  const parsed = z.record(z.string(), z.unknown()).safeParse(state);
  if (!parsed.success) return { cache, dropped: ["(whole cache)"] };
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    const entry = saved(jobSchema).safeParse(value);
    if (entry.success && entry.data.data.status === "completed" &&
        key.endsWith(`#${entry.data.data.id}`) && good(entry.data.reads)) cache[key] = entry.data;
    else dropped.push(key);
  }
  return { cache, dropped };
}

function details(state: unknown, ctx: CoreContext) {
  const { cache, dropped } = loadDetailCache(state);
  const reads: ReadRecord[] = dropped.length ? [{
    ...record(ctx, "persist", "detail-cache"), failure: `Dropped invalid detail cache entries: ${dropped.join(", ")}`,
  }] : [];
  return { cache, reads };
}

async function observe<T>(
  ctx: CoreContext, reads: ReadRecord[], path: string, call: () => Promise<T>,
): Promise<T | undefined> {
  const read = record(ctx, "github", path);
  try {
    const data = await call();
    reads.push(read);
    return data;
  } catch (error) {
    reads.push({ ...read, failure: errorText(error) });
    return undefined;
  }
}

function retain<T>(previous: LifecycleRead<T> | undefined, reads: ReadRecord[]): T | undefined {
  if (!previous) return undefined;
  for (let i = 0; i < reads.length; i++) {
    const read = reads[i];
    if (!read?.failure) continue;
    const prior = previous.reads.find((r) => r.source === read.source &&
      r.object.split("?")[0] === read.object.split("?")[0]);
    const retainedFrom = prior?.retainedFrom ?? (prior?.failure === undefined ? prior?.observedAt : undefined);
    if (retainedFrom) reads[i] = { ...read, retainedFrom };
  }
  reads.push(...previous.reads.filter((r) =>
    !reads.some((next) => next.source === r.source && next.object === r.object)));
  return previous.data;
}

const JOB_JQ = "{id, name, status, conclusion, started_at, completed_at, html_url, run_attempt, steps: [(.steps // [])[] | {number, name, status, conclusion, started_at, completed_at}]}";
interface RawJob {
  id: number; name: string; status: string; conclusion: string | null;
  started_at: string | null; completed_at: string | null; html_url: string; run_attempt?: number;
  steps: { number: number; name: string; status: string; conclusion: string | null;
    started_at?: string | null; completed_at?: string | null }[];
}
function toJob(j: RawJob): JobDetail {
  const steps = j.steps.map((s) => ({
    number: s.number, name: s.name, status: s.status, conclusion: s.conclusion ?? undefined,
    startedAt: s.started_at ?? undefined, completedAt: s.completed_at ?? undefined,
  }));
  return {
    id: j.id, name: j.name, status: j.status, conclusion: j.conclusion ?? undefined,
    startedAt: j.started_at ?? undefined, completedAt: j.completed_at ?? undefined,
    url: j.html_url, steps, failedStep: steps.find((s) => s.conclusion === "failure")?.name,
    ...(j.run_attempt ? { attempt: j.run_attempt } : {}),
  };
}
const FAILED: readonly string[] = Object.freeze(["failure", "timed_out", "startup_failure"]);
export const JOB_LOG_LIMIT = 64_000;

async function explain(gh: Gh, repo: string, job: JobDetail, readLog: boolean, ctx: CoreContext) {
  const reads: ReadRecord[] = [];
  if (!FAILED.includes(job.conclusion ?? "")) return reads;
  const path = `repos/${repo}/check-runs/${job.id}/annotations?per_page=100`;
  const annotations = await observe(ctx, reads, path, () =>
    gh.pages<Annotation>(path, ".[] | {level: .annotation_level, title, message}"));
  if (annotations) {
    job.reason = reasonFromAnnotations(annotations);
    job.environment = annotations.filter((a) => a.level === "failure" && a.title === ENVIRONMENT_TITLE)
      .map((a) => clip(a.message.trim(), 500)).slice(0, 5);
  }
  if (job.reason && !readLog) return reads;
  const logPath = `repos/${repo}/actions/jobs/${job.id}/logs`;
  const log = await observe(ctx, reads, logPath, () => gh.text(logPath));
  if (log !== undefined) {
    const text = log.slice(-JOB_LOG_LIMIT);
    if (text.length < log.length) {
      const read = reads.pop();
      if (read) reads.push({ ...read, completeness: {
        kind: "cut", read: text.length, total: log.length, reason: JOB_LOG_CUT,
      } });
    }
    job.reason = reasonFromLog(text) ?? job.reason;
  }
  return reads;
}

function put(cache: DetailCache, repo: string, data: JobDetail, reads: ReadRecord[]) {
  if (data.status === "completed" && good(reads)) cache[`${repo}#${data.id}`] = { data, reads };
}
export async function readJob(
  gh: Gh, state: unknown, repo: string, id: number, name: string, ctx: CoreContext,
) {
  const { cache, reads } = details(state, ctx);
  const known = cache[`${repo}#${id}`];
  if (known) return { data: known.data, cache, reads: [...reads, ...known.reads] };
  const path = `repos/${repo}/actions/jobs/${id}`;
  const raw = await observe(ctx, reads, path, () => gh.rest<RawJob>(path, JOB_JQ));
  if (!raw) return { data: undefined, cache, reads };
  const data = toJob(raw);
  const explanation = await explain(gh, repo, data, /java build/i.test(name), ctx);
  put(cache, repo, data, [...reads.filter((r) => r.source !== "persist"), ...explanation]);
  return { data, cache, reads: [...reads, ...explanation] };
}

function timed(job: JobDetail): boolean {
  return job.steps.length === 0 || job.steps.some((s) => s.startedAt !== undefined);
}
export function jobsKey(run: Pick<RunFact, "id" | "attempt">): string {
  return `${run.id}#${run.attempt}`;
}

export async function readRunJobs(
  gh: Gh, state: unknown, repo: string, run: RunFact, ctx: CoreContext,
  previous?: LifecycleRead<JobDetail[]>,
) {
  const { cache, reads } = details(state, ctx);
  const jobs = new Map<number, RawJob>();
  let total = 0;
  for (let page = 1; ; page++) {
    const path = `repos/${repo}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100&page=${page}`;
    const response = await observe(ctx, reads, path, () =>
      gh.rest<{ total: number; jobs: RawJob[] }>(path, `{total: .total_count, jobs: [.jobs[] | ${JOB_JQ}]}`));
    if (!response) return { data: retain(previous, reads), cache, reads };
    total = response.total;
    const before = jobs.size;
    for (const job of response.jobs) jobs.set(job.id, job);
    if (jobs.size >= total) break;
    if (page >= 100 || jobs.size === before) {
      const read = reads.pop();
      if (read) reads.push({ ...read, completeness: {
        kind: "cut", read: jobs.size, total, reason: "Run jobs page limit or short read",
      } });
      break;
    }
  }
  const listing = [...reads];
  const results = await pool([...jobs.values()], 3, async (raw) => {
    const job = toJob(raw);
    const known = cache[`${repo}#${job.id}`];
    if (known && known.data.status === job.status && known.data.conclusion === job.conclusion &&
        known.data.attempt === job.attempt && timed(known.data)) {
      const kept = { ...known.data, ...job, reason: known.data.reason, environment: known.data.environment };
      const annotations = `repos/${repo}/check-runs/${job.id}/annotations`;
      const log = `repos/${repo}/actions/jobs/${job.id}/logs`;
      const explanation = known.reads.filter((r) => r.source === "github" &&
        (r.object.split("?")[0] === annotations || r.object === log));
      put(cache, repo, kept, [...listing.filter((r) => r.source !== "persist"), ...explanation]);
      return { data: kept, reads: explanation };
    }
    const explanation = await explain(gh, repo, job, false, ctx);
    put(cache, repo, job, [...listing.filter((r) => r.source !== "persist"), ...explanation]);
    return { data: job, reads: explanation };
  });
  reads.push(...results.flatMap((r) => r.reads));
  const data = results.map((r) => r.data);
  return { data, cache, reads };
}

function declarationPath(sha: string): string {
  return `repos/${STACK_REPO}/contents/${DECLARATION_PATH}?ref=${encodeURIComponent(sha)}`;
}

async function targetOf(
  gh: Gh, run: RunFact, files: LifecycleState["files"], reads: ReadRecord[], ctx: CoreContext,
): Promise<string | undefined> {
  const title = /stackVersion to (v\d+\.\d+\.\d+)/.exec(run.title)?.[1];
  if (title) return title;
  const known = files[run.sha];
  if (known) { reads.push(...known.reads); return known.data; }
  const path = declarationPath(run.sha);
  const evidence: ReadRecord[] = [];
  const file = await observe(ctx, evidence, path, () => gh.rest<{ text: string }>(path, "{text: (.content | @base64d)}"));
  const version = file && parseDeclaration(file.text)?.stackVersion;
  if (file && !version) {
    const read = evidence.pop();
    if (read) evidence.push({ ...read, failure: "Declaration has no valid stackVersion" });
  }
  if (version) files[run.sha] = { data: version, reads: evidence };
  reads.push(...evidence);
  return version;
}

export async function readLifecycle(gh: Gh, detailState: unknown, previous: unknown, ctx: CoreContext) {
  const loaded = lifecycleStateSchema.safeParse(previous ?? { runJobs: {}, files: {} });
  const state: LifecycleState = loaded.success ? loaded.data : { runJobs: {}, files: {} };
  const detail = details(detailState, ctx);
  const reads = detail.reads;
  if (!loaded.success) reads.push({
    ...record(ctx, "persist", "lifecycle-cache"), failure: "Dropped invalid lifecycle cache",
  });
  const data: LifecycleData = { refresh: [], upgrade: [], smoke: [], sweeper: [] };
  const since = new Date(ctx.clock.now().getTime() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const kinds = Object.keys(LIFECYCLE_WORKFLOWS) as LifecycleKind[];
  const perKind = await pool(kinds, 2, async (kind) => {
    const byId = new Map<number, RunFact>();
    let failed = false;
    const evidence: ReadRecord[] = [];
    for (let page = 1; ; page++) {
      const path = `repos/${STACK_REPO}/actions/workflows/${LIFECYCLE_WORKFLOWS[kind]}/runs?per_page=60&created=${encodeURIComponent(`>=${since}`)}&page=${page}`;
      const result = await observe(ctx, evidence, path, () => gh.rest<{ total: number; runs: RawRun[] }>(
        path, "{total: .total_count, runs: [.workflow_runs[] | {id, name, path, event, status, conclusion, created_at, updated_at, head_branch, head_sha, display_title, html_url, run_attempt}]}",
      ));
      if (!result) { failed = true; break; }
      const before = byId.size;
      for (const raw of result.runs) byId.set(raw.id, toRun(raw));
      if (byId.size >= result.total) break;
      if (page >= 100 || byId.size === before) {
        const read = evidence.pop();
        if (read) evidence.push({ ...read, completeness: {
          kind: "cut", read: byId.size, total: result.total, reason: "Lifecycle page limit or short read",
        } });
        break;
      }
    }
    if (failed) {
      data[kind] = retain(state.lifecycle?.[kind], evidence) ?? [];
    } else {
      const entries = await pool([...byId.values()], 3, async (run) => {
        const runReads: ReadRecord[] = [];
        const entry: LifecycleRun = { ...run, kind };
        if (kind !== "refresh" && kind !== "upgrade") return { entry, reads: runReads };
        const known = state.runJobs[jobsKey(run)];
        const settled = run.status === "completed" && known &&
          known.run?.status === "completed" && known.run.updatedAt === run.updatedAt &&
          good(known.reads) && known.data.every((j) => j.status === "completed" && timed(j));
        if (settled) { entry.jobs = known.data; runReads.push(...known.reads); }
        else {
          const jobs = await readRunJobs(gh, detail.cache, STACK_REPO, run, ctx, known);
          Object.assign(detail.cache, jobs.cache);
          runReads.push(...jobs.reads);
          entry.jobs = jobs.data;
          if (jobs.data) state.runJobs[jobsKey(run)] = {
            data: jobs.data, reads: jobs.reads,
            run: good(jobs.reads) ? { status: run.status, updatedAt: run.updatedAt } : known?.run,
          };
        }
        entry.target = await targetOf(gh, run, state.files, runReads, ctx);
        return { entry, reads: runReads };
      });
      data[kind] = entries.map((r) => r.entry);
      evidence.push(...entries.flatMap((r) => r.reads));
    }
    state.lifecycle ??= {};
    state.lifecycle[kind] = { data: data[kind], reads: evidence };
    return evidence;
  });
  reads.push(...perKind.flat());
  return { data, reads, state, cache: detail.cache };
}

export async function pollRun(
  gh: Gh, state: unknown, previous: LifecycleRead<LifecycleRun>, ctx: CoreContext,
) {
  const { cache, reads } = details(state, ctx);
  const path = `repos/${STACK_REPO}/actions/runs/${previous.data.id}`;
  const raw = await observe(ctx, reads, path, () => gh.rest<RawRun>(
    path, "{id, name, path, event, status, conclusion, created_at, updated_at, head_branch, head_sha, display_title, html_url, run_attempt}",
  ));
  if (!raw) return { data: retain(previous, reads) ?? previous.data, cache, reads };
  const fresh = toRun(raw);
  const sameAttempt = fresh.attempt === previous.data.attempt;
  const jobs = await readRunJobs(gh, cache, STACK_REPO, fresh, ctx,
    sameAttempt && previous.data.jobs ? {
      data: previous.data.jobs, reads: previous.reads.filter((r) =>
        r.object.includes("/jobs?") || r.object.includes("/check-runs/") || r.object.endsWith("/logs")),
    } : undefined);
  const data = { ...previous.data, ...fresh, jobs: jobs.data };
  const targetReads = previous.data.target === undefined ? [] : previous.reads.filter((r) =>
    r.source === "github" && r.object === declarationPath(previous.data.sha));
  return { data, cache: jobs.cache, reads: [...reads, ...jobs.reads, ...targetReads] };
}
