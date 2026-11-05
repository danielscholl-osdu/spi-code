// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { SYNC_TEMPLATE_WORKFLOW } from "../config.js";
import type { CoreContext } from "../context.js";
import type { ReadCompleteness, ReadRecord } from "../evidence/index.js";
import type { ForkRuns, OutsidePr, RunFact, WaitingRun } from "../facts.js";
import type { Gh } from "../forge.js";
import { errorText, pool } from "../util.js";

const RUN_JQ =
  "{total: .total_count, runs: [.workflow_runs[] | {id, name, path, event, status, conclusion, created_at, updated_at, head_branch, head_sha, display_title, html_url, run_attempt}]}";

export interface RawRun {
  id: number;
  name: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  head_branch: string | null;
  head_sha: string;
  display_title: string;
  html_url: string;
  run_attempt: number;
}

export function toRun(r: RawRun): RunFact {
  return {
    id: r.id, name: r.name, path: r.path, event: r.event, status: r.status,
    conclusion: r.conclusion ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
    branch: r.head_branch ?? undefined, sha: r.head_sha, title: r.display_title,
    url: r.html_url, attempt: r.run_attempt,
  };
}

interface Read<T> {
  data: T;
  reads: ReadRecord[];
}

function record(ctx: CoreContext, source: string, object: string): ReadRecord {
  return {
    source, object, observedAt: ctx.clock.now().toISOString(),
    completeness: { kind: "complete" },
  };
}

function cut(read: number, total: number, reason: string): ReadCompleteness {
  return read < total ? { kind: "cut", read, total, reason } : { kind: "complete" };
}

function combine(parts: readonly ReadCompleteness[]): ReadCompleteness {
  const cuts = parts.filter((p) => p.kind === "cut");
  return cuts.length === 0 ? { kind: "complete" } : {
    kind: "cut",
    read: cuts.reduce((n, p) => n + p.read, 0),
    total: cuts.reduce((n, p) => n + p.total, 0),
    reason: cuts.map((p) => p.reason).join("; "),
  };
}

// A recency window is complete when the API returned all it was asked for; a paged
// read (`window` undefined) is complete only when every run was read.
async function runs(gh: Gh, path: string, window?: number) {
  const byId = new Map<number, RunFact>();
  let total = 0;
  let wanted = 0;
  for (let page = 1; ; page++) {
    const result = await gh.rest<{ total: number; runs: RawRun[] }>(
      `${path}${page === 1 ? "" : `&page=${page}`}`,
      RUN_JQ,
    );
    total = result.total;
    for (const r of result.runs) byId.set(r.id, toRun(r));
    wanted = window === undefined ? total : Math.min(window, total);
    if (window !== undefined || byId.size >= total || result.runs.length === 0) break;
  }
  const data = [...byId.values()];
  return { data, completeness: cut(data.length, wanted, `${path}: run read cut`) };
}

export async function readTemplateRuns(
  gh: Gh, repo: string, ctx: CoreContext,
): Promise<Read<RunFact[]>> {
  const read = record(ctx, repo, "template-runs");
  try {
    const result = await runs(
      gh,
      `repos/${repo}/actions/workflows/${SYNC_TEMPLATE_WORKFLOW}/runs?per_page=5`,
      5,
    );
    return { data: result.data, reads: [{ ...read, completeness: result.completeness }] };
  } catch (error) {
    return { data: [], reads: [{ ...read, failure: errorText(error) }] };
  }
}

export async function readForkRuns(
  gh: Gh, ctx: CoreContext,
): Promise<Read<Record<string, ForkRuns>>> {
  const data: Record<string, ForkRuns> = {};
  const reads = await pool(ctx.fleet.forks, 3, async (f): Promise<ReadRecord> => {
    const read = record(ctx, f.repo, "fork-runs");
    try {
      const base = `repos/${f.repo}/actions`;
      const [sync, template, cascade, main] = await Promise.all([
        runs(gh, `${base}/workflows/sync.yml/runs?per_page=10`, 10),
        runs(gh, `${base}/workflows/${SYNC_TEMPLATE_WORKFLOW}/runs?per_page=5`, 5),
        runs(gh, `${base}/workflows/cascade.yml/runs?per_page=5`, 5),
        runs(gh, `${base}/workflows/validate.yml/runs?branch=main&event=push&per_page=5`, 5),
      ]);
      data[f.repo] = { sync: sync.data, template: template.data, cascade: cascade.data, main: main.data };
      return { ...read, completeness: combine([sync, template, cascade, main].map((r) => r.completeness)) };
    } catch (error) {
      return { ...read, failure: errorText(error) };
    }
  });
  return { data, reads };
}

