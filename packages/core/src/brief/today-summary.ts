// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CoreContext } from "../context.js";
import type { Facts } from "../facts.js";
import { workflowEvidence } from "../inspect/item-evidence.js";
import { groupUrl } from "../inspect/repo.js";
import type { Model } from "../model/index.js";
import { stationSubstateOf } from "../model/substate.js";
import { needsHuman } from "../model/work.js";
import { releaseQueue } from "../readings/releases.js";
import { stamp } from "../util.js";
import type { FocusItem, Tone } from "./index.js";
import type { TodayLine } from "./lines.js";
import type { Since } from "./since.js";

export interface SummaryCount {
  kind: string;
  label: string;
  count: number;
  tone: Tone;
  names: string[];
  urls: string[];
}
export interface TodayPile {
  id: string;
  label: string;
  place: "releases" | "engineering" | "security";
  counts: SummaryCount[];
  notRead: string[];
}
export interface TodayMoving {
  id: string;
  label: string;
  place: "line" | "engineering" | "upstream" | "environment";
  time: string;
  at?: string;
  count: number;
  names: string[];
}
export interface TodayHistory {
  basis: Since["basis"];
  from: string;
  asOf?: string;
  rows: {
    workflow: "sync" | "template";
    label: string;
    place: "line" | "engineering";
    counts: SummaryCount[];
    notRead: string[];
  }[];
}

type ObjectRef = { name: string; url: string; count?: number };
function count(kind: string, label: string, objects: ObjectRef[], tone: Tone = "neutral"): SummaryCount {
  return { kind, label, count: objects.reduce((n, o) => n + (o.count ?? 1), 0), tone,
    names: objects.map((o) => o.name), urls: objects.map((o) => o.url).filter(Boolean) };
}

type Input = {
  model: Model;
  facts: Facts;
  items: readonly FocusItem[];
  lines: readonly TodayLine[];
  since: Since | undefined;
  now: Date;
  context: CoreContext;
};

/** The supplied situation lines own membership, including folded moves and their sources. */
function canWait(input: Input): TodayPile[] {
  const { model, facts, context, items, lines } = input;
  const members = lines.flatMap((l) => l.members);
  const ids = new Set(members.flatMap((m) => [m.id, ...m.ids, ...(m.blockedBy ? [m.blockedBy] : [])]));
  const sources = new Set([
    ...members.flatMap((m) => [m.subject, m.primary?.url]),
    ...items.filter((i) => ids.has(i.id) || i.ids.some((id) => ids.has(id)))
      .flatMap((i) => [i.subject, ...i.evidence.map((e) => e.url)]),
    ...model.queue.items.filter((q) => ids.has(q.id)).flatMap((q) =>
      [q.url, ...q.cause.map((f) => f.url), ...q.effects.map((e) => e.url)]),
  ]);
  const queue = releaseQueue(facts, context);
  const releases = queue.all.filter((r) => !sources.has(r.pr.url));
  const releaseRefs = (rows: typeof releases) => rows.map((r) => ({ name: `${r.name} #${r.pr.number}`, url: r.pr.url }));
  const repos = model.repositories.rows;
  const issues = repos.flatMap((r) => Object.values(r.issues).flat().filter((i) => needsHuman(i) && !sources.has(i.url))
    .map((i) => ({ name: `${r.name} #${i.number}`, url: i.url })));
  const changes = repos.flatMap((r) => r.changes.filter((p) => !sources.has(p.pr.url))
    .map((p) => ({ name: `${r.name} #${p.pr.number}`, url: p.pr.url })));
  const bumps = repos.flatMap((r) => r.dependabot.filter((p) => !sources.has(p.pr.url))
    .map((p) => ({ name: `${r.name} #${p.pr.number}`, url: p.pr.url })));
  const alerts = repos.flatMap((r) => r.alerts.filter((a) => a.owner !== "upstream" && a.reach === "shipped" &&
    !ids.has(`alert:${r.repo}:${a.id}`) && !sources.has(groupUrl(r, a)))
    .map((a) => ({ ...a, name: `${r.name}: ${a.name}`, url: groupUrl(r, a),
      count: (a.counts.critical ?? 0) + (a.counts.high ?? 0) }))).filter((a) => a.count > 0);
  return [
    { id: "releases", label: "Release PRs", place: "releases", counts: [
      count("open", "open", releaseRefs(releases)),
      count("ready", "ready to merge", releaseRefs(releases.filter((r) => r.ready)), "ok"),
      count("review", "waiting for review", releaseRefs(releases.filter((r) => !r.ready && r.pr.reviewDecision === "REVIEW_REQUIRED"))),
      count("failed", "failing", releaseRefs(releases.filter((r) => r.real.length > 0)), "bad"),
    ], notRead: facts.github.data ? [] : ["Release PRs"] },
    { id: "repositories", label: "Repositories", place: "engineering", counts: [
      count("issues", "human-required issues", issues), count("changes", "chore PRs", changes),
      count("dependabot", "Dependabot bumps", bumps),
    ], notRead: repos.flatMap((r) => [
      ...(r.unreadIssues ? [`${r.name}: ${r.unreadIssues} issues`] : []),
      ...(r.unreadPrs ? [`${r.name}: ${r.unreadPrs} PRs`] : []),
    ]) },
    { id: "security", label: "Security", place: "security", counts: [
      count("vulnerabilities", "critical or high", alerts.filter((a) => a.source === "dependabot")),
      count("code-scanning", "code scanning", alerts.filter((a) => a.source === "code")),
    ], notRead: repos.flatMap((r) => [
      ...(r.dependabotAlerts === undefined ? [`${r.name}: vulnerabilities`] : []),
      ...(r.codeAlerts === undefined ? [`${r.name}: code scanning`] : []),
    ]) },
  ];
}

