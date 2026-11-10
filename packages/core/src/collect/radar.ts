// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { DiffFact, MrFact, RadarFacts, UpstreamFact } from "../facts.js";
import { encodeProject, type Gh, type Glab } from "../forge.js";
import { parseFilter } from "../model/filter.js";
import { forkOwned } from "../model/radar.js";
import { errorText, pool } from "../util.js";
import { FILTER_PATH, readFilterFile } from "./filters.js";
import { emptyLedgerState, type LedgerState, readMerged, readPortPrs } from "./ledgers.js";
import {
  emptyPinState,
  type PinState,
  readForkPins,
  readLatest,
  readRemoval,
  readUpstreamPins,
} from "./pins.js";

interface RawMr {
  iid: number;
  title: string;
  author?: { username?: string };
  draft?: boolean;
  work_in_progress?: boolean;
  labels?: string[];
  created_at: string;
  updated_at: string;
  sha: string;
  web_url: string;
  head_pipeline?: { status?: string } | null;
}

interface RawDiff {
  old_path: string;
  new_path: string;
  diff?: string;
  deleted_file?: boolean;
  too_large?: boolean;
  collapsed?: boolean;
}

export interface DiffEntry {
  paths: string[];
  hunks?: Record<string, string[]>;
  deleted?: string[];
}

export interface RadarState {
  mrDiffs: Record<string, DiffEntry>;
  commitDiffs: Record<string, DiffEntry>;
  filters: Record<string, string>;
  ledgers: LedgerState;
  pins: PinState;
  records: Record<string, ReadRecord>;
}

export interface RadarRead extends RadarFacts {
  reads: ReadRecord[];
}

export function emptyRadarState(): RadarState {
  return {
    mrDiffs: {}, commitDiffs: {}, filters: {}, ledgers: emptyLedgerState(),
    pins: emptyPinState(), records: {},
  };
}

const HUNK_FILES = /(^|\/)(pom\.xml|\.fossa\.yml)$/;

function missingHunk(d: RawDiff): boolean {
  return HUNK_FILES.test(d.new_path) && (d.too_large === true || d.collapsed === true);
}

interface FullRead {
  object: string;
  sha: string;
}

// GitLab's diffs API collapses files past its size limits; the deprecated changes endpoint with
// access_raw_diffs reads every file from Gitaly uncollapsed, one request per MR however many collapsed.
function fullChanges(iid: number, sha: string): FullRead {
  return { object: `merge_requests/${iid}/changes?access_raw_diffs=true`, sha };
}

function fillHunks(diffs: readonly RawDiff[], changes: readonly RawDiff[]): RawDiff[] {
  const full = new Map(changes.map((c) => [`${c.old_path}\0${c.new_path}`, c]));
  return diffs.map((d) => {
    if (!missingHunk(d)) return d;
    const change = full.get(`${d.old_path}\0${d.new_path}`);
    return change && !missingHunk(change) ? { ...d, diff: change.diff ?? "", too_large: false, collapsed: false } : d;
  });
}

export function diffEntry(diffs: readonly RawDiff[]): DiffEntry {
  const paths = new Set<string>();
  const deleted: string[] = [];
  const hunks: Record<string, string[]> = {};
  for (const d of diffs) {
    if (d.deleted_file) deleted.push(d.old_path);
    paths.add(d.new_path);
    if (d.old_path !== d.new_path) paths.add(d.old_path);
    if (!HUNK_FILES.test(d.new_path)) continue;
    const lines = (d.diff ?? "").split("\n")
      .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));
    if (lines.length > 0) hunks[d.new_path] = lines;
  }
  return { paths: [...paths], ...(Object.keys(hunks).length > 0 ? { hunks } : {}), deleted };
}

export function mrKey(project: string, iid: number, sha: string): string {
  return `${project}!${iid}@${sha}`;
}

function withDiff<T extends object>(fact: T, entry: DiffEntry | undefined): T {
  return entry ? { ...fact, paths: entry.paths, ...(entry.hunks ? { hunks: entry.hunks } : {}) } : fact;
}

// A nested Azure reactor keeps its pom in the module the injected azure profile builds, under the owned tree.
export function azureModule(text: string): string | undefined {
  const tree = forkOwned(parseFilter(text)).find((p) => p.startsWith("provider/"));
  if (!tree) return undefined;
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("inject_root_pom_azure_profile:"));
  const block: string[] = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  const modules = [...block.join("\n").replace(/<!--[\s\S]*?-->/g, "").matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)].map((m) => m[1] as string);
  return modules.find((m) => m === tree) ?? modules.find((m) => m.startsWith(`${tree}/`)) ?? tree;
}

