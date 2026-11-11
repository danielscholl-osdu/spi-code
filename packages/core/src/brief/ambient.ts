// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReadRecord } from "../evidence/index.js";
import { failedChecks, prVerdict } from "../model/checks.js";
import type { Model } from "../model/index.js";
import type { LinePr } from "../model/lines.js";
import type { QueueItem } from "../model/queue.js";
import type { SweepReads } from "../sweep/sweeper.js";
import { age, names } from "../util.js";
import type { FocusItem, Tone } from "./index.js";
import type { TieredItem } from "./themes.js";

type Item = Pick<FocusItem, "id" | "ids" | "cls" | "scope" | "title" | "sub" | "next"> &
  Pick<TieredItem, "attention" | "origin">;
type Card = { itemIds: readonly string[] };

interface AmbientLine {
  id: string;
  itemIds: string[];
  count: number;
  service?: string;
  station?: "sync" | "cascade" | "main" | "release";
  pr?: { number: number; url?: string; inspect?: string };
  state?: { text: string; tone: Tone };
  followUp?: string;
  age?: string;
  next?: string[];
  origin: "system" | "upstream";
  text: string;
}
interface AmbientRun {
  items: number;
  text: string;
  lines: AmbientLine[];
}
interface Ambient {
  failing: AmbientRun;
  inProgress: AmbientRun;
}
interface CanWait {
  chips: { text: string; count?: number; service?: string }[];
  items: { id: string; itemIds: string[]; service?: string; text: string; why: string }[];
}

function queueOf(model: Model, item: Item): QueueItem[] {
  const ids = new Set([item.id, ...item.ids]);
  return model.queue.items.filter((queued) => ids.has(queued.id));
}

function prOf(model: Model, queued: readonly QueueItem[]): LinePr | undefined {
  const urls = new Set(queued.flatMap((item) => [item.url, ...item.cause
    .filter((fact) => fact.label === "PR").map((fact) => fact.url)]));
  return model.lines.flatMap((line) => line.prs).find((pr) => urls.has(pr.pr.url));
}

function jobsOf(queued: readonly QueueItem[]): Set<string> {
  return new Set(queued.flatMap((item) => [item.url, ...item.cause.map((fact) => fact.url),
    ...item.effects.map((effect) => effect.url)])
    .flatMap((url) => {
      const job = url?.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+/)?.[0];
      return job ? [job] : [];
    }));
}

function rowOf(model: Model, members: readonly Item[], now: Date): AmbientLine {
  const queued = members.flatMap((item) => queueOf(model, item));
  const primary = members.find((item) => prOf(model, queueOf(model, item))) ?? members[0];
  if (!primary) throw new Error("An Ambient line needs an item");
  const source = queueOf(model, primary);
  const pr = prOf(model, source);
  const kind = source[0]?.kind;
  const station = pr?.prClass === "sync" ? "sync" : pr?.prClass === "cascade" ? "cascade"
    : pr?.prClass === "release" ? "release" : kind === "main" ? "main" : undefined;
  const failed = pr ? failedChecks(pr.pr)[0] : undefined;
  const failure = failed && pr?.failures.find((failure) =>
    failure.check === failed.name && failure.url === failed.url);
  const check = failure?.step ?? failed?.name;
  const elapsed = age(failure?.at ?? failed?.completedAt ?? source[0]?.since, now);
  const lane = queued.some((item) => item.kind === "lanes");
  const followUp = lane ? "Re-run once the lanes drain." : undefined;
  const service = model.lines.find((line) => (pr !== undefined && line.prs.includes(pr)))?.fork.id ??
    model.lines.find((line) => line.fork.id === primary.scope)?.fork.id;
  const text = pr && failed
    ? `${service} ${pr.prClass === "cascade" ? "release/upstream" : pr.prClass} PR #${pr.pr.number}: ${check} failed${elapsed ? ` ${elapsed} ago` : ""}.${followUp ? ` ${followUp}` : ""}`
    : members.map((item) => `${item.title}. ${item.sub}${item.sub ? ". " : ""}${item.next}`).join(" ");
  const base: AmbientLine = {
    id: `ambient:${members[0]?.id}`,
    itemIds: members.map((item) => item.id),
    count: members.length,
    origin: primary.origin ?? "system",
    text,
    ...(service ? { service } : {}),
    ...(station ? { station } : {}),
    ...(pr ? { pr: { number: pr.pr.number, url: pr.pr.url, inspect: primary.id } } : {}),
    ...(elapsed ? { age: elapsed } : {}),
    ...(followUp ? { followUp } : {}),
  };
  if (primary.cls === "ROLLOUT") {
    const next = model.rollout?.mergeNext.map((fork) => fork.service) ?? [];
    return { ...base, next, text: next.length > 0
      ? `Template rollout: merge ${names(next)}.` : "Template rollout: no merges ready." };
  }
  if (failed) base.state = { text: check ?? failed.name, tone: "bad" };
  else if (primary.cls === "GATE") {
    const verdict = pr ? prVerdict(pr.pr) : "none";
    base.state = verdict === "none" ? { text: "not read yet", tone: "neutral" }
      : verdict === "pending" ? { text: "checks", tone: "neutral" }
      : { text: station === "cascade" ? "approval" : "review", tone: "warn" };
  }
  return base;
}

