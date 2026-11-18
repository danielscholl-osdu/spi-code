// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceHome } from "@spi-code/contracts";
import type { ServiceIssue, ServicePull, ServiceWork } from "@spi-code/contracts";
import type { Facts, IssueFact, PrFact } from "../facts.js";
import type { Model } from "../model/index.js";
import { plainText } from "../readings/index.js";
import type { SweepReads } from "../sweep/index.js";
import { gateOf } from "./pr-gate.js";
import { syncCompanions } from "./repo-today.js";
import { readOf } from "./service-upstream.js";
import { checksOf } from "./service-work-checks.js";

const time = (at?: string) => at && Number.isFinite(Date.parse(at)) ? at : undefined;
const baseName = (base: string) => base === "fork_upstream" ? "the upstream branch"
  : base === "fork_integration" ? "the integration branch" : base;

function identity(row: Pick<PrFact, "number" | "url" | "title" | "author" | "createdAt">) {
  const createdAt = time(row.createdAt);
  return { number: row.number, url: row.url, title: plainText(row.title),
    ...(row.author ? { author: row.author } : {}), ...(createdAt ? { createdAt } : {}) };
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
    const read = readOf(facts.github, reads.github,
      (record) => record.source === repo || record.object === repo, !!github);
    const home = homes.get(id);
    const open = github && !github.prsUnread ? line.prs : undefined;
    const past = github ? line.past : undefined;
    const issues = github && !github.issuesUnread ? github.issues : undefined;
    const closedFailed = (reads.github ?? []).some((record) =>
      record.object === `${repo}@closed-issues` && record.failure !== undefined);
    const closed = closedFailed ? undefined : github?.closedIssues;
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
    const prsTotal = github?.openPrs ?? open?.length ?? 0;
    const prsPartial = !!open && prsTotal > open.length;
    return [id, {
      pulls: {
        count: open && (read.read || !prsPartial) ? prsTotal : null,
        partial: prsPartial,
        pastRead: past !== undefined,
        ...read,
        rows: pulls,
      },
      issues: {
        count: issues && !issuesPartial ? issueRows.filter(({ tracks }) => !tracks).length : null,
        partial: issuesPartial,
        closedRead: closed !== undefined,
        ...read,
        rows: [...issueRows, ...(closed ?? []).filter((issue) => !issues?.some(({ number }) => number === issue.number))
          .map((issue) => issueRow(issue, "closed"))],
      },
    }];
  }));
}
