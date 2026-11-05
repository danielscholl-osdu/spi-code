// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { ForkDef } from "../config.js";
import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { ForkPrFact, MergedMrFact } from "../facts.js";
import type { Gh, Glab } from "../forge.js";
import { errorText } from "../util.js";

const PAGE = 100;
const prSchema = z.object({
  number: z.number().int().positive(), url: z.string(), state: z.enum(["open", "merged"]),
  refs: z.array(z.string()),
});
const commitCutSchema = z.object({
  fact: prSchema, read: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
});
const ledgerSchema = z.object({
  merged: z.record(z.string(), z.array(z.object({
    iid: z.number().int().positive(), title: z.string(), url: z.string(),
    mergedAt: z.iso.datetime({ offset: true }), headSha: z.string(),
    paths: z.array(z.string()).optional(), deleted: z.array(z.string()).optional(),
  }))),
  portPrs: z.record(z.string(), z.object({
    watermark: z.iso.datetime({ offset: true }).optional(),
    prs: z.record(z.string(), prSchema), open: z.array(prSchema).optional(),
    pending: z.record(z.string(), commitCutSchema).optional(),
    permanentCuts: z.record(z.string(), commitCutSchema).optional(),
  })),
  observed: z.record(z.string(), z.iso.datetime({ offset: true })),
});

export type LedgerState = z.infer<typeof ledgerSchema>;
export type PortPrState = LedgerState["portPrs"][string];

export function emptyLedgerState(): LedgerState {
  return { merged: {}, portPrs: {}, observed: {} };
}

export function loadLedgerState(raw: unknown, ctx: CoreContext): { state: LedgerState; reads: ReadRecord[] } {
  const parsed = ledgerSchema.safeParse(raw);
  return parsed.success ? { state: parsed.data, reads: [] } : {
    state: emptyLedgerState(),
    reads: [{
      source: "ledger-state", object: "load", observedAt: ctx.clock.now().toISOString(),
      completeness: { kind: "complete" }, failure: `Invalid ledger state: ${parsed.error.message}`,
    }],
  };
}

function seedOf(fork: ForkDef): string | undefined {
  return fork.seeded ? `${fork.seeded}T00:00:00Z` : undefined;
}

function record(ctx: CoreContext, source: string, object: string, retainedFrom?: string): ReadRecord {
  return {
    source, object, observedAt: ctx.clock.now().toISOString(), completeness: { kind: "complete" },
    ...(retainedFrom ? { retainedFrom } : {}),
  };
}

interface RawMerged {
  mergeRequests?: {
    pageInfo?: { hasNextPage?: boolean };
    nodes?: {
      iid: string; title: string; webUrl: string;
      mergedAt: string | null; diffHeadSha: string | null;
    }[];
  };
}

// GitLab caps complexity at 250; one project's merged MRs cost about 31.
const PROJECTS_PER_QUERY = 5;

export async function readMerged(
  glab: Glab, state: LedgerState, ctx: CoreContext,
): Promise<{ merged: Record<string, MergedMrFact[]>; reads: ReadRecord[] }> {
  const forks = ctx.fleet.forks.filter((f) => seedOf(f));
  const out: Record<string, MergedMrFact[]> = {};
  const reads: ReadRecord[] = [];
  for (let at = 0; at < forks.length; at += PROJECTS_PER_QUERY) {
    const chunk = forks.slice(at, at + PROJECTS_PER_QUERY);
    const fields = chunk.map((f, i) =>
      `p${i}: project(fullPath: ${JSON.stringify(f.upstream)}) { mergeRequests(state: merged, targetBranches: ["master"], mergedAfter: "${seedOf(f)}", first: ${PAGE}) { pageInfo { hasNextPage } nodes { iid title webUrl mergedAt diffHeadSha } } }`);
    let data: Record<string, RawMerged | null> = {};
    let failure: unknown;
    try {
      data = await glab.graphql<Record<string, RawMerged | null>>(`query { ${fields.join(" ")} }`);
    } catch (error) {
      failure = error;
    }
    chunk.forEach((f, i) => {
      const key = `merged:${f.id}`;
      const raw = data[`p${i}`]?.mergeRequests;
      const base = record(ctx, f.upstream, "merged MRs", state.observed[key]);
      if (failure !== undefined || !raw?.nodes || raw.pageInfo?.hasNextPage !== false) {
        const kept = state.merged[f.id];
        if (kept) out[f.id] = kept;
        reads.push(failure !== undefined || !raw?.nodes ? {
          ...base, failure: failure === undefined ? "Merged MRs are not readable" : errorText(failure),
        } : {
          ...base, completeness: {
            kind: "cut", reason: "Merged MRs page is incomplete; total is a lower bound",
            read: raw.nodes.length, total: raw.nodes.length + 1,
          },
        });
        return;
      }
      const merged = raw.nodes.flatMap((m) => m.mergedAt && m.diffHeadSha ? [{
        iid: Number(m.iid), title: m.title, url: m.webUrl,
        mergedAt: m.mergedAt, headSha: m.diffHeadSha,
      }] : []);
      out[f.id] = merged;
      state.merged[f.id] = merged;
      const success = record(ctx, f.upstream, "merged MRs");
      state.observed[key] = success.observedAt;
      reads.push(success);
    });
  }
  return { merged: out, reads };
}