export function ambientOf(input: {
  model: Model;
  items: readonly Item[];
  cards: readonly Card[];
  now: Date;
}): Ambient {
  const onCards = new Set(input.cards.flatMap((card) => card.itemIds));
  const items = input.items.filter((item) => item.attention === "ambient" && !onCards.has(item.id));
  const groups: { members: Item[]; jobs: Set<string> }[] = [];
  for (const item of items) {
    const jobs = jobsOf(queueOf(input.model, item));
    const matching = groups.filter((group) => [...jobs].some((job) => group.jobs.has(job)));
    const group = matching[0];
    if (!group) groups.push({ members: [item], jobs });
    else {
      group.members.push(item);
      for (const job of jobs) group.jobs.add(job);
      for (const other of matching.slice(1)) {
        group.members.push(...other.members);
        for (const job of other.jobs) group.jobs.add(job);
        groups.splice(groups.indexOf(other), 1);
      }
      group.members.sort((a, b) => items.indexOf(a) - items.indexOf(b));
    }
  }
  const failing: AmbientLine[] = [];
  const inProgress: AmbientLine[] = [];
  for (const group of groups) {
    const bad = group.members.some((item) => {
      const pr = prOf(input.model, queueOf(input.model, item));
      return item.cls === "TEST" || (item.cls === "GATE" && pr !== undefined &&
        prVerdict(pr.pr) === "red");
    });
    (bad ? failing : inProgress).push(rowOf(input.model, group.members, input.now));
  }
  const run = (lines: AmbientLine[]): AmbientRun => {
    const items = lines.reduce((sum, line) => sum + line.count, 0);
    return { items, text: `${items} in ${lines.length}`, lines };
  };
  return { failing: run(failing), inProgress: run(inProgress) };
}

function readService(reads: readonly ReadRecord[] | undefined, area: string, repo: string,
  upstream: string): boolean {
  const records = area === "template" ? reads ?? [] : reads?.filter((read) =>
    read.object === repo || read.source === repo || read.source === upstream ||
    (read.source === area && read.object === area)) ?? [];
  return records.length > 0 && records.every((read) =>
    read.failure === undefined && read.completeness.kind === "complete");
}

export function canWaitOf(input: {
  model: Model;
  items: readonly Item[];
  places: readonly Card[];
  cards: readonly Card[];
  reads: SweepReads;
}): CanWait {
  const counted = new Set([
    ...input.places.flatMap((place) => place.itemIds),
    ...input.cards.flatMap((card) => card.itemIds),
  ]);
  const background = input.items.filter((item) => item.attention === "background" &&
    !counted.has(item.id) && !item.ids.some((id) => counted.has(id)));
  const result: CanWait = {
    chips: background.map((item) => ({ text: item.title, count: 1 })),
    items: background.map((item) => ({ id: item.id, itemIds: [item.id], text: item.title,
      why: `No action is due today. ${item.next}` })),
  };
  for (const line of input.model.lines) {
    if (!line.repoRead || !line.runsRead || line.upstream?.lag !== 0 ||
      line.syncRun?.status !== "completed" || line.syncRun.conclusion !== "success" ||
      line.template.behind !== 0 || line.template.awaitingRun || line.labelsIssue ||
      line.templateSyncing || line.templateDispatched ||
      !["sync", "cascade", "main", "release"].every((id) =>
        line.stations.some((station) => station.id === id && station.state === "idle")) ||
      line.templatePr || line.halt || line.conflicts.length > 0 ||
      !(["github", "runs", "upstream", "template"] as const).every((area) =>
        readService(input.reads[area], area, line.fork.repo, line.fork.upstream))) continue;
    const service = line.fork.id;
    const why = "no sync, gate or release waiting";
    result.chips.push({ text: service, service });
    result.items.push({ id: `can-wait:${service}`, service, itemIds: [], text: `${service}: ${why}`, why });
  }
  return result;
}
