// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { githubUrl, TEMPLATE_REPO } from "../config.js";
import type { CoreContext } from "../context.js";
import type { ReadCompleteness, ReadRecord } from "../evidence/index.js";
import type { RepoFact, TemplateChange, TemplateFacts } from "../facts.js";
import type { Gh } from "../forge.js";
import { semverCmp } from "../model/stack.js";
import { usedAtSchema } from "./recency.js";
import { errorText, short } from "../util.js";

const commitSchema = z.object({
  sha: z.string(), parents: z.array(z.string()), message: z.string(),
  date: z.string(), url: z.string(),
});
type RawCommit = z.infer<typeof commitSchema>;
const positionSchema = z.object({
  status: z.string(), ahead_by: z.int().nonnegative(), behind_by: z.int().nonnegative(),
});
const compareSchema = positionSchema.extend({
  total_commits: z.int().nonnegative(), commits: z.array(commitSchema),
});
const pathsSchema = z.object({ dirs: z.array(z.string()), files: z.array(z.string()) });
const completenessSchema = z.union([
  z.object({ kind: z.literal("complete") }),
  z.object({ kind: z.literal("cut"), reason: z.string().min(1), read: z.int().nonnegative(), total: z.int().nonnegative() }),
]).refine((value) => value.kind === "complete" || value.read <= value.total, "Read count exceeds total");
const recordSchema = z.object({
  source: z.string().min(1), object: z.string().min(1), observedAt: z.iso.datetime({ offset: true }),
  completeness: completenessSchema, failure: z.string().min(1).optional(),
  retainedFrom: z.iso.datetime({ offset: true }).optional(),
});
export type TemplateState = Record<string, { value: unknown; record: ReadRecord; usedAt?: string }>;
export const templateStateSchema: z.ZodType<TemplateState> = z.record(z.string(), z.object({
  value: z.union([compareSchema, positionSchema, pathsSchema, z.array(z.string())]), record: recordSchema,
  usedAt: usedAtSchema,
}));
export interface TemplateRead extends TemplateFacts {
  state: TemplateState;
  reads: ReadRecord[];
}

const SYNC_CONFIG_JQ =
  '.content | gsub("\\n"; "") | @base64d | fromjson | .sync_rules | {dirs: [.directories[]?.path], files: ([.files[]?.path] + [.workflows.template_workflows[]?.path])}';
const COMPARE_JQ =
  "{status, ahead_by, behind_by, total_commits, commits: [.commits[] | {sha, parents: [.parents[].sha], message: .commit.message, date: .commit.committer.date, url: .html_url}]}";
const POSITION_JQ = "{status, ahead_by, behind_by}";
const LABEL_TAGS = 5;
export const TEMPLATE_COMPARE_PAGES = 10;