const MR_URL = /community\.opengroup\.org\/([\w.\-/]+?)\/-\/merge_requests\/(\d+)/g;

export function mrRefs(texts: readonly string[]): string[] {
  const refs = new Set<string>();
  for (const text of texts) for (const m of text.matchAll(MR_URL)) refs.add(`${m[1]}!${m[2]}`);
  return [...refs];
}

interface RawSearch {
  issueCount: number;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: ({
    number?: number; url?: string; mergedAt?: string | null; bodyText?: string;
    commits?: {
      totalCount: number; pageInfo?: { hasNextPage?: boolean };
      nodes?: { commit: { message: string } }[];
    };
  } | null)[];
}

const PR_NODE =
  "... on PullRequest { number url mergedAt bodyText commits(first: 50) { totalCount pageInfo { hasNextPage } nodes { commit { message } } } }";

// Round up the search plus 100 nested commit connections for each requested page.
const SEARCH_PAGE_COST = 2;
const SEARCH_CAP = 1000;
const DAY_MS = 86_400_000;

function portSearchField(alias: string, query: string, cursor?: string): string {
  return `${alias}: search(query: ${JSON.stringify(query)}, type: ISSUE, first: ${PAGE}${cursor ? `, after: ${JSON.stringify(cursor)}` : ""}) { issueCount pageInfo { hasNextPage endCursor } nodes { ${PR_NODE} } }`;
}

async function portSearchPage(gh: Gh, query: string, cursor?: string): Promise<RawSearch> {
  const { data, errors } = await gh.graphql<{ port_page?: RawSearch | null }>(
    `query { ${portSearchField("port_page", query, cursor)} }`, SEARCH_PAGE_COST,
  );
  const error = errors.find((e) => !e.path?.length || e.path[0] === "port_page");
  if (error) throw new Error(error.message);
  if (!data.port_page?.nodes) throw new Error("Port PRs are not readable");
  return data.port_page;
}

async function completePortSearch(
  gh: Gh, query: string, first: RawSearch, window?: { repo: string; since: string; until: string },
): Promise<RawSearch> {
  if (!first.nodes) return first;
  if (first.issueCount > SEARCH_CAP) {
    if (!window || window.since >= window.until) return first;
    const start = Date.parse(window.since);
    const end = Date.parse(window.until);
    const middle = start + Math.floor((end - start) / DAY_MS / 2) * DAY_MS;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const nodes: NonNullable<RawSearch["nodes"]> = [];
    for (const [since, until] of [
      [window.since, day(middle)], [day(middle + DAY_MS), window.until],
    ] as const) {
      const part = { repo: window.repo, since, until };
      const subquery = mergedPortQuery(part);
      const result = await completePortSearch(gh, subquery, await portSearchPage(gh, subquery), part);
      if (!result.nodes || result.issueCount > result.nodes.length ||
        result.pageInfo?.hasNextPage !== false) return result;
      nodes.push(...result.nodes);
    }
    return { issueCount: nodes.length, nodes, pageInfo: { hasNextPage: false } };
  }
  const nodes = [...first.nodes];
  const cursors = new Set<string>();
  let page = first;
  let total = first.issueCount;
  while (page.pageInfo?.hasNextPage === true && nodes.length < SEARCH_CAP) {
    const cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor) || !page.nodes?.length) break;
    cursors.add(cursor);
    page = await portSearchPage(gh, query, cursor);
    if (page.issueCount > SEARCH_CAP) return completePortSearch(gh, query, page, window);
    total = Math.max(total, page.issueCount);
    nodes.push(...(page.nodes ?? []));
  }
  return { issueCount: total, nodes, ...(page.pageInfo ? { pageInfo: page.pageInfo } : {}) };
}

