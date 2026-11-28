// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CoreContext } from "../context.js";
import type { Facts, IssueFact, PrFact } from "../facts.js";
import { workflowEvidence } from "../inspect/item-evidence.js";
import { groupUrl } from "../inspect/repo.js";
import type { Model } from "../model/index.js";
import type { ReleasePr } from "../model/queue.js";
import type { RepoRow } from "../model/repos.js";
import { stationSubstateOf } from "../model/substate.js";
import { needsHuman } from "../model/work.js";
import { releaseQueue } from "../readings/releases.js";
import type { SweepReads } from "../sweep/index.js";
import { stamp } from "../util.js";
import type { FocusItem, Tone } from "./index.js";
import { canWaitCauses, type CauseObject } from "./can-wait-causes.js";
import { type TodayLine, type TodayMember, todayInFlight, todaySources } from "./lines.js";
import { pullsComplete, syncCompanions } from "./repo-today.js";
import { doorsOf } from "./service-home.js";
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
  what?: string;
  fork?: string;
  link?: TodayMember["primary"];
  age?: string;
  notRead?: string[];
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
  reads?: SweepReads;
};

type Repository = { repo: string; name: string; group: CauseObject["group"] };

function sourceObject(repository: Repository, object: PrFact | IssueFact, kind: "PR" | "Issue") {
  const { repo, name: fork, group } = repository;
  return {
    id: object.url, repo, fork, group, title: object.title, url: object.url, since: object.createdAt,
    label: `${kind} #${object.number}`, name: `${fork} #${object.number}`,
  };
}

function dependencyObject(repository: Repository, pr: PrFact, pkg?: string) {
  const ecosystem = /^dependabot\/([^/]+)\//i.exec(pr.head)?.[1]?.toLowerCase();
  return { ...sourceObject(repository, pr, "PR"),
    ...(ecosystem && pkg ? { package: { ecosystem, name: pkg } } : {}) };
}

type PrDoor = "release" | "dependabot" | "other";
type PrObject = ReturnType<typeof dependencyObject> & Pick<CauseObject, "notRead">;

function partitionPulls(input: Input, repos: ReadonlyMap<string, RepoRow>, sources: ReturnType<typeof todaySources>) {
  const { model, facts, reads, context } = input;
  const known = new Map<string, boolean>();
  const objects: Record<PrDoor, PrObject[]> = { release: [], dependabot: [], other: [] };
  const remainders = { release: { blocked: 0, waiting: 0 }, dependabot: { blocked: 0, waiting: 0 } };
  for (const line of model.lines) {
    const repo = line.fork.repo;
    const repository = repos.get(repo);
    if (repository?.group !== "fork") continue;
    const complete = pullsComplete(repo, facts, reads);
    known.set(repo, complete);
    const byUrl = new Map(line.prs.map(({ pr }) => [pr.url, pr]));
    const packages = new Map(repository.dependabot.map(({ pr, package: pkg }) => [pr.url, pkg]));
    for (const door of doorsOf(line, [], complete)) {
      const kind = door.id;
      if (kind === "template") continue;
      for (const { url } of door.prs) {
        const section = sources.get(url);
        if (section) {
          if (complete && kind !== "other") remainders[kind][section]++;
          continue;
        }
        const pr = byUrl.get(url);
        if (pr) objects[kind].push({
          ...dependencyObject(repository, pr, kind === "dependabot" ? packages.get(url) : undefined),
          ...(!complete ? { notRead: true } : {}),
        });
      }
    }
  }
  const releases = new Map(releaseQueue(facts, context).all.map((entry) => [entry.pr.url, entry]));
  for (const { repo, name, pr } of releases.values()) {
    const repository = repos.get(repo) ?? { repo, name, group: "unknown" };
    if (repository.group !== "fork" && !sources.has(pr.url))
      objects.release.push(sourceObject(repository, pr, "PR"));
  }
  for (const repository of repos.values()) {
    if (repository.group === "fork") continue;
    const available = (pr: PrFact) => !sources.has(pr.url) && !releases.has(pr.url);
    objects.dependabot.push(...repository.dependabot.filter(({ pr }) => available(pr))
      .map(({ pr, package: pkg }) => dependencyObject(repository, pr, pkg)));
    objects.other.push(...repository.changes.filter(({ pr }) => available(pr))
      .map(({ pr }) => sourceObject(repository, pr, "PR")));
  }
  return { objects, known, remainders, releases };
}

