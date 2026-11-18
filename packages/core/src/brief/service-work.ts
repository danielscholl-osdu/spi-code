// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceHome } from "@spi-code/contracts";
import type { ServiceIssue, ServicePull, ServiceWork } from "@spi-code/contracts";
import type { Facts, IssueFact, PrFact } from "../facts.js";
import type { Model } from "../model/index.js";
import { plainText } from "../readings/index.js";
import type { SweepReads } from "../sweep/index.js";
import { syncCompanions } from "./repo-today.js";
import { checksOf } from "./service-work-checks.js";

const time = (at?: string) => at && Number.isFinite(Date.parse(at)) ? at : undefined;
const baseName = (base: string) => base === "fork_upstream" ? "the upstream branch"
  : base === "fork_integration" ? "the integration branch" : base;

function identity(row: Pick<PrFact, "number" | "url" | "title" | "author" | "createdAt">) {
  const createdAt = time(row.createdAt);
  return { number: row.number, url: row.url, title: plainText(row.title),
    ...(row.author ? { author: row.author } : {}), ...(createdAt ? { createdAt } : {}) };
}

function gateOf(pr: PrFact, integration: boolean): string | undefined {
  if (pr.draft) return "Draft";
  if (pr.mergeState === "DIRTY") return "Merge conflicts";
  if (pr.mergeState === "BEHIND") return integration ? "Update branch, then approve" : "Update branch";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
  if (pr.reviewDecision === "APPROVED") return "Approved";
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    const reviews = pr.reviewers;
    return reviews && !reviews.cut && !reviews.requested.length && !reviews.latest.length
      ? "No reviewer"
      : "Review required";
  }
  return undefined;
}

function issueRow(issue: IssueFact & { closedAt?: string }, state: ServiceIssue["state"]): ServiceIssue {
  const closedAt = time(issue.closedAt);
  return { ...identity(issue), labels: issue.labels, state, ...(closedAt ? { closedAt } : {}),
    ...(issue.halt ? { halt: plainText(issue.halt) } : {}) };
}

export function serviceWork(
  model: Model,
  facts: Facts,
  reads: SweepReads,
  homes: ReadonlyMap<string, ServiceHome>,
): Map<string, ServiceWork> {
  const tracking = syncCompanions(model);
  return new Map(model.lines.map((line) => {
    const { id, repo } = line.fork;
    const github = facts.github.data?.repos[repo];
    const failed = !!facts.github.error || reads.github?.some(
      (read) => (read.source === repo || read.object === repo) && read.failure !== undefined,
    );
    const home = homes.get(id);
    const open = !failed && github && !github.prsUnread ? line.prs : undefined;
    const past = !failed ? line.past : undefined;
    const issues = !failed && github && !github.issuesUnread ? github.issues : undefined;
    const closed = !failed ? github?.closedIssues : undefined;
    const pulls: ServicePull[] = [
      ...(open ?? []).map(({ pr }): ServicePull => {
        const station = home?.stations.find(({ pr: pull }) => pr.url === pull?.url);
        const waiting = home?.overview.find((row) => row.section === "waiting" && row.links[0]?.url === pr.url);
        const reviews = pr.reviewers;
        const reviewers = reviews ? [
          ...new Set([...reviews.requested, ...reviews.latest.map(({ login }) => login)]),
        ] : undefined;
        const gate = gateOf(pr, station?.id === "integration") ?? waiting?.headline;
        const carries = station?.line;
        return { ...identity(pr), state: "open", head: pr.head, base: baseName(pr.base),
          draft: pr.draft, labels: pr.labels, checks: checksOf(pr.checks),
          ...(gate ? { gate } : {}), ...(waiting ? { waiting: true } : {}),
          ...(carries ? { carries } : {}), ...(reviewers ? { reviewers } : {}),
          ...(reviews?.cut ? { reviewersCut: true } : {}) };
      }),
      ...(past ?? []).filter((pr) => !open?.some(({ pr: current }) => pr.number === current.number))
        .map((pr): ServicePull => {
          const finishedAt = time(pr.mergedAt ?? pr.closedAt);
          return { ...identity(pr), state: pr.mergedAt ? "merged" : "closed", head: pr.head,
            base: baseName(pr.base), ...(finishedAt ? { finishedAt } : {}) };
        }),
    ];
    const byUrl = new Map(pulls.map((pr) => [pr.url, pr]));
    const issueRows = (issues ?? []).map((issue) => {
      const row = issueRow(issue, "open");
      const pr = byUrl.get(tracking.get(row.url) ?? "");
      if (pr) {
        pr.companion = { number: row.number, url: row.url };
        row.tracks = { number: pr.number, url: pr.url };
      }
      return row;
    });
    const issuesPartial = issues !== undefined && (github?.openIssues ?? issues.length) > issues.length;
    return [id, {
      pulls: {
        count: open ? (github?.openPrs ?? open.length) : null,
        partial: !!open && (github?.openPrs ?? open.length) > open.length,
        pastRead: past !== undefined,
        rows: pulls,
      },
      issues: {
        count: issues && !issuesPartial ? issueRows.filter(({ tracks }) => !tracks).length : null,
        partial: issuesPartial,
        closedRead: closed !== undefined,
        rows: [...issueRows, ...(closed ?? []).filter((issue) => !issues?.some(({ number }) => number === issue.number))
          .map((issue) => issueRow(issue, "closed"))],
      },
    }];
  }));
}