function mergedPortQuery(window: { repo: string; since: string; until: string }): string {
  return `repo:${window.repo} is:pr is:merged merged:>=${window.since} merged:<=${window.until}`;
}

export interface PortPrRead {
  prs: Record<string, ForkPrFact[]>;
  read: { prs: number; commits: number };
  reads: ReadRecord[];
}

export async function readPortPrs(gh: Gh, state: LedgerState, ctx: CoreContext): Promise<PortPrRead> {
  const forks = ctx.fleet.forks.filter((f) => seedOf(f));
  const until = ctx.clock.now().toISOString().slice(0, 10);
  const fields = forks.flatMap((f, i) => {
    const since = (state.portPrs[f.id]?.watermark ?? seedOf(f) ?? "").slice(0, 10);
    return [
      portSearchField(`port_o${i}`, `repo:${f.repo} is:pr is:open`),
      portSearchField(`port_m${i}`, mergedPortQuery({ repo: f.repo, since, until })),
    ];
  });
  const out: Record<string, ForkPrFact[]> = {};
  const read = { prs: 0, commits: 0 };
  const reads: ReadRecord[] = [];
  if (!fields.length) return { prs: out, read, reads };
  let data: Record<string, RawSearch | null> = {};
  let errors: Awaited<ReturnType<Gh["graphql"]>>["errors"] = [];
  let failure: unknown;
  try {
    ({ data, errors } = await gh.graphql<typeof data>(
      `query { ${fields.join(" ")} }`, fields.length * SEARCH_PAGE_COST,
    ));
  } catch (error) {
    failure = error;
  }
  for (const [i, f] of forks.entries()) {
    const key = `port:${f.id}`;
    const base = record(ctx, f.repo, "port PRs", state.observed[key]);
    let open = data[`port_o${i}`];
    let merged = data[`port_m${i}`];
    const error = errors.find((e) => !e.path?.length ||
      e.path[0] === `port_o${i}` || e.path[0] === `port_m${i}`);
    let searchFailure = failure;
    if (searchFailure === undefined && !error && open?.nodes && merged?.nodes) {
      try {
        open = await completePortSearch(gh, `repo:${f.repo} is:pr is:open`, open);
        const since = (state.portPrs[f.id]?.watermark ?? seedOf(f) ?? "").slice(0, 10);
        const window = { repo: f.repo, since, until };
        merged = await completePortSearch(gh, mergedPortQuery(window), merged, window);
      } catch (error) {
        searchFailure = error;
      }
    }
    const searches = [open, merged];
    const cut = searches.find((s) => s && (
      s.issueCount > (s.nodes?.length ?? 0) || s.pageInfo?.hasNextPage !== false));
    if (searchFailure !== undefined || error || !open?.nodes || !merged?.nodes || cut) {
      const known = state.portPrs[f.id];
      if (known?.open) out[f.id] = [...known.open, ...Object.values(known.prs)];
      reads.push(searchFailure !== undefined || error || !open?.nodes || !merged?.nodes ? {
        ...base, failure: error?.message ?? (searchFailure === undefined ? "Port PRs are not readable" : errorText(searchFailure)),
      } : {
        ...base, completeness: {
          kind: "cut", reason: (cut?.issueCount ?? 0) > SEARCH_CAP
            ? "GitHub PR search limit is 1000 per date window; search is incomplete"
            : "Port PR search is incomplete",
          read: cut?.nodes?.length ?? 0,
          total: cut?.issueCount ?? 1,
        },
      });
      continue;
    }
    const known: PortPrState = state.portPrs[f.id] ?? { prs: {} };
    const pending: NonNullable<PortPrState["pending"]> = {};
    const permanentCuts: NonNullable<PortPrState["permanentCuts"]> = {};
    const permanentCut = (fact: ForkPrFact, count: number, total: number) => {
      permanentCuts[String(fact.number)] = { fact, read: count, total };
      reads.push({
        ...record(ctx, f.repo, `pulls/${fact.number}/commits`),
        completeness: { kind: "cut", reason: "GitHub PR commits REST limit is 250", read: count, total },
      });
      return fact;
    };
    const completeCommits = async (fact: ForkPrFact, count: number, total: number, inspected = 0) => {
      const object = `pulls/${fact.number}/commits`;
      const capped = known.permanentCuts?.[String(fact.number)];
      if (capped && total > 250) {
        read.commits += inspected;
        return permanentCut({
          ...fact, refs: [...new Set([...capped.fact.refs, ...fact.refs])],
        }, capped.read, total);
      }
      const previousRefs = known.pending?.[String(fact.number)]?.fact.refs ?? [];
      let result = { ...fact, refs: [...new Set([...previousRefs, ...fact.refs])] };
      let observed = count;
      let counted = false;
      try {
        const messages = await gh.pages<string>(`repos/${f.repo}/${object}?per_page=100`, ".[].commit.message | tojson");
        read.commits += messages.length;
        counted = true;
        observed = messages.length;
        result = { ...result, refs: [...new Set([...result.refs, ...mrRefs(messages)])] };
        if (messages.length === 250 && total > 250) return permanentCut(result, messages.length, total);
        if (messages.length < total) throw new Error(`Expected ${total} commits, read ${messages.length}`);
        reads.push(record(ctx, f.repo, object));
        return result;
      } catch (error) {
        if (!counted) read.commits += inspected;
        pending[String(fact.number)] = { fact: result, read: observed, total };
        reads.push({
          ...record(ctx, f.repo, object), failure: errorText(error),
          completeness: { kind: "cut", reason: "PR commit messages are incomplete", read: observed, total },
        });
        return result;
      }
    };
    const fact = async (n: NonNullable<NonNullable<RawSearch["nodes"]>[number]>, kind: ForkPrFact["state"]) => {
      const messages = (n.commits?.nodes ?? []).map((c) => c.commit.message);
      read.prs++;
      const result = { number: n.number ?? 0, url: n.url ?? "", state: kind, refs: mrRefs([n.bodyText ?? "", ...messages]) };
      if (!n.commits?.nodes || n.commits.pageInfo?.hasNextPage !== false ||
        n.commits.totalCount > messages.length) {
        return completeCommits(result, messages.length, n.commits?.totalCount ?? messages.length + 1, messages.length);
      }
      read.commits += messages.length;
      return result;
    };
    // A failed merged PR must be retried even after the search watermark passes it.
    const current = new Set([...merged.nodes, ...open.nodes].map((n) => n?.number));
    for (const capped of Object.values(known.permanentCuts ?? {})) {
      if (capped.fact.state !== "merged" || current.has(capped.fact.number)) continue;
      permanentCut(capped.fact, capped.read, capped.total);
    }
    for (const retry of Object.values(known.pending ?? {})) {
      if (retry.fact.state !== "merged" || current.has(retry.fact.number)) continue;
      read.prs++;
      known.prs[String(retry.fact.number)] = await completeCommits(retry.fact, retry.read, retry.total);
    }
    let watermark = known.watermark;
    for (const n of merged.nodes) {
      if (!n?.number) continue;
      known.prs[String(n.number)] = await fact(n, "merged");
      if (n.mergedAt && (!watermark || n.mergedAt > watermark)) watermark = n.mergedAt;
    }
    const openPrs: ForkPrFact[] = [];
    for (const n of open.nodes) if (n?.number) openPrs.push(await fact(n, "open"));
    state.portPrs[f.id] = { ...(watermark ? { watermark } : {}), prs: known.prs, open: openPrs, pending, permanentCuts };
    out[f.id] = [...openPrs, ...Object.values(known.prs)];
    const incomplete = [...Object.values(pending), ...Object.values(permanentCuts)];
    if (incomplete.length) {
      reads.push({
        ...base,
        completeness: {
          kind: "cut", reason: "Some PR commit messages remain unread",
          read: incomplete.reduce((sum, p) => sum + p.read, 0),
          total: incomplete.reduce((sum, p) => sum + p.total, 0),
        },
      });
      continue;
    }
    const success = record(ctx, f.repo, "port PRs");
    state.observed[key] = success.observedAt;
    reads.push(success);
  }
  return { prs: out, read, reads };
}
