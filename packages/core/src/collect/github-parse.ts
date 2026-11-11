// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { LIFECYCLE_WORKFLOWS, type LifecycleKind } from "../config.js";
import type { CoreContext } from "../context.js";
import type {
  CheckFact,
  Declaration,
  DeploymentFact,
  GithubFacts,
  IssueFact,
  PastIssueFact,
  PastPrFact,
  PrFact,
  ReleaseFact,
  RepoFact,
} from "../facts.js";

const LIFECYCLE_KINDS = Object.keys(LIFECYCLE_WORKFLOWS) as LifecycleKind[];

interface RawCheck {
  __typename: string;
  databaseId?: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  detailsUrl?: string | null;
  checkSuite?: { workflowRun?: { databaseId?: number; workflow?: { name?: string } } | null };
}

interface RawPr {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  author?: { __typename?: string; login?: string } | null;
  authorAssociation?: string;
  headRef?: { target?: { file?: { object?: { text?: string } | null } | null } } | null;
  labels?: { nodes?: { name: string }[] };
  commits?: {
    nodes?: { commit?: { oid?: string; committedDate?: string | null; statusCheckRollup?: { contexts?: { nodes?: RawCheck[] } } | null } }[];
  };
}

interface RawIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author?: { __typename?: string; login?: string } | null;
  authorAssociation?: string;
  labels?: { nodes?: { name: string }[] };
  comments?: { totalCount?: number };
  body?: string | null;
}

interface RawRepo {
  nameWithOwner: string;
  url: string;
  autoMergeAllowed?: boolean;
  defaultBranchRef?: { target?: { oid?: string; committedDate?: string } } | null;
  latestRelease?: { tagName: string; publishedAt: string; url: string } | null;
  pullRequests?: { totalCount?: number; nodes?: RawPr[] };
  issues?: { totalCount?: number; nodes?: RawIssue[] };
  marker?: { text?: string } | null;
  upstreamLog?: {
    target?: { history?: { nodes?: { oid: string; message: string; committedDate: string }[] } };
  } | null;
  deployments?: {
    nodes?: {
      createdAt: string;
      commitOid?: string;
      ref?: { name?: string } | null;
      latestStatus?: { state?: string; createdAt?: string } | null;
    }[];
  };
  declaration?: { text?: string } | null;
  syncTemplate?: { text?: string } | null;
  pastPrs?: {
    nodes?: {
      number: number;
      title: string;
      url: string;
      createdAt: string;
      updatedAt?: string | null;
      mergedAt?: string | null;
      closedAt?: string | null;
      headRefName: string;
      baseRefName: string;
      author?: { login?: string } | null;
    }[];
  };
  pastIssues?: {
    nodes?: {
      number: number;
      url: string;
      createdAt: string;
      closedAt?: string | null;
      labels?: { nodes?: { name: string }[] };
    }[];
  };
  releases?: {
    nodes?: { tagName: string; publishedAt?: string | null; url: string; isDraft?: boolean }[];
  };
  [workflow: `wf_${string}`]: { text?: string } | null | undefined;
}

function parseChecks(nodes: RawCheck[] | undefined): CheckFact[] {
  const out: CheckFact[] = [];
  for (const n of nodes ?? []) {
    if (n.__typename !== "CheckRun" || n.databaseId === undefined || !n.name) continue;
    const run = n.checkSuite?.workflowRun ?? undefined;
    out.push({
      id: n.databaseId,
      name: n.name,
      workflow: run?.workflow?.name ?? undefined,
      runId: run?.databaseId ?? undefined,
      status: n.status ?? "UNKNOWN",
      conclusion: n.conclusion ?? undefined,
      startedAt: n.startedAt ?? undefined,
      completedAt: n.completedAt ?? undefined,
      url: n.detailsUrl ?? undefined,
    });
  }
  return out;
}

function parsePr(repo: string, p: RawPr): PrFact {
  const last = p.commits?.nodes?.[0]?.commit;
  const headAt = last?.oid === p.headRefOid ? last.committedDate ?? undefined : undefined;
  return {
    repo,
    number: p.number,
    title: p.title,
    url: p.url,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    draft: p.isDraft,
    head: p.headRefName,
    base: p.baseRefName,
    headSha: p.headRefOid,
    ...(headAt ? { headAt } : {}),
    headMarker: p.headRef?.target?.file?.object?.text?.trim() || undefined,
    mergeState: p.mergeStateStatus ?? undefined,
    reviewDecision: p.reviewDecision ?? undefined,
    author: p.author?.login ?? undefined,
    ...(p.author?.__typename ? { authorApp: p.author.__typename === "Bot" } : {}),
    association: p.authorAssociation ?? undefined,
    labels: (p.labels?.nodes ?? []).map((l) => l.name),
    checks: parseChecks(last?.statusCheckRollup?.contexts?.nodes),
  };
}

