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
const ledgerSchema = z.object({
  merged: z.record(z.string(), z.array(z.object({
    iid: z.number().int().positive(), title: z.string(), url: z.string(),
    mergedAt: z.iso.datetime({ offset: true }), headSha: z.string(),
    paths: z.array(z.string()).optional(), deleted: z.array(z.string()).optional(),
  }))),
  portPrs: z.record(z.string(), z.object({
    watermark: z.iso.datetime({ offset: true }).optional(),
    prs: z.record(z.string(), prSchema), open: z.array(prSchema).optional(),
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
  pageInfo?: { hasNextPage?: boolean };
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

export interface PortPrRead {
  prs: Record<string, ForkPrFact[]>;
  read: { prs: number; commits: number };
  reads: ReadRecord[];
}

export async function readPortPrs(gh: Gh, state: LedgerState, ctx: CoreContext): Promise<PortPrRead> {
  const forks = ctx.fleet.forks.filter((f) => seedOf(f));
  const fields = forks.flatMap((f, i) => {
    const since = (state.portPrs[f.id]?.watermark ?? seedOf(f) ?? "").slice(0, 10);
    return [
      `port_o${i}: search(query: "repo:${f.repo} is:pr is:open", type: ISSUE, first: ${PAGE}) { issueCount pageInfo { hasNextPage } nodes { ${PR_NODE} } }`,
      `port_m${i}: search(query: "repo:${f.repo} is:pr is:merged merged:>=${since}", type: ISSUE, first: ${PAGE}) { issueCount pageInfo { hasNextPage } nodes { ${PR_NODE} } }`,
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
    ({ data, errors } = await gh.graphql<typeof data>(`query { ${fields.join(" ")} }`));
  } catch (error) {
    failure = error;
  }
  forks.forEach((f, i) => {
    const key = `port:${f.id}`;
    const base = record(ctx, f.repo, "port PRs", state.observed[key]);
    const open = data[`port_o${i}`];
    const merged = data[`port_m${i}`];
    const error = errors.find((e) => !e.path?.length ||
      e.path[0] === `port_o${i}` || e.path[0] === `port_m${i}`);
    const searches = [open, merged];
    const cut = searches.find((s) => s && (
      s.issueCount > (s.nodes?.length ?? 0) || s.pageInfo?.hasNextPage !== false));
    const commitCut = searches.flatMap((s) => s?.nodes ?? []).find((n) => n?.number && (
      !n.commits?.nodes || n.commits.pageInfo?.hasNextPage !== false ||
      n.commits.totalCount > n.commits.nodes.length));
    if (failure !== undefined || error || !open?.nodes || !merged?.nodes || cut || commitCut) {
      const known = state.portPrs[f.id];
      if (known?.open) out[f.id] = [...known.open, ...Object.values(known.prs)];
      const count = commitCut?.commits;
      reads.push(failure !== undefined || error || !open?.nodes || !merged?.nodes ? {
        ...base, failure: error?.message ?? (failure === undefined ? "Port PRs are not readable" : errorText(failure)),
      } : {
        ...base, completeness: {
          kind: "cut", reason: count ? "PR commit messages are incomplete" : "Port PR search is incomplete",
          read: count?.nodes?.length ?? cut?.nodes?.length ?? 0,
          total: count?.totalCount ?? cut?.issueCount ?? 1,
        },
      });
      return;
    }
    const fact = (n: NonNullable<NonNullable<RawSearch["nodes"]>[number]>, kind: ForkPrFact["state"]) => {
      const messages = (n.commits?.nodes ?? []).map((c) => c.commit.message);
      read.prs++;
      read.commits += messages.length;
      return { number: n.number ?? 0, url: n.url ?? "", state: kind, refs: mrRefs([n.bodyText ?? "", ...messages]) };
    };
    const known = state.portPrs[f.id] ?? { prs: {} };
    let watermark = known.watermark;
    for (const n of merged.nodes) {
      if (!n?.number) continue;
      known.prs[String(n.number)] = fact(n, "merged");
      if (n.mergedAt && (!watermark || n.mergedAt > watermark)) watermark = n.mergedAt;
    }
    const openPrs = open.nodes.flatMap((n) => n?.number ? [fact(n, "open")] : []);
    state.portPrs[f.id] = { ...(watermark ? { watermark } : {}), prs: known.prs, open: openPrs };
    out[f.id] = [...openPrs, ...Object.values(known.prs)];
    const success = record(ctx, f.repo, "port PRs");
    state.observed[key] = success.observedAt;
    reads.push(success);
  });
  return { prs: out, read, reads };
}