function moving(input: Input): TodayMoving[] {
  const { model, facts, now, context } = input;
  const rows: TodayMoving[] = [];
  const lanes = model.lines.filter((line) => line.stations.some((station) => station.id === "lane" &&
    stationSubstateOf(station, line, facts) === "in-progress"));
  if (lanes.length) rows.push({ id: "lanes", label: "Lanes", place: "line", time: "Now", count: lanes.length,
    names: lanes.map((l) => l.fork.id) });
  const run = model.stack.inflight?.run;
  if (run) rows.push({ id: "environment", label: run.kind, place: "environment", time: "Now", count: 1, names: [run.kind] });
  const at = model.rollout?.schedule.template;
  if (at && Date.parse(at) > now.getTime()) rows.push({ id: "template", label: "Template sync", place: "engineering",
    time: stamp(at, now, context) ?? at, at, count: model.rollout?.schedule.templateOpens ?? 0,
    names: model.rollout?.forks.filter((f) => !f.onTarget && !f.pr).map((f) => f.service) ?? [] });
  const next = model.upstream.schedule.upstream;
  if (next && Date.parse(next) > now.getTime()) rows.push({ id: "sync", label: "Upstream sync", place: "upstream",
    time: stamp(next, now, context) ?? next, at: next, count: model.upstream.schedule.opens.length,
    names: [...model.upstream.schedule.opens] });
  return rows.sort((a, b) => (a.at ? Date.parse(a.at) : 0) - (b.at ? Date.parse(b.at) : 0)).slice(0, 3);
}

const OUTCOMES = Object.freeze([
  ["empty", "nothing new", "neutral"], ["occupied", "new PRs", "neutral"],
  ["done", "merged", "ok"], ["waiting", "waiting for approval", "warn"],
  ["broken", "failed", "bad"],
  ["not-read", "not read", "neutral"],
] as const);

/** Summarises the existing since window; unread histories retain the item's evidence vocabulary. */
export function todayHistory(model: Model, facts: Facts, since: Since | undefined, now: Date): TodayHistory {
  const from = since?.from ?? new Date(now.getTime() - 86_400_000).toISOString();
  const to = since?.asOf ?? model.sweptAt ?? now.toISOString();
  return { basis: since?.basis ?? "fallback", from, ...(since?.asOf ? { asOf: since.asOf } : {}),
    rows: ([ ["sync", "Sync Upstream", "line"], ["template", "Sync Template", "engineering"] ] as const)
      .map(([workflow, label, place]) => {
        const slots = since?.rows.find((r) => r.workflow === workflow)?.slots ?? [];
        const evidence = model.lines.map((line) => ({ line,
          evidence: workflowEvidence(model, facts, line.fork.id, workflow, from, to,
            slots.some((s) => s.service === line.fork.id && s.state !== "unknown")) }));
        const state = (entry: typeof evidence[number]) => entry.evidence.runsRead
          ? slots.find((s) => s.service === entry.line.fork.id)?.state ?? "unknown" : "not-read";
        return { workflow, label, place,
          counts: OUTCOMES.flatMap(([outcome, text, tone]) => {
            const matches = evidence.filter((e) => (state(e) === "unknown" ? "not-read" : state(e)) === outcome);
            return matches.length ? [count(outcome === "broken" ? "failed" : outcome, text,
              matches.map((e) => ({ name: e.line.fork.id, url: "" })), tone)] : [];
          }),
          notRead: evidence.flatMap((e) => e.evidence.notRead),
        };
      }),
  };
}

export function todaySummary(input: Input) {
  return { canWait: canWait(input), moving: moving(input), history: todayHistory(input.model, input.facts, input.since, input.now) };
}