export async function readRadar(
  gh: Gh,
  glab: Glab,
  upstream: Record<string, UpstreamFact>,
  state: RadarState,
  ctx: CoreContext,
  upstreamReads: readonly ReadRecord[] = [],
  previous?: RadarFacts,
): Promise<RadarRead> {
  const out: RadarRead = { services: {}, filters: {}, reads: [] };
  const record = (source: string, object: string): ReadRecord => ({
    source, object, observedAt: ctx.clock.now().toISOString(), completeness: { kind: "complete" },
  });
  async function cachedDiff(
    prefix: "mr" | "commit", cache: Record<string, DiffEntry>, key: string, source: string, object: string,
    full?: FullRead,
  ): Promise<DiffEntry | undefined> {
    const recordKey = `${prefix}:${key}`;
    const known = cache[key];
    const prior = state.records[recordKey];
    if (known && prior && known.deleted) {
      const read = record(source, object);
      state.records[recordKey] = read;
      out.reads.push(read);
      return known;
    }
    try {
      let diffs = await glab.restAll<RawDiff>(`projects/${encodeProject(source)}/${object}`);
      if (full && diffs.some(missingHunk)) {
        try {
          const read = await glab.rest<{ sha?: string; changes?: RawDiff[] }>(
            `projects/${encodeProject(source)}/${full.object}`,
          );
          if (read.sha === full.sha) diffs = fillHunks(diffs, read.changes ?? []);
        } catch {
          // The read stays cut below and is retried next sweep.
        }
      }
      const entry = diffEntry(diffs);
      const missingHunks = diffs.filter(missingHunk);
      if (missingHunks.length > 0) {
        out.reads.push({
          ...record(source, object),
          completeness: {
            kind: "cut", reason: "GitLab omitted oversized or collapsed classification hunks",
            read: diffs.length - missingHunks.length, total: diffs.length,
          },
        });
        return entry;
      }
      const read = record(source, object);
      cache[key] = entry;
      state.records[recordKey] = read;
      out.reads.push(read);
      return entry;
    } catch (error) {
      out.reads.push({ ...record(source, object), failure: errorText(error) });
      return undefined;
    }
  }
  const merged = await readMerged(glab, state.ledgers, ctx);
  const ports = await readPortPrs(gh, state.ledgers, ctx);
  out.reads.push(...merged.reads, ...ports.reads);
  out.portRead = ports.read;
  await pool(ctx.fleet.forks, 3, async (fork) => {
    const project = encodeProject(fork.upstream);
    const object = "merge_requests?state=opened&target_branch=master";
    let raw: RawMr[];
    try {
      raw = await glab.restAll<RawMr>(`projects/${project}/${object}`);
      out.reads.push(record(fork.upstream, object));
    } catch (error) {
      const last = previous?.services[fork.id];
      if (last) out.services[fork.id] = last;
      const filter = previous?.filters[fork.id];
      if (filter) out.filters[fork.id] = filter;
      out.reads.push({ ...record(fork.upstream, object), failure: errorText(error) });
      return;
    }
    const mrs = await pool(raw, 3, async (m): Promise<MrFact> => withDiff({
      iid: m.iid, title: m.title, author: m.author?.username ?? "",
      draft: m.draft ?? m.work_in_progress ?? false, labels: m.labels ?? [],
      createdAt: m.created_at, updatedAt: m.updated_at, headSha: m.sha, url: m.web_url,
      ...(m.head_pipeline?.status ? { pipeline: m.head_pipeline.status } : {}),
    }, await cachedDiff(
      "mr", state.mrDiffs, mrKey(fork.upstream, m.iid, m.sha),
      fork.upstream, `merge_requests/${m.iid}/diffs`, fullChanges(m.iid, m.sha),
    )));
    const queued = await pool(upstream[fork.id]?.commits ?? [], 3, async (c): Promise<DiffFact> =>
      withDiff({ sha: c.sha, title: c.title, at: c.at, url: c.url }, await cachedDiff(
        "commit", state.commitDiffs, c.sha, fork.upstream, `repository/commits/${c.sha}/diff`,
      )));
    const list = merged.merged[fork.id];
    const landed = list ? await pool(list, 3, async (m) => {
      const entry = await cachedDiff(
        "mr", state.mrDiffs, mrKey(fork.upstream, m.iid, m.headSha),
        fork.upstream, `merge_requests/${m.iid}/diffs`, fullChanges(m.iid, m.headSha),
      );
      return entry ? { ...m, paths: entry.paths, deleted: entry.deleted ?? [] } : m;
    }) : undefined;
    const forkPrs = ports.prs[fork.id];
    const pins = await readUpstreamPins(glab, fork.upstream, upstream[fork.id]?.head?.sha, state.pins, ctx,
      upstreamReads.find((r) => r.source === fork.upstream && r.object === "repository/branches/master"));
    out.reads.push(...pins.reads);
    out.services[fork.id] = {
      project: fork.upstream, mrs, queued,
      ...(landed ? { merged: landed } : {}), ...(forkPrs ? { forkPrs } : {}),
      ...(pins.pins ? { pins: { upstream: pins.pins } } : {}),
    };
    try {
      const file = await readFilterFile(gh, fork.repo);
      state.filters[file.sha] = file.text;
      state.filters[`repo:${fork.repo}`] = file.sha;
      out.filters[fork.id] = file;
      out.reads.push(record(fork.repo, FILTER_PATH));
    } catch (error) {
      const last = previous?.filters[fork.id];
      const sha = last?.sha ?? state.filters[`repo:${fork.repo}`];
      const text = sha ? state.filters[sha] : undefined;
      if (sha && text !== undefined) out.filters[fork.id] = { sha, text };
      const prior = state.records[`filter:${fork.repo}`];
      out.reads.push({ ...record(fork.repo, FILTER_PATH), failure: errorText(error),
        ...(text !== undefined && prior
          ? { retainedFrom: prior.retainedFrom ?? prior.observedAt } : {}) });
    }
    const read = [...out.reads].reverse().find((r) => r.source === fork.repo && r.object === FILTER_PATH);
    if (read) state.records[`filter:${fork.repo}`] = read;
  });
  const forkPins = await readForkPins(gh, ctx.fleet.forks.map((f) => {
    const text = out.filters[f.id]?.text;
    const azure = text ? azureModule(text) : undefined;
    return { id: f.id, repo: f.repo, ...(azure ? { azure } : {}) };
  }), state.pins, ctx);
  out.reads.push(...forkPins.reads);
  for (const [id, pins] of Object.entries(forkPins.pins)) {
    const service = out.services[id];
    if (!service || !pins.root) continue;
    service.pins = {
      ...service.pins,
      fork: { ...pins.root, ...(pins.azure?.coreLibAzure ? { coreLibAzure: pins.azure.coreLibAzure } : {}) },
    };
  }
  const latest = await readLatest(glab, state.pins, ctx);
  out.latest = latest.pins;
  out.reads.push(...latest.reads);
  const removal = await readRemoval(glab, state.pins, ctx);
  if (removal.removal) out.removal = removal.removal;
  out.reads.push(...removal.reads);
  return out;
}

