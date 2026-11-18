// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts.js";
import { classifyPr } from "../model/attribution.js";
import type { Model } from "../model/index.js";
import { needsHuman } from "../model/work.js";
import type { SweepReads } from "../sweep/index.js";
import type { FocusItem } from "./index.js";
import type { TodayLine } from "./lines.js";

export interface RepoToday {
  id: string;
  rel: "source" | "companion";
}

const READY_FOR_REVIEW = /Upstream Sync Ready for Review/;

export function pullsComplete(repo: string, facts: Pick<Facts, "github">, reads?: SweepReads): boolean {
  const github = facts.github.data?.repos[repo];
  return !!github && !github.prsUnread && !facts.github.error &&
    (github.openPrs === undefined || github.openPrs === github.prs.length) &&
    !reads?.github?.some(({ source, object, failure }) =>
      (source === repo || object === repo) && failure !== undefined);
}

/**
 * Each sync engine tracking issue by URL, mapped to the sync PR it was opened for: a fully read
 * repository with one open Ready for Review issue opened during a unique sync PR's lifetime.
 */
export function syncCompanions(model: Model): Map<string, string> {
  const companions = new Map<string, string>();
  for (const row of [model.work.template, model.work.stack, ...model.work.forks]) {
    if (!row.read || row.unreadPrs > 0 || row.unreadIssues > 0) continue;
    const syncs = Object.values(row.prs)
      .flat()
      .filter((pr) => classifyPr(pr) === "sync" && pr.base === "fork_upstream");
    const issues = Object.values(row.issues)
      .flat()
      .filter(
        (issue) =>
          READY_FOR_REVIEW.test(issue.title) &&
          issue.labels.includes("upstream-sync") &&
          needsHuman(issue),
      );
    const [issue] = issues;
    if (syncs.length > 1 || issues.length !== 1 || !issue) continue;
    const opened = Date.parse(issue.createdAt);
    if (!Number.isFinite(opened)) continue;
    const past = model.lines.find(({ fork }) => fork.repo === row.repo)?.past ?? [];
    const merged = past.filter((pr) =>
      pr.base === "fork_upstream" && classifyPr(pr) === "sync" &&
      Date.parse(pr.createdAt) <= opened && opened <= Date.parse(pr.mergedAt ?? ""),
    );
    const candidates = [...syncs.filter((pr) => Date.parse(pr.createdAt) <= opened), ...merged];
    const [pr] = candidates;
    if (candidates.length === 1 && pr) companions.set(issue.url, pr.url);
  }
  return companions;
}

/**
 * The Today member each repository line URL stands for: a member's own item acts on it or names
 * it as evidence, or it is the companion issue of such a sync PR. A URL two members claim is left out.
 */
export function repositoryToday(
  model: Model,
  items: readonly FocusItem[],
  lines: readonly TodayLine[],
): Map<string, RepoToday> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const claims = new Map<string, Set<string>>();
  for (const member of lines.flatMap((line) => line.members)) {
    const blocker = new Set(member.blockedBy ? (byId.get(member.blockedBy)?.ids ?? [member.blockedBy]) : []);
    const own = member.ids.filter((id) => !blocker.has(id)).flatMap((id) => byId.get(id) ?? []);
    const urls = [member.subject, ...own.flatMap((item) => [item.subject, ...item.evidence.map((e) => e.url)])];
    for (const url of urls) {
      if (!url) continue;
      const members = claims.get(url) ?? new Set();
      members.add(member.id);
      claims.set(url, members);
    }
  }
  const today = new Map<string, RepoToday>();
  for (const [url, members] of claims) {
    const [id] = members;
    if (members.size === 1 && id) today.set(url, { id, rel: "source" });
  }
  for (const [issue, pr] of syncCompanions(model)) {
    const source = today.get(pr);
    if (source && !claims.has(issue)) today.set(issue, { id: source.id, rel: "companion" });
  }
  return today;
}