export function changeOf(c: RawCommit): TemplateChange {
  const lines = c.message.split(/\r?\n/);
  const parent = c.parents[0];
  const merge = /^Merge pull request #(\d+) from \S+/.exec(lines[0] ?? "");
  if (merge) {
    const title = lines.slice(1).find((l) => l.trim().length > 0)?.trim() ?? lines[0] ?? "";
    const pr = Number(merge[1]);
    return { sha: c.sha, parent, title, pr, url: githubUrl(TEMPLATE_REPO, `/pull/${pr}`), at: c.date };
  }
  const subject = (lines[0] ?? "").trim();
  const squash = /\(#(\d+)\)$/.exec(subject);
  return {
    sha: c.sha, parent, title: subject, pr: squash ? Number(squash[1]) : undefined,
    url: squash ? githubUrl(TEMPLATE_REPO, `/pull/${squash[1]}`) : c.url, at: c.date,
  };
}

export function firstParentChanges(head: string, commits: readonly RawCommit[]): TemplateChange[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const out: TemplateChange[] = [];
  let cur = bySha.get(head);
  while (cur) {
    out.push(changeOf(cur));
    cur = cur.parents[0] ? bySha.get(cur.parents[0]) : undefined;
  }
  return out;
}

const comparePath = (base: string, head: string) => `repos/${TEMPLATE_REPO}/compare/${base}...${head}`;
type Loaded<T> = { value: T; completeness?: ReadCompleteness };

export async function readTemplate(
  ctx: CoreContext,
  gh: Gh,
  repos: Record<string, RepoFact>,
  stored: unknown = {},
  previous?: TemplateRead,
): Promise<TemplateRead> {
  const observedAt = ctx.clock.now().toISOString();
  const parsed = templateStateSchema.safeParse(stored);
  const state: TemplateState = parsed.success ? { ...parsed.data } : {};
  const reads: ReadRecord[] = [];
  const invalid = (object: string, failure: string) => reads.push({
    source: "persist", object, observedAt, completeness: { kind: "complete" }, failure,
  });
  if (!parsed.success) invalid("template", parsed.error.message);

  async function read<T>(
    object: string, schema: z.ZodType<T>, load: () => Promise<Loaded<T>>,
    retained?: ReadRecord, cacheKey = object, reuseCut = false,
  ): Promise<T | undefined> {
    let cached = state[cacheKey];
    if (cached) {
      const checked = schema.safeParse(cached.value);
      if (!checked.success) {
        invalid(cacheKey, checked.error.message);
        delete state[cacheKey];
        cached = undefined;
      } else if (cached.record.failure === undefined && (cached.record.completeness.kind === "complete" || reuseCut)) {
        state[cacheKey] = { ...cached, usedAt: observedAt };
        reads.push(cached.record);
        return checked.data;
      }
    }
    try {
      const loaded = await load();
      const value = schema.parse(loaded.value);
      const record: ReadRecord = {
        source: TEMPLATE_REPO, object, observedAt,
        completeness: loaded.completeness ?? { kind: "complete" },
      };
      state[cacheKey] = { value, record, usedAt: observedAt };
      reads.push(record);
      return value;
    } catch (error) {
      const last = cached?.record ?? retained;
      const retainedFrom = last?.retainedFrom ?? (last?.failure === undefined ? last?.observedAt : undefined);
      const record: ReadRecord = {
        source: TEMPLATE_REPO, object, observedAt,
        completeness: last?.completeness ?? { kind: "complete" },
        failure: errorText(error) || "Unknown error",
        ...(retainedFrom ? { retainedFrom } : {}),
      };
      reads.push(record);
      if (cached) {
        state[cacheKey] = { value: cached.value, record, usedAt: observedAt };
        return schema.parse(cached.value);
      }
      return undefined;
    }
  }

  const template = repos[TEMPLATE_REPO];
  const head = template?.head?.sha;
  const latestTag = template?.release?.tag;
  const facts: TemplateRead = { latestTag, compares: {}, state, reads };
  if (!head) return facts;

  let tags: string[] = [];
  if (latestTag) {
    const path = `repos/${TEMPLATE_REPO}/tags?per_page=100`;
    tags = await read(path, z.array(z.string()), async () => {
      const names = (await gh.pages<string[]>(path, "[.[].name]")).flat();
      const list = names.filter((t) => /^v?\d+\.\d+\.\d+$/.test(t)).sort((a, b) => semverCmp(b, a));
      if (!list.includes(latestTag)) list.unshift(latestTag);
      return { value: list };
    }, undefined, `${path}@${latestTag}`) ?? [latestTag];
    const pathAhead = comparePath(latestTag, head);
    const priorAhead = previous?.mainAhead === undefined || previous.latestTag !== latestTag ? undefined
      : previous.reads.find((r) => r.object.startsWith(comparePath(latestTag, "")));
    const cmp = await read(pathAhead, positionSchema, async () => ({
      value: await gh.rest(pathAhead, POSITION_JQ),
    }), priorAhead, `position:${pathAhead}`);
    if (cmp) facts.mainAhead = cmp.status === "identical" ? 0 : cmp.ahead_by;
    else if (priorAhead) facts.mainAhead = previous?.mainAhead;
  }

  async function label(marker: string, priorLabel?: string): Promise<string> {
    for (const tag of tags.slice(0, LABEL_TAGS)) {
      const path = comparePath(tag, marker);
      const cmp = await read(path, positionSchema, async () => ({ value: await gh.rest(path, POSITION_JQ) }),
        priorLabel === undefined ? undefined : previous?.reads.find((r) => r.object === path)
          ?? previous?.reads.find((r) =>
            r.object.startsWith(`repos/${TEMPLATE_REPO}/compare/`) && r.object.endsWith(`...${marker}`)),
        `position:${path}`);
      if (!cmp) return priorLabel ?? short(marker);
      if (cmp.status === "identical") return tag;
      if (cmp.status === "ahead") return `${tag} +${cmp.ahead_by}`;
    }
    return short(marker);
  }

  const markers = [...new Set(ctx.fleet.forks.map((f) => repos[f.repo]?.marker).filter((m): m is string => !!m))];
  for (const marker of markers) {
    const path = comparePath(marker, head);
    const prior = previous?.compares[marker];
    const priorRead = prior && previous.reads.find((r) => r.object.startsWith(comparePath(marker, "")));
    const cmp = await read(path, compareSchema, async () => {
      const result = compareSchema.parse(await gh.rest(`${path}?per_page=100&page=1`, COMPARE_JQ));
      const newest: RawCommit[] = [];
      let pages = 1;
      if (result.commits.length === 0 && result.total_commits > 0) {
        throw new Error("Template compare ended before total_commits");
      }
      // Compare pages are oldest-first. Spend the remaining calls on the head's
      // end of the history so even a cut walk includes the newest changes.
      for (let page = Math.ceil(result.total_commits / 100); page > 1 && pages < TEMPLATE_COMPARE_PAGES; page--) {
        const batch = compareSchema.parse(await gh.rest(`${path}?per_page=100&page=${page}`, COMPARE_JQ));
        if (batch.commits.length === 0) throw new Error("Template compare ended before total_commits");
        newest.unshift(...batch.commits);
        pages++;
      }
      const commits = [...result.commits, ...newest];
      if (commits.length >= result.total_commits) return { value: { ...result, commits } };
      return {
        value: { ...result, commits },
        completeness: { kind: "cut", reason: "Template commit page limit", read: commits.length, total: result.total_commits },
      };
    }, priorRead);
    if (cmp) {
      facts.compares[marker] = {
        marker, head, label: await label(marker, prior?.label),
        aheadBy: cmp.status === "identical" ? 0 : cmp.ahead_by,
        shas: cmp.commits.map((c) => c.sha), changes: firstParentChanges(head, cmp.commits),
      };
    } else if (prior) {
      facts.compares[marker] = prior;
    }
  }

  facts.files = {};
  const changes = Object.values(facts.compares).flatMap((c) => c.changes);
  for (const c of new Map(changes.map((c) => [c.sha, c])).values()) {
    if (!c.parent) continue;
    const path = comparePath(c.parent, c.sha);
    const object = `files:${path}`;
    const priorFiles = previous?.files?.[c.sha];
    const files = await read(object, z.array(z.string()), async () => {
      const value = z.array(z.string()).parse(await gh.rest(path, "[.files[]?.filename]"));
      // GitHub only returns files on the first compare page, capped at 300.
      return { value, ...(value.length >= 300 ? {
        completeness: { kind: "cut" as const, reason: "GitHub compare file limit (total unknown)", read: value.length, total: value.length },
      } : {}) };
    }, priorFiles === undefined ? undefined : previous?.reads.find((r) => r.object === object), object, true);
    const retainedFiles = files ?? priorFiles;
    if (retainedFiles !== undefined) facts.files[c.sha] = retainedFiles;
  }

  const syncPath = `repos/${TEMPLATE_REPO}/contents/.github/sync-config.json?ref=${head}`;
  const priorSync = previous?.synced && previous.reads.find((r) => r.object.includes("/contents/.github/sync-config.json"));
  const synced = await read(syncPath, pathsSchema, async () => ({
    value: await gh.rest(syncPath, SYNC_CONFIG_JQ),
  }), priorSync);
  if (synced ?? previous?.synced) facts.synced = synced ?? previous?.synced;

  const moved = new Set(ctx.fleet.forks.flatMap((f) =>
    (repos[f.repo]?.prs ?? []).map((p) => p.headMarker).filter((m): m is string => !!m && m !== repos[f.repo]?.marker)));
  const targets: Record<string, string> = {};
  for (const sha of moved) targets[sha] = await label(sha, previous?.targets?.[sha]);
  if (moved.size > 0) facts.targets = targets;
  facts.reads = [...new Map(reads.map((r) => [`${r.source}:${r.object}`, r])).values()];
  return facts;
}
