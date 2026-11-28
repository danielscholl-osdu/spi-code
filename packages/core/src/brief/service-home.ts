// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceHome, ServiceHomeDoor, ServiceHomeRow, ServiceHomeStation } from "@spi-code/contracts";
import { when } from "@spi-code/contracts";
import type { AreaName, Facts, IssueFact, PastPrFact, PrFact } from "../facts.js";
import { groupUrl } from "../inspect/repo.js";
import { cascadeMonitor } from "../model/cascade-monitor.js";
import { prVerdict } from "../model/checks.js";
import type { Model } from "../model/index.js";
import type { LineModel, StationId } from "../model/lines.js";
import type { QueueItem } from "../model/queue.js";
import { failedJobs, type RerunJudgement, SUMMARY_JOB } from "../model/rerun-rule.js";
import { compareVersions } from "../model/releases.js";
import { prSubstate, stationSubstateOf } from "../model/substate.js";
import type { UpFork } from "../model/upstream.js";
import type { SweepReads } from "../sweep/index.js";
import { plainText } from "../readings/index.js";
import { age, plural } from "../util.js";
import { sentenceHeadline } from "./headline.js";
import type { FocusItem } from "./index.js";
import type { TodayLine } from "./lines.js";
import { linkKind } from "./move.js";
import { gateOf } from "./pr-gate.js";
import { rolloutVisual } from "./place-visuals.js";
import type { TodayPile } from "./today-summary.js";

const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/i;

export function versionBump(released: string | undefined, proposed: string | undefined): ServiceHome["bump"] {
  if (!released || !proposed || compareVersions(proposed, released) <= 0) return undefined;
  const from = VERSION.exec(released);
  const to = VERSION.exec(proposed);
  if (!from || !to) return undefined;
  if (Number(from[1]) !== Number(to[1])) return "major";
  if (Number(from[2] ?? 0) !== Number(to[2] ?? 0)) return "minor";
  return "patch";
}

type HomeInput = {
  model: Model;
  facts: Facts;
  reads: SweepReads;
  now: Date;
  lines: readonly TodayLine[];
  items: readonly FocusItem[];
  canWait: readonly TodayPile[];
  versions: readonly { service: string; released?: string | undefined; proposed?: string | undefined }[];
};

const pull = ({ number, url }: Pick<PrFact, "number" | "url">) => ({ number, url });
const oldest = (a: ServiceHomeRow, b: ServiceHomeRow) =>
  (a.since ? Date.parse(a.since) : Infinity) - (b.since ? Date.parse(b.since) : Infinity);
const overviewOrder = Object.freeze({ blocked: 0, waiting: 1, shared: 2, "can-wait": 3 });