// Active references take precedence over the cap; unreferenced entries keep insertion order.
export function pruneRadar(state: RadarState, facts: RadarFacts | undefined, cap = 200): void {
  const mrs = new Set<string>();
  const commits = new Set<string>();
  const blobs = new Set<string>();
  for (const svc of Object.values(facts?.services ?? {})) {
    for (const m of [...svc.mrs, ...(svc.merged ?? [])]) mrs.add(mrKey(svc.project, m.iid, m.headSha));
    for (const c of svc.queued) commits.add(c.sha);
  }
  for (const f of Object.values(facts?.filters ?? {})) blobs.add(f.sha);
  capMap(state.mrDiffs, mrs, cap);
  capMap(state.commitDiffs, commits, cap);
  for (const key of Object.keys(state.filters)) {
    if (key.startsWith("repo:") ? !blobs.has(state.filters[key] ?? "") : !blobs.has(key)) delete state.filters[key];
  }
  for (const key of Object.keys(state.records)) {
    if (key.startsWith("filter:") ? !state.filters[`repo:${key.slice(7)}`]
      : key.startsWith("mr:") ? !state.mrDiffs[key.slice(3)] : !state.commitDiffs[key.slice(7)]) {
      delete state.records[key];
    }
  }
  capMap(state.pins.poms, new Set(), 60);
  capMap(state.pins.upstreamPoms, new Set(), 60);
}

function capMap(map: Record<string, unknown>, keep: ReadonlySet<string>, cap: number): void {
  let over = Object.keys(map).length - cap;
  for (const key of Object.keys(map)) {
    if (over <= 0) break;
    if (keep.has(key)) continue;
    delete map[key];
    over--;
  }
}