// The sync engine writes the halt as "### Halt" followed by "<CODE>: <detail>".
export function parseHalt(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((l) => /^#{2,4}\s*Halt\s*$/i.test(l.trim()));
  if (at < 0) return undefined;
  return lines
    .slice(at + 1)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
}

function parseIssue(repo: string, i: RawIssue): IssueFact {
  const labels = (i.labels?.nodes ?? []).map((l) => l.name);
  return {
    repo,
    number: i.number,
    title: i.title,
    url: i.url,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    author: i.author?.login ?? undefined,
    association: i.authorAssociation ?? undefined,
    ...(i.author?.__typename === "Bot" ? { bot: true } : {}),
    labels,
    comments: i.comments?.totalCount ?? 0,
    halt: labels.includes("sync-failed") ? parseHalt(i.body) : undefined,
  };
}

export function parseDeclaration(text: string | undefined): Declaration | undefined {
  if (!text) return undefined;
  const field = (name: string) =>
    new RegExp(`^${name}:\\s*["']?([^"'\\s#]+)`, "m").exec(text)?.[1] ?? undefined;
  const forks = [...text.matchAll(/^\s*-\s*service:\s*["']?([\w-]+)/gm)].map((m) => m[1] as string);
  return {
    stackVersion: field("stackVersion"),
    location: field("location"),
    profile: field("profile"),
    forks,
  };
}

export function parseUpstreamSha(
  nodes: { oid: string; message: string; committedDate: string }[] | undefined,
): { sha: string; at: string } | undefined {
  for (const n of nodes ?? []) {
    const m = /^Upstream-Sha:\s*([0-9a-f]{7,40})\s*$/m.exec(n.message);
    if (m) return { sha: m[1] as string, at: n.committedDate };
  }
  return undefined;
}

function parseDeployments(raw: RawRepo["deployments"]): DeploymentFact[] {
  return (raw?.nodes ?? []).map((d) => ({
    createdAt: d.createdAt,
    ref: d.ref?.name ?? undefined,
    sha: d.commitOid ?? undefined,
    state: d.latestStatus?.state ?? undefined,
    statusAt: d.latestStatus?.createdAt ?? undefined,
  }));
}

export function parseCrons(text: string | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(/^\s*-?\s*cron:\s*["']([^"']+)["']/gm)].map((m) =>
    (m[1] as string).trim(),
  );
}

function parsePastPrs(raw: RawRepo["pastPrs"]): PastPrFact[] | undefined {
  if (!raw) return undefined;
  return (raw.nodes ?? []).map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    head: p.headRefName,
    base: p.baseRefName,
    createdAt: p.createdAt,
    ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
    mergedAt: p.mergedAt ?? undefined,
    closedAt: p.closedAt ?? undefined,
    ...(p.author?.login ? { author: p.author.login } : {}),
  }));
}

function parsePastIssues(raw: RawRepo["pastIssues"]): PastIssueFact[] | undefined {
  if (!raw) return undefined;
  return (raw.nodes ?? []).map((i) => ({
    number: i.number,
    url: i.url,
    createdAt: i.createdAt,
    closedAt: i.closedAt ?? undefined,
    labels: (i.labels?.nodes ?? []).map((l) => l.name),
  }));
}

function parseReleases(raw: RawRepo["releases"]): ReleaseFact[] | undefined {
  if (!raw) return undefined;
  return (raw.nodes ?? []).flatMap((r) =>
    r.isDraft || !r.publishedAt ? [] : [{ tag: r.tagName, at: r.publishedAt, url: r.url }],
  );
}

function parseSchedules(raw: RawRepo): RepoFact["schedules"] {
  const out: NonNullable<RepoFact["schedules"]> = {};
  let any = false;
  for (const kind of LIFECYCLE_KINDS) {
    const file = raw[`wf_${kind}`];
    if (file === undefined) continue;
    any = true;
    out[kind] = parseCrons(file?.text);
  }
  return any ? out : undefined;
}

export function parseRepo(raw: RawRepo): RepoFact {
  const repo = raw.nameWithOwner;
  const target = raw.defaultBranchRef?.target;
  return {
    repo,
    url: raw.url,
    autoMergeAllowed: raw.autoMergeAllowed,
    head:
      target?.oid && target.committedDate
        ? { sha: target.oid, at: target.committedDate }
        : undefined,
    release: raw.latestRelease
      ? {
          tag: raw.latestRelease.tagName,
          at: raw.latestRelease.publishedAt,
          url: raw.latestRelease.url,
        }
      : undefined,
    marker: raw.marker?.text?.trim() || undefined,
    upstreamSha: parseUpstreamSha(raw.upstreamLog?.target?.history?.nodes),
    declaration: parseDeclaration(raw.declaration?.text ?? undefined),
    prs: (raw.pullRequests?.nodes ?? []).map((p) => parsePr(repo, p)),
    issues: (raw.issues?.nodes ?? []).map((i) => parseIssue(repo, i)),
    ...(raw.pullRequests?.totalCount !== undefined ? { openPrs: raw.pullRequests.totalCount } : {}),
    ...(raw.issues?.totalCount !== undefined ? { openIssues: raw.issues.totalCount } : {}),
    deployments: parseDeployments(raw.deployments),
    pastPrs: parsePastPrs(raw.pastPrs),
    pastIssues: parsePastIssues(raw.pastIssues),
    releases: parseReleases(raw.releases),
    schedules: parseSchedules(raw),
    ...(raw.syncTemplate !== undefined ? { syncCrons: parseCrons(raw.syncTemplate?.text) } : {}),
  };
}

export function parseGithub(data: Record<string, unknown>, context: CoreContext): GithubFacts {
  const repos: Record<string, RepoFact> = {};
  const planned: Record<string, boolean> = {};
  for (const [alias, value] of Object.entries(data)) {
    if (alias.startsWith("r_") && value) {
      const fact = parseRepo(value as RawRepo);
      repos[fact.repo] = fact;
    }
  }
  context.fleet.planned.forEach((p, i) => {
    planned[p.id] = !!data[`p_${i}`];
  });
  const rate = data.rateLimit as
    | { cost?: number; remaining?: number; resetAt?: string }
    | undefined;
  return {
    repos,
    planned,
    rate:
      rate?.remaining !== undefined && rate.resetAt
        ? {
            remaining: rate.remaining,
            resetAt: rate.resetAt,
            ...(rate.cost !== undefined ? { cost: rate.cost } : {}),
          }
        : undefined,
  };
}