function causeBeside(headline: string, cause: string): string {
  const head = headline.trim().toLowerCase();
  const said = cause.trim().replace(/\.$/, "").toLowerCase();
  if (said === head) return "";
  if (!said.startsWith(`${head}: `)) return cause;
  const rest = cause.trim().slice(head.length + 2);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function overviewOf(input: HomeInput, line: LineModel): ServiceHomeRow[] {
  const { model, facts, items, lines, canWait } = input;
  const svc = line.fork.id;
  const evidence = new Map(items.map((item) => [item.id, item.evidence]));
  const nextOf = new Map(items.map((item) => [item.id, item.next]));
  const queued = new Map(model.queue.items.map((item) => [item.id, item]));
  const rows: ServiceHomeRow[] = [];
  const owe = model.radar.services[svc]?.ports?.owed.length;
  for (const { section, headline, members } of lines) {
    for (const member of members) {
      const shared = member.ids.includes(`port:${svc}`);
      if (!(shared ? owe : member.fork === svc)) continue;
      const links = new Map((member.primary ? [member.primary] : []).map((link) => [link.url, link]));
      const extra = member.ids.filter((id) => id !== member.blockedBy).flatMap((id) => evidence.get(id) ?? []);
      for (const link of extra) if (!links.has(link.url)) links.set(link.url, { ...link, kind: link.kind ?? "other" });
      const own = member.steps.length > 0 ? member.steps.join(" ") : nextOf.get(member.id);
      // A member with no queue item, such as a template rollout PR, carries its move as its cause.
      const next = shared ? undefined : own ?? member.cause;
      const cause = !shared && own === undefined ? "" : causeBeside(headline, member.cause);
      const main = queued.get(member.id);
      rows.push({
        id: member.id, section: shared ? "shared" : section, headline,
        cause, effect: member.effect, steps: member.steps, links: [...links.values()],
        ...(member.since ? { since: member.since } : {}),
        ...(next ? { next } : {}),
        ...(main?.kind === "main" && main.rerun ? failedRun(input, line, main.rerun, main.folded, [...links.values()]) : {}),
      });
    }
  }
  for (const item of model.queue.items) {
    if (
      item.scope !== svc ||
      item.kind !== "main" ||
      item.rerun?.state !== "in-flight" ||
      rows.some(({ id }) => id === item.id)
    ) continue;
    const focus = items.find(({ id }) => id === item.id);
    const links = focus?.evidence ?? [];
    rows.push({
      id: item.id,
      section: "blocked",
      headline: "Main build failed",
      cause: focus?.cause ?? item.text,
      effect: focus?.effect ?? "",
      steps: [],
      links,
      ...(item.since ? { since: item.since } : {}),
      ...(focus?.next ? { next: focus.next } : {}),
      ...failedRun(input, line, item.rerun, item.folded, links),
    });
  }
  const repo = facts.github.data?.repos[line.fork.repo];
  const repository = model.repositories.rows.find((row) => row.repo === line.fork.repo);
  const objects = [
    ...(repo?.prs ?? []).map((pr) => ({ ...pr, kind: "PR" })),
    ...(repo?.issues ?? []).filter((issue) => issue !== line.tracking).map((issue) => ({ ...issue, kind: "Issue" })),
    ...(repository ? repository.alerts.map((alert) => ({
      number: alert.pr, url: groupUrl(repository, alert), title: alert.name, createdAt: alert.since, kind: "Alert",
    })) : []),
  ];
  const byUrl = new Map(objects.map((object) => [object.url, object]));
  const gates = new Map((repo?.prs ?? []).map((pr) => [pr.url, gateOf(pr, pr.url === line.cascadePr?.pr.url)]));
  const seen = new Set<string>();
  for (const pile of canWait) {
    for (const count of pile.counts) {
      for (const url of count.urls) {
        const object = byUrl.get(url);
        if (!object || seen.has(url)) continue;
        seen.add(url);
        const title = plainText(object.title);
        const words = title.split(/\s+/);
        const gate = object.kind === "PR" ? gates.get(url) : undefined;
        rows.push({
          id: `can:${pile.id}:${url}`, section: "can-wait",
          headline: sentenceHeadline(words.length > 12 ? `${words.slice(0, 11).join(" ")}…` : title),
          cause: title,
          steps: [],
          links: [{ label: object.number && object.kind !== "Alert" ? `${object.kind} #${object.number}` : object.kind, url, kind: linkKind(url) }],
          ...(object.createdAt ? { since: object.createdAt } : {}),
          ...(gate ? { gate } : {}),
        });
      }
    }
  }
  const leads = (row: ServiceHomeRow) => (row.id === `main:${svc}` ? 0 : 1);
  return rows.sort((a, b) => overviewOrder[a.section] - overviewOrder[b.section] || leads(a) - leads(b) || oldest(a, b))
    .map((row) => {
      const since = age(row.since, input.now);
      return since ? { ...row, age: since } : row;
    });
}

// The red Main row: its failed attempt is the pill, its cause names the job, and a proven fold its evidence.
function failedRun(
  input: HomeInput, line: LineModel, rerun: RerunJudgement,
  folded: QueueItem["folded"], links: ServiceHomeRow["links"],
): Partial<ServiceHomeRow> {
  const run = line.mainRed?.run;
  if (!run) return {};
  const job = rerun.job;
  const attempt = rerun.later ?? rerun.attempt;
  const pill = { label: `Attempt ${attempt}`, url: `${run.url}/attempts/${attempt}`, kind: "run" as const };
  const failed = failedJobs(line.mainRed?.jobs).map((job) => job.failedStep ? `${job.name} (${job.failedStep})` : job.name);
  const summary = line.mainRed?.jobs.some((job) => job.name === SUMMARY_JOB && job.conclusion === "failure");
  const jobs = failed.length > 0
    ? `Failed in attempt ${rerun.attempt}: ${failed.join(", ")}.${summary ? ` ${SUMMARY_JOB} repeats it.` : ""}`
    : undefined;
  return {
    links: [
      pill, ...links.filter(({ url }) => url !== pill.url && url !== folded?.url),
      ...(folded ? [{ label: "Deployments", url: folded.url, kind: "deploy" as const }] : []),
    ],
    failure: {
      path: [run.name || "Validation", job?.name, job?.failedStep].filter(Boolean).join(" › "),
      ...(rerun.reason ? { reason: rerun.reason } : {}),
      verdict: rerun.verdict,
    },
    ...(jobs ? { jobs } : {}),
    ...(folded ? { evidence: `Lane deploy failed ${clockWord(folded.at, input.now)} in attempt ${folded.attempt}` } : {}),
    ...(rerun.state === "in-flight" ? { rerunning: true as const } : {}),
  };
}

function mergeToMain(line: LineModel) {
  let last: PastPrFact | undefined;
  for (const pr of line.past ?? []) {
    if (pr.base !== "main" || !pr.mergedAt || !Number.isFinite(Date.parse(pr.mergedAt))) continue;
    if (!last?.mergedAt || Date.parse(pr.mergedAt) > Date.parse(last.mergedAt)) last = pr;
  }
  return last?.mergedAt ? { ...pull(last), at: last.mergedAt } : undefined;
}

const clockWord = (at: string, now: Date) => when(at, { now: now.getTime() });

function integrationHolds(line: LineModel, fork: UpFork, issues: readonly IssueFact[]): string | undefined {
  const pr = line.cascadePr?.pr;
  const queued = fork.syncPr;
  const merged = fork.syncMerged;
  if (!pr || !queued || !merged || queued.number === merged.number) return undefined;
  const mergedAt = Date.parse(merged.at);
  const sync = line.past?.find((entry) => entry.number === merged.number);
  const tracked = sync && issues.some((issue) => {
    const opened = Date.parse(issue.createdAt);
    return issue.labels.includes("upstream-sync") && issue.labels.includes("validated") &&
      Date.parse(sync.createdAt) <= opened && opened <= mergedAt;
  });
  if (!tracked || !(mergedAt <= Date.parse(pr.createdAt))) return undefined;
  return `carries sync #${merged.number}, not #${queued.number}`;
}

function stationsOf(
  input: HomeInput, line: LineModel, fork: UpFork, rows: readonly ServiceHomeRow[],
  pullsRead: boolean, runsRead: boolean, upstreamRead: boolean,
): ServiceHomeStation[] {
  const { facts, model, now } = input;
  const runs = runsRead ? facts.runs.data?.[fork.repo] : undefined;
  const cellState = (id: StationId) => {
    const cell = line.stations.find((station) => station.id === id);
    return !cell || cell.state === "unknown" ? "unread" : stationSubstateOf(cell, line, facts);
  };
  const knownItems = [...model.queue.items, ...model.queue.dismissed.map(({ item }) => item)];
  const syncFailure = knownItems.some((item) => item.id === `sync-run:${fork.service}`);
  const members = new Map(input.lines.flatMap(({ members }) => members.map((member) => [member.id, member])));
  const attach = (station: ServiceHomeStation): ServiceHomeStation => {
    if (station.row) return station;
    const matching = rows.filter((row) => members.get(row.id)?.station === station.id ||
      (station.id === "main" && row.id === `main:${fork.service}`));
    const url = station.pr?.url;
    const row = (url ? matching.find((row) => row.links[0]?.url === url) : undefined) ?? matching[0] ??
      rows.find((row) => !members.get(row.id)?.station && url && row.links.some((link) => link.url === url));
    return row ? { ...station, row: row.id } : station;
  };

  const next = model.upstream.schedule.upstream;
  const blockedUpstream = rows.some((row) => row.id === `radar:${fork.service}` && row.section === "blocked");
  const upstream: ServiceHomeStation = {
    id: "upstream",
    state: blockedUpstream || syncFailure || line.halt ? "stopped" : upstreamRead ? cellState("upstream") : "unread",
    word: syncFailure ? "Sync failed" : line.halt ? "Sync halted" : !upstreamRead || fork.behind === undefined
      ? "Not read" : fork.behind === 0 ? "Sync current" : `${fork.behind} behind`,
    ...(!upstreamRead || !pullsRead || !runsRead ? { notRead: true } : {}),
    ...(next ? { nextAt: next } : {}),
  };
  const upstreamLine = [
    !syncFailure && line.halt && upstreamRead && fork.behind !== undefined ? `${fork.behind} behind` : undefined,
    next ? `next sync ${clockWord(next, now)}` : undefined,
  ].filter(Boolean).join(" · ");
  if (upstreamLine) upstream.line = upstreamLine;
  const syncPr = line.syncPr?.pr;
  const syncMovedUpstream = syncFailure || line.halt;
  const sync: ServiceHomeStation = {
    id: "sync",
    state: (!pullsRead || !runsRead) && !syncPr ? "unread"
      : syncMovedUpstream
        ? syncPr ? prSubstate(syncPr, facts.approvals.data?.[fork.repo] ?? []) : "ready"
        : cellState("sync"),
    word: syncPr ? `PR #${syncPr.number}` : "None open",
    ...(!pullsRead || !runsRead ? { notRead: true } : {}),
    ...(syncPr ? { pr: pull(syncPr) } : {}),
    ...(fork.syncPr?.holds !== undefined ? { line: plural(fork.syncPr.holds, "commit") } : {}),
  };
  const cascade = cascadeMonitor(fork, runs, now);
  const lastSync = !syncPr && fork.phase === "merged" ? fork.syncMerged : undefined;
  if (lastSync) {
    sync.word = `PR #${lastSync.number} merged`;
    sync.lastMerge = lastSync;
    sync.line = `into the upstream branch ${clockWord(lastSync.at, now)}`;
  } else if (sync.state === "unread") sync.word = "Not read";
  else if (!syncPr && sync.state === "in-progress") sync.word = "Running";

  const integrationPr = line.cascadePr?.pr;
  const cascadeState = cellState("cascade");
  const cascadeMissed = knownItems.find((item) => item.id === `cascade-missed:${fork.service}`);
  const holds = integrationHolds(line, fork, facts.github.data?.repos[fork.repo]?.issues ?? []);
  const integration: ServiceHomeStation = {
    id: "integration",
    state: cascadeState === "stopped" ? "stopped"
      : integrationPr ? cellState("main")
      : fork.phase === "cascading" ? "in-progress"
      : cascade ? (cascadeMissed ? "waiting-on-person" : "waiting-on-clock")
      : pullsRead && runsRead ? cascadeState : "unread",
    word: integrationPr ? `PR #${integrationPr.number}` : "None open",
    ...(!pullsRead || !runsRead ? { notRead: true } : {}),
    ...(integrationPr ? { pr: pull(integrationPr) } : {}),
    ...(holds ? { line: holds } : {}),
  };
  if (!integrationPr) {
    if (cascade) {
      integration.word = cascadeMissed ? "Cascade didn't start" : "Cascade waits";
      integration.line = `sync #${cascade.merge.number} merged ${clockWord(cascade.merge.at, now)} · monitor ${clockWord(cascade.at, now)}`;
      integration.nextAt = cascade.at;
      integration.inTransit = !cascadeMissed;
      if (cascadeMissed && rows.some(({ id }) => id === cascadeMissed.id)) integration.row = cascadeMissed.id;
    } else if (integration.state === "stopped") integration.word = "Stopped";
    else if (integration.state === "in-progress") integration.word = "Running";
    else if (integration.state === "waiting-on-person") integration.word = "Held";
    else if (integration.state === "unread" || fork.phase === "merged") {
      integration.state = "unread";
      integration.word = "Not read";
    }
  }
  const last = mergeToMain(line);
  const mainRun = runs?.main[0];
  const red = runsRead ? line.mainRed : undefined;
  const mainState = red ? "stopped"
    : mainRun && mainRun.status !== "completed" ? "in-progress"
    : runsRead && line.mainRun?.conclusion === "success" ? "green" : "unread";
  const main: ServiceHomeStation = {
    id: "main", state: mainState, word: {
      "in-progress": "Running", stopped: "Red", green: "Green", unread: "Not read",
    }[mainState],
    ...(last ? { lastMerge: last } : {}),
    line: red ? (red.later ? `${red.run.name} re-running · attempt ${red.later}` : `${red.run.name} failed ${clockWord(red.run.updatedAt, now)}`)
      : last ? `PR #${last.number} merged ${clockWord(last.at, now)}`
      : line.past ? "No recent merge" : "Last merge not read",
  };
  return [upstream, sync, integration, main].map(attach);
}

export function doorsOf(line: LineModel, rows: readonly ServiceHome["overview"][number][], complete: boolean): ServiceHome["doors"] {
  const doors: ServiceHomeDoor[] = (["template", "release", "other", "dependabot"] as const)
    .map((id) => ({ id, count: null, prs: [] }));
  const seen = new Set([line.syncPr?.pr.number, line.cascadePr?.pr.number]);
  for (const { pr, prClass } of line.prs) {
    if (seen.has(pr.number)) continue;
    seen.add(pr.number);
    const id = pr === line.templatePr?.pr ? "template" : pr === line.releasePr?.pr ? "release"
      : prClass === "dependabot" ? "dependabot" : "other";
    const door = doors.find((door) => door.id === id);
    if (!door) continue;
    door.prs.push(pull(pr));
    if (id === "other" && prVerdict(pr) === "red") door.red = (door.red ?? 0) + 1;
  }
  return doors.map((door) => {
    const row = rows.find((row) => row.links.some(({ url }) => door.prs.some((pr) => pr.url === url)));
    return { ...door, count: complete ? door.prs.length : null, ...(row ? { row: row.id } : {}) };
  });
}

const failedRead = (reads: SweepReads, area: AreaName, source: string) =>
  reads[area]?.some((read) =>
    (read.source === source || read.object === source) && read.failure !== undefined,
  ) ?? false;

/** Whether each source a fork's stations stand on was read: every open PR, its runs and its upstream. */
export function forkReads(facts: Facts, reads: SweepReads, line: LineModel) {
  const { repo, upstream } = line.fork;
  const github = facts.github.data?.repos[repo];
  const pullsRead = !!github && !github.prsUnread && !facts.github.error && !failedRead(reads, "github", repo);
  return {
    pulls: pullsRead && (github.openPrs === undefined || github.openPrs === github.prs.length),
    runs: !!facts.runs.data?.[repo] && !facts.runs.error && !failedRead(reads, "runs", repo),
    upstream: !!line.upstream && !facts.upstream.error && !failedRead(reads, "upstream", upstream),
  };
}

export function serviceHome(input: HomeInput): Map<string, ServiceHome> {
  const { model, facts, reads, versions } = input;
  const slots = rolloutVisual(input)?.slots ?? [];
  return new Map(model.lines.flatMap((line) => {
    const { id, repo } = line.fork;
    const fork = model.upstream.forks.find((entry) => entry.service === id);
    if (!fork) return [];
    const github = facts.github.data?.repos[repo];
    const openPrTotal = github?.openPrs;
    const failed = (area: AreaName, source: string) => failedRead(reads, area, source);
    const { pulls: complete, runs: runsRead, upstream: upstreamRead } = forkReads(facts, reads, line);
    const rows = overviewOf(input, line);
    const yours = rows.filter((row) => row.section === "blocked" || row.section === "waiting");
    const unread = !complete || !runsRead || !upstreamRead ||
      !facts.radar.data?.services[id] || !!facts.radar.error || failed("radar", repo) ||
      !facts.template.data || !!facts.template.error ||
      !facts.lifecycle.data || !!facts.lifecycle.error ||
      !facts.approvals.data || !!facts.approvals.error || failed("approvals", repo) ||
      !facts.details.data || !!facts.details.error ||
      !!facts.security.error || !facts.security.data?.[repo]?.dependabot || !facts.security.data?.[repo]?.code ||
      (github?.openIssues ?? 0) > (github?.issues.length ?? 0);
    const slot = slots.find((candidate) => candidate.service === id);
    const template = !slot || slot.state === "unknown" ? "unknown" : slot.state === "done" ? "current" : "behind";
    const version = versions.find(({ service }) => service === id);
    const bump = versionBump(version?.released, version?.proposed);
    return [[id, {
      repo, template,
      ...(version?.released ? { released: version.released } : {}),
      ...(bump && version?.proposed ? { next: version.proposed, bump } : {}),
      ...(line.releasePr ? { releasePr: { ...pull(line.releasePr.pr), age: age(line.releasePr.pr.createdAt, input.now) } } : {}),
      stations: stationsOf(input, line, fork, rows, complete, runsRead, upstreamRead),
      doors: doorsOf(line, rows, complete),
      ...(openPrTotal !== undefined ? { openPrTotal } : {}),
      overview: rows,
      mark: yours.length > 0
        ? { kind: "count", count: yours.length, tone: yours.some((row) => row.section === "blocked") ? "error" : "warning" }
        : { kind: unread ? "unread" : "check" },
    }]];
  }));
}
