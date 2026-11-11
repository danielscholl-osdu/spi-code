// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AttentionTier } from "../attention.js";
import { TEMPLATE_REPO } from "../config.js";
import type { ReadRecord } from "../evidence/index.js";
import type { Model } from "../model/index.js";
import { templatePrState } from "../model/queue.js";
import { plural, short } from "../util.js";
import {
  clockOf,
  NOT_READ,
  type PlaceReading,
  placeReading,
  type ReadingGroup,
  type ReadingItem,
} from "./index.js";

export interface EngineeringItem extends ReadingItem {
  attention?: AttentionTier;
  owned?: boolean;
}

export interface EngineeringReadingInput<T extends EngineeringItem> {
  model: Model;
  items: readonly T[];
  reads: Partial<Record<"template" | "github" | "runs", readonly ReadRecord[]>>;
}

export interface EngineeringReading<T extends EngineeringItem> extends PlaceReading<T> {
  verifiedTemplate?: {
    verified: number;
    total: number;
    unread: number;
    target: string;
  };
}

function qualifierFor(
  model: Model,
  reads: EngineeringReadingInput<EngineeringItem>["reads"],
): string | undefined {
  const repos = new Set([TEMPLATE_REPO, ...model.template.rows.map((row) => row.repo)]);
  const parts = ([
    ["template", "GitHub template reads"],
    ["github", "GitHub repository reads"],
    ["runs", "GitHub Actions reads"],
  ] as const).flatMap(([area, source]) => {
    const contributing = (reads[area] ?? []).filter(
      (read) =>
        repos.has(read.source) ||
        repos.has(read.object) ||
        (read.source === area && read.object === area),
    );
    const failed = contributing.some((read) => read.failure !== undefined);
    const cut = contributing.some((read) => read.completeness.kind === "cut");
    return failed || cut
      ? [`${source} ${failed && cut ? "failed or were incomplete" : failed ? "failed" : "were incomplete"}`]
      : [];
  });
  return parts.length > 0
    ? `${parts.join("; ")}, so adoption or template changes could be missing.`
    : undefined;
}

function groupsFor<T extends EngineeringItem>(items: readonly T[]): ReadingGroup<T>[] {
  const tier = (item: T) =>
    item.due ? 0 : item.owned ? 1 : item.attention === "interrupt" ? 2 : item.attention === "surface" ? 3 : 4;
  const ordered = [...items].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      (a.due && b.due ? Date.parse(a.due.at) - Date.parse(b.due.at) : 0),
  );
  const groups = new Map<string, T[]>();
  for (const item of ordered) {
    const group = item.due
      ? `Before ${clockOf(item.due.at)}`
      : item.owned
        ? "Owned"
        : item.attention === "interrupt"
          ? "Needs a decision"
          : item.attention === "surface"
            ? "New"
            : "No rush";
    const members = groups.get(group) ?? [];
    members.push(item);
    groups.set(group, members);
  }
  return [...groups].map(([group, members]) => ({ group, items: members }));
}

export function engineeringReading<T extends EngineeringItem>(
  input: EngineeringReadingInput<T>,
): EngineeringReading<T> {
  const { model, items, reads } = input;
  const { template, rollout } = model;
  const total = template.rows.length;
  const target = rollout?.target.sha ?? template.head?.sha;
  const { verified } = template;
  const unread = template.rows.filter((row) => row.behind === undefined).length;
  const positionsRead = !!target && total > 0 && unread < total;
  const prsUnread = model.lines.filter((line) => !line.repoRead).length;
  const prsRead = total > 0 && prsUnread < total;
  const open = template.rows.filter((row) => row.pr).length;
  const state = rollout
    ? { ready: "Ready", rolling: "In progress", stopped: "Stopped", done: "Verified" }[rollout.phase]
    : verified === total
      ? "Verified"
      : "Awaiting verification";
  const headline = !positionsRead
    ? `Engineering system ${NOT_READ}.`
    : rollout?.phase === "stopped"
      ? "Template rollout stopped; a fork's main validation failed."
      : verified === total
        ? "Every fork is verified on the target template."
        : rollout?.phase === "ready"
          ? "Template changes are ready to roll out."
          : rollout
            ? "Template rollout is in progress; verification is still pending."
            : "Template adoption is waiting for verification.";
  const qualifier = qualifierFor(model, reads);
  const note = (n: number) => n > 0 ? ` · ${n} ${NOT_READ}` : "";
  const own = items.filter(
    (item) =>
      item.scope === "osdu-spi" ||
      item.scope === TEMPLATE_REPO ||
      item.id.startsWith("template-pr:") ||
      item.id === "rollout" ||
      (item.id === "template-set" && !items.some((candidate) => candidate.id === "rollout")),
  );
  const otherPrs = template.prs.filter(
    ({ pr }) => !own.some((item) => item.ids.includes(`template-pr:${pr.number}`)),
  );
  const extra = otherPrs.length > 0
    ? `On osdu-spi: ${otherPrs.map(({ pr, failures }) =>
        `PR #${pr.number} ${pr.title} · ${pr.draft ? "draft" : templatePrState(pr, failures)}`,
      ).join("; ")}.`
    : undefined;
  const reading = placeReading({
    membership: true,
    headline,
    ...(qualifier ? { qualifier } : {}),
    tiles: [
      {
        label: "Engineering system",
        value: positionsRead ? `${verified} of ${total}` : NOT_READ,
        counts: target ? `forks on ${short(target)}${note(unread)}` : "forks on the target template",
      },
      {
        label: "Template PRs",
        value: prsRead ? String(open) : NOT_READ,
        counts: `open across the forks${prsRead ? note(prsUnread) : ""}`,
      },
      {
        label: "Rollout",
        value: positionsRead ? state : NOT_READ,
        counts: positionsRead
          ? `${plural(total - verified, "fork")} left to verify`
          : "forks awaiting verification",
      },
    ],
    groups: groupsFor(own),
    ...(extra ? { extra } : {}),
  });
  return {
    ...reading,
    ...(positionsRead ? { verifiedTemplate: { verified, total, unread, target } } : {}),
  };
}