export type PrFiles = Pick<OutsidePr, "files" | "changedFiles" | "additions" | "deletions">;
// Keyed `repo#number@sha`: a PR's files at one head never change.
export type PrFilesCache = Record<string, PrFiles>;
const prFilesSchema = z
  .strictObject({
    files: z.array(z.string()),
    changedFiles: z.int().nonnegative(),
    additions: z.int().nonnegative(),
    deletions: z.int().nonnegative(),
  })
  .refine((p) => p.files.length === p.changedFiles, "Incomplete PR files");

export function loadPrFilesCache(state: unknown): { cache: PrFilesCache; dropped: string[] } {
  const cache: PrFilesCache = {};
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return { cache, dropped: ["(whole cache)"] };
  }
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    const parsed = prFilesSchema.safeParse(value);
    if (parsed.success) cache[key] = parsed.data;
    else dropped.push(key);
  }
  return { cache, dropped };
}

interface RawOpenPr {
  number: number;
  title: string;
  url: string;
  author: string;
  association: string;
  draft: boolean;
  sha: string;
}

async function prFiles(gh: Gh, repo: string, n: number, sha: string) {
  const files = await gh.pages<{ path: string; additions: number; deletions: number }>(
    `repos/${repo}/pulls/${n}/files?per_page=100`,
    ".[] | {path: .filename, additions, deletions}",
  );
  const pr = await gh.rest<{ changed: number; additions: number; deletions: number; sha: string }>(
    `repos/${repo}/pulls/${n}`,
    "{changed: .changed_files, additions, deletions, sha: .head.sha}",
  );
  if (pr.sha !== sha) throw new Error(`${repo}#${n}: head moved ${sha.slice(0, 7)} → ${pr.sha.slice(0, 7)} during the read`);
  if (files.length > pr.changed) {
    throw new Error(`${repo}#${n}: read ${files.length} files but the PR reports ${pr.changed}`);
  }
  return {
    data: {
      files: files.map((f) => f.path),
      changedFiles: pr.changed,
      additions: pr.additions,
      deletions: pr.deletions,
    },
    completeness: cut(files.length, pr.changed, `${repo}#${n}: PR files cut`),
  };
}

// A run on a head the open PR has moved past has nothing left to approve.
export async function readApprovals(
  gh: Gh, ctx: CoreContext, state: unknown = {},
): Promise<Read<Record<string, WaitingRun[]>> & { cache: PrFilesCache }> {
  const { cache: loaded, dropped } = loadPrFilesCache(state);
  const cache: PrFilesCache = { ...loaded };
  const used = new Set<string>();
  const failedRepos = new Set<string>();
  const data: Record<string, WaitingRun[]> = {};
  const reads = await pool(ctx.fleet.repos, 4, async (repo): Promise<ReadRecord> => {
    const read = record(ctx, repo, "approvals");
    const parts: ReadCompleteness[] = [];
    const failures: string[] = [];
    try {
      const waiting = await runs(gh, `repos/${repo}/actions/runs?status=action_required&per_page=100`);
      parts.push(waiting.completeness);
      data[repo] = waiting.data;
      if (waiting.data.length > 0) {
        const open = await gh.pages<RawOpenPr>(
          `repos/${repo}/pulls?state=open&per_page=100`,
          ".[] | {number, title, url: .html_url, author: .user.login, association: .author_association, draft, sha: .head.sha}",
        );
        const bySha = new Map(open.map((p) => [p.sha, p]));
        const live = new Map<number, OutsidePr>();
        for (const p of open) {
          if (!waiting.data.some((r) => r.sha === p.sha)) continue;
          const key = `${repo}#${p.number}@${p.sha}`;
          try {
            let files = cache[key];
            if (!files) {
              const result = await prFiles(gh, repo, p.number, p.sha);
              parts.push(result.completeness);
              if (result.completeness.kind === "cut") continue;
              files = result.data;
              cache[key] = files;
            }
            used.add(key);
            const { sha, ...rest } = p;
            live.set(p.number, { ...rest, headSha: sha, ...files });
          } catch (error) {
            failures.push(errorText(error));
          }
        }
        data[repo] = waiting.data.map((r) => {
          const p = bySha.get(r.sha);
          if (!p) return { ...r, pr: null };
          const pr = live.get(p.number);
          return pr ? { ...r, pr } : r;
        });
      }
    } catch (error) {
      failures.push(errorText(error));
    }
    if (failures.length) failedRepos.add(repo);
    return {
      ...read, completeness: combine(parts),
      ...(failures.length ? { failure: failures.join("; ") } : {}),
    };
  });
  if (dropped.length) reads.push({
    ...record(ctx, "persist", "pr-files-cache"),
    failure: `Dropped invalid PR-files cache entries: ${dropped.join(", ")}`,
  });
  const kept: PrFilesCache = {};
  for (const [key, files] of Object.entries(cache)) {
    if (used.has(key) || [...failedRepos].some((r) => key.startsWith(`${r}#`))) kept[key] = files;
  }
  return { data, cache: kept, reads };
}
