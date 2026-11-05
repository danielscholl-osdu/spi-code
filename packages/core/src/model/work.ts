// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { TEMPLATE_REPO } from "../config.js";
import type { CoreContext } from "../context.js";
import type { IssueFact, PrFact, RepoFact } from "../facts.js";
import { classifyPr, type PrClass } from "./attribution.js";

export type PrKind = "people" | "bots" | "pipeline";
export type IssueKind = "bug" | "enhancement" | "other" | "automation";

const PR_KIND: Readonly<Record<PrClass, PrKind>> = Object.freeze({
  sync: "pipeline",
  cascade: "pipeline",
  template: "pipeline",
  release: "pipeline",
  bump: "pipeline",
  dependabot: "bots",
  agent: "people",
  human: "people",
});

const INSIDERS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// Labels the sync engine and cascade put on the issues they open.
const AUTOMATION_LABELS = Object.freeze([
  "sync-failed",
  "upstream-sync",
  "conflict",
  "cascade-blocked",
  "cascade-failed",
]);

// The template's label for an issue that waits on a person's action or approval.
export const HUMAN_LABEL = "human-required";

export function needsHuman(issue: Pick<IssueFact, "labels">): boolean {
  return issue.labels.includes(HUMAN_LABEL);
}

export interface WorkRow {
  repo: string;
  name: string;
  read: boolean;
  prs: Record<PrKind, PrFact[]>;
  // People PRs from authors outside the repository's organization.
  contributors: PrFact[];
  issues: Record<IssueKind, IssueFact[]>;
  // The oldest ready people PR: work a person waits on.
  oldest?: PrFact;
  // Open totals the page did not reach, so a count is never silently short.
  unreadPrs: number;
  unreadIssues: number;
}

export function prKind(pr: PrFact): PrKind {
  return PR_KIND[classifyPr(pr)];
}

export function outsider(pr: Pick<PrFact, "association">): boolean {
  return pr.association !== undefined && !INSIDERS.has(pr.association);
}

export function issueKind(issue: IssueFact): IssueKind {
  if (issue.bot || issue.labels.some((l) => AUTOMATION_LABELS.includes(l))) return "automation";
  const labels = issue.labels.map((l) => l.toLowerCase());
  if (labels.some((l) => l === "bug" || l.startsWith("bug"))) return "bug";
  if (labels.some((l) => l === "enhancement" || l === "feature" || l.startsWith("feat")))
    return "enhancement";
  return "other";
}

function workRow(repo: string, name: string, fact: RepoFact | undefined): WorkRow {
  const prs: WorkRow["prs"] = { people: [], bots: [], pipeline: [] };
  const issues: WorkRow["issues"] = { bug: [], enhancement: [], other: [], automation: [] };
  for (const pr of fact?.prs ?? []) prs[prKind(pr)].push(pr);
  for (const issue of fact?.issues ?? []) issues[issueKind(issue)].push(issue);
  const oldest = prs.people
    .filter((p) => !p.draft)
    .reduce<PrFact | undefined>((a, p) => (!a || p.createdAt < a.createdAt ? p : a), undefined);
  return {
    repo,
    name,
    read: fact !== undefined,
    prs,
    contributors: prs.people.filter(outsider),
    issues,
    ...(oldest ? { oldest } : {}),
    unreadPrs: Math.max(0, (fact?.openPrs ?? 0) - (fact?.prs.length ?? 0)),
    unreadIssues: Math.max(0, (fact?.openIssues ?? 0) - (fact?.issues.length ?? 0)),
  };
}

export interface WorkModel {
  template: WorkRow;
  stack: WorkRow;
  forks: WorkRow[];
}

// Every open PR and issue on every repository, whether or not it sits on a line.
export function buildWork(repos: Record<string, RepoFact>, context: CoreContext): WorkModel {
  return {
    template: workRow(TEMPLATE_REPO, "osdu-spi", repos[TEMPLATE_REPO]),
    stack: workRow(context.stackRepo, context.stackRepo.split("/")[1] as string, repos[context.stackRepo]),
    forks: context.fleet.forks.map((f) => workRow(f.repo, f.id, repos[f.repo])),
  };
}