/** The supplied situation lines own membership, including folded moves, their sources and the sync engine companions of those sources. */
function canWait(input: Input) {
  const { model, facts, items, lines, now } = input;
  const ids = new Set(lines.flatMap((line) => line.members.flatMap((m) => [m.id, ...m.ids])));
  const sources = todaySources(model, items, lines);
  for (const [issue, pr] of syncCompanions(model)) {
    const section = sources.get(pr);
    if (section) sources.set(issue, section);
  }
  const repos = model.repositories.rows;
  const { objects, known, remainders, releases } = partitionPulls(
    input, new Map(repos.map((repo) => [repo.repo, repo])), sources,
  );
  const releaseRefs = (matches: (release: ReleasePr) => boolean) =>
    objects.release.filter(({ url }) => {
      const release = releases.get(url);
      return release !== undefined && matches(release);
    });
  const unreadPulls = repos.filter((r) => r.group === "fork" && known.get(r.repo) !== true);
  const issues = repos.flatMap((r) => Object.values(r.issues).flat().filter((i) => needsHuman(i) && !sources.has(i.url))
    .map((i) => sourceObject(r, i, "Issue")));
  const alerts = repos.flatMap((r) => r.alerts.filter((a) => a.reach === "shipped" &&
    !ids.has(`alert:${r.repo}:${a.id}`) && !sources.has(groupUrl(r, a)))
    .map((a) => ({
      id: `alert:${r.repo}:${a.id}`, repo: r.repo, fork: r.name, group: r.group, title: a.name,
      since: a.since, label: a.source === "dependabot" ? "Dependabot" : "Code scanning",
      rule: a.source === "code" && a.rule ? `${a.tool ?? ""}:${a.rule}` : `dependabot:${a.name}`,
      name: `${r.name}: ${a.name}`, url: groupUrl(r, a),
      count: (a.counts.critical ?? 0) + (a.counts.high ?? 0), owner: a.owner, source: a.source,
    }))).filter((a) => a.count > 0);
  const ownAlerts = alerts.filter((a) => a.owner !== "upstream");
  const [release, repositories, security]: [TodayPile, TodayPile, TodayPile] = [
    { id: "releases", label: "Release PRs", place: "releases", counts: [
      count("open", "open", objects.release),
      count("ready", "ready to merge", releaseRefs((r) => r.ready), "ok"),
      count("review", "waiting for review", releaseRefs((r) => !r.ready && r.pr.reviewDecision === "REVIEW_REQUIRED")),
      count("failed", "failing", releaseRefs((r) => r.real.length > 0), "bad"),
    ], notRead: repos.filter((r) => !facts.github.data?.repos[r.repo] || known.get(r.repo) === false)
      .map((r) => `${r.name}: release PRs`) },
    { id: "repositories", label: "Repositories", place: "engineering", counts: [
      count("issues", "human-required issues", issues), count("changes", "chore PRs", objects.other),
      count("dependabot", "Dependabot bumps", objects.dependabot),
    ], notRead: repos.flatMap((r) => [
      ...(!facts.github.data?.repos[r.repo] ? [`${r.name}: issues and PRs`] : []),
      ...(r.unreadIssues ? [`${r.name}: ${r.unreadIssues} issues`] : []),
      ...(r.unreadPrs ? [`${r.name}: ${r.unreadPrs} PRs`] : []),
    ]) },
    { id: "security", label: "Security", place: "security", counts: [
      count("vulnerabilities", "critical or high", ownAlerts.filter((a) => a.source === "dependabot")),
      count("code-scanning", "code scanning", ownAlerts.filter((a) => a.source === "code")),
    ], notRead: repos.flatMap((r) => [
      ...(r.dependabotAlerts === undefined ? [`${r.name}: vulnerabilities`] : []),
      ...(r.codeAlerts === undefined ? [`${r.name}: code scanning`] : []),
    ]) },
  ];
  return {
    canWait: [release, repositories, security],
    causes: canWaitCauses(
      { ...objects, issue: issues, alert: alerts },
      { release: release.notRead, dependabot: unreadPulls.map(({ name }) => name),
        other: unreadPulls.map(({ name }) => name),
        issue: repositories.notRead, alert: security.notRead },
      remainders,
      now,
    ),
  };
}

function moving(input: Input): TodayMoving[] {
  const { model, facts, now, context } = input;
  const rows: TodayMoving[] = todayInFlight(model, input.items, now, context).map(
    ({ line, member }) => ({
      id: member.id,
      label: member.fork,
      place: member.home === "engineering" ? "engineering" : "line",
      time: "Now",
      count: 1,
      names: [member.fork],
      what: line.headline,
      fork: member.fork,
      ...(member.primary ? { link: member.primary } : {}),
      ...(member.age ? { age: member.age } : {}),
      notRead: member.evidence.notRead,
    }),
  );
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
  const inFlight = rows.filter((row) => !row.at);
  const scheduled = rows.filter((row) => row.at)
    .sort((a, b) => Date.parse(a.at as string) - Date.parse(b.at as string))
    .slice(0, 3);
  return [...inFlight, ...scheduled];
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
            const label = outcome === "occupied" && matches.length === 1 ? "new PR" : text;
            return matches.length ? [count(outcome === "broken" ? "failed" : outcome, label,
              matches.map((e) => ({ name: e.line.fork.id, url: "" })), tone)] : [];
          }),
          notRead: evidence.flatMap((e) => e.evidence.notRead),
        };
      }),
  };
}

export function todaySummary(input: Input) {
  return { ...canWait(input), moving: moving(input), history: todayHistory(input.model, input.facts, input.since, input.now) };
}
