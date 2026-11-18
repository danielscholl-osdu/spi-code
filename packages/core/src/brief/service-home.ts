// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceHome, ServiceHomeDoor, ServiceHomeRow, ServiceHomeStation } from "@spi-code/contracts";
import type { AreaName, Facts, IssueFact, PastPrFact, PrFact } from "../facts.js";
import { groupUrl } from "../inspect/repo.js";
import { cascadeMonitor } from "../model/cascade-monitor.js";
import type { Model } from "../model/index.js";
import type { LineModel, StationId } from "../model/lines.js";
import { compareVersions } from "../model/releases.js";
import { stationSubstateOf } from "../model/substate.js";
import type { UpFork } from "../model/upstream.js";
import type { SweepReads } from "../sweep/index.js";
import { plainText } from "../readings/index.js";
import { plural } from "../util.js";
import type { FocusItem } from "./index.js";
import type { TodayLine } from "./lines.js";
import { linkKind } from "./move.js";
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

function overviewOf(input: HomeInput, line: LineModel): ServiceHomeRow[] {
  const { model, facts, items, lines, canWait } = input;
  const svc = line.fork.id;
  const evidence = new Map(items.map((item) => [item.id, item.evidence]));
  const rows: ServiceHomeRow[] = [];
  const owe = model.radar.services[svc]?.ports?.owed.length;
  for (const { section, headline, members } of lines) {
    for (const member of members) {
      const shared = member.ids.includes(`port:${svc}`);
      if (!(shared ? owe : member.fork === svc)) continue;
      const links = new Map((member.primary ? [member.primary] : []).map((link) => [link.url, link]));
      const extra = member.ids.filter((id) => id !== member.blockedBy).flatMap((id) => evidence.get(id) ?? []);
      for (const link of extra) if (!links.has(link.url)) links.set(link.url, { ...link, kind: link.kind ?? "other" });
      rows.push({
        id: member.id, section: shared ? "shared" : section, headline,
        cause: member.cause, effect: member.effect, steps: member.steps, links: [...links.values()],
        ...(member.since ? { since: member.since } : {}),
      });
    }
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
  const seen = new Set<string>();
  for (const pile of canWait) {
    for (const count of pile.counts) {
      for (const url of count.urls) {
        const object = byUrl.get(url);
        if (!object || seen.has(url)) continue;
        seen.add(url);
        const title = plainText(object.title);
        const words = title.split(/\s+/);
        rows.push({
          id: `can:${pile.id}:${url}`, section: "can-wait",
          headline: words.length > 12 ? `${words.slice(0, 11).join(" ")}…` : title,
          cause: title,
          steps: [],
          links: [{ label: object.number && object.kind !== "Alert" ? `${object.kind} #${object.number}` : object.kind, url, kind: linkKind(url) }],
          ...(object.createdAt ? { since: object.createdAt } : {}),
        });
      }
    }
  }
  return rows.sort((a, b) => overviewOrder[a.section] - overviewOrder[b.section] || oldest(a, b));
}

function mergeToMain(line: LineModel) {
  let last: PastPrFact | undefined;
  for (const pr of line.past ?? []) {
    if (pr.base !== "main" || !pr.mergedAt || !Number.isFinite(Date.parse(pr.mergedAt))) continue;
    if (!last?.mergedAt || Date.parse(pr.mergedAt) > Date.parse(last.mergedAt)) last = pr;
  }
  return last?.mergedAt ? { ...pull(last), at: last.mergedAt } : undefined;
}

function clockWord(at: string, now: Date): string {
  const date = new Date(at);
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return hm;
  if (Math.abs(now.getTime() - date.getTime()) < 7 * 86_400_000)
    return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

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

const ROW_STATION: Readonly<Record<string, ServiceHomeStation["id"]>> = Object.freeze({
  radar: "upstream", halt: "sync", "sync-run": "sync", gate1: "sync",
  conflict: "integration", cascade: "integration", "cascade-missed": "integration",
  labels: "integration", gate2: "integration", main: "main",
});

function stationsOf(
  input: HomeInput, line: LineModel, fork: UpFork, rows: readonly ServiceHomeRow[],
  pullsRead: boolean, runsRead: boolean,
): ServiceHomeStation[] {
  const { facts, model, now } = input;
  const runs = runsRead ? facts.runs.data?.[fork.repo] : undefined;
  const cellState = (id: StationId) => {
    const cell = line.stations.find((station) => station.id === id);
    return !cell || cell.state === "unknown" ? "unread" : stationSubstateOf(cell, line, facts);
  };
  const syncFailure = model.queue.items.find((item) => item.id === `sync-run:${fork.service}`);
  const openSyncFailure = syncFailure?.text === "Sync failed";
  const attach = (station: ServiceHomeStation): ServiceHomeStation => {
    const row = rows.find((row) => (openSyncFailure && row.id === syncFailure.id ? "upstream"
      : ROW_STATION[row.id.split(":")[0] ?? ""]) === station.id ||
      (station.pr && row.links.some(({ url }) => url === station.pr?.url)));
    return row ? { ...station, row: row.id } : station;
  };

  const next = model.upstream.schedule.upstream;
  const blockedUpstream = rows.some((row) => row.id === `radar:${fork.service}` && row.section === "blocked");
  const upstream: ServiceHomeStation = {
    id: "upstream",
    state: blockedUpstream || openSyncFailure ? "stopped" : cellState("upstream"),
    word: openSyncFailure ? "Sync failed" : fork.behind === undefined ? "Not read" : fork.behind === 0 ? "Sync current" : `${fork.behind} behind`,
    ...(next ? { line: `next sync ${clockWord(next, now)}`, nextAt: next } : {}),
  };
  const syncPr = line.syncPr?.pr;
  const failedSync = syncFailure && !openSyncFailure;
  const sync: ServiceHomeStation = {
    id: "sync",
    state: (!pullsRead || !runsRead) && !syncPr ? (line.halt || failedSync ? "stopped" : "unread")
      : failedSync ? "stopped" : cellState("sync"),
    word: syncPr ? `PR #${syncPr.number}` : "None open",
    ...(syncPr ? { pr: pull(syncPr) } : {}),
    ...(fork.syncPr?.holds !== undefined ? { line: plural(fork.syncPr.holds, "commit") } : {}),
  };
  const cascade = cascadeMonitor(fork, runs, now);
  const lastSync = !syncPr && fork.phase === "merged" ? fork.syncMerged : undefined;
  if (lastSync) {
    sync.word = `PR #${lastSync.number} merged`;
    sync.lastMerge = lastSync;
    sync.line = `into the upstream branch ${clockWord(lastSync.at, now)}`;
  } else if (line.halt || failedSync) {
    sync.word = line.halt ? "Sync halted" : "Sync failed";
    if (syncPr) sync.line ??= `PR #${syncPr.number}`;
  } else if (sync.state === "unread") sync.word = "Not read";
  else if (!syncPr && sync.state === "in-progress") sync.word = "Running";

  const integrationPr = line.cascadePr?.pr;
  const cascadeState = cellState("cascade");
  const holds = integrationHolds(line, fork, facts.github.data?.repos[fork.repo]?.issues ?? []);
  const integration: ServiceHomeStation = {
    id: "integration",
    state: cascadeState === "stopped" ? "stopped"
      : integrationPr ? cellState("main")
      : fork.phase === "cascading" ? "in-progress"
      : cascade ? (cascade.overdue ? "waiting-on-person" : "waiting-on-clock")
      : pullsRead && runsRead ? cascadeState : "unread",
    word: integrationPr ? `PR #${integrationPr.number}` : "None open",
    ...(integrationPr ? { pr: pull(integrationPr) } : {}),
    ...(holds ? { line: holds } : {}),
  };
  if (!integrationPr) {
    if (cascade) {
      integration.word = cascade.overdue ? "Cascade didn't start" : "Cascade waits";
      integration.line = `sync #${cascade.merge.number} merged ${clockWord(cascade.merge.at, now)} · monitor ${clockWord(cascade.at, now)}`;
      integration.nextAt = cascade.at;
      integration.inTransit = !cascade.overdue;
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
  const mainState = mainRun && mainRun.status !== "completed" ? "in-progress"
    : runsRead && line.mainRed ? "stopped"
    : runsRead && line.mainRun?.conclusion === "success" ? "green" : "unread";
  const main: ServiceHomeStation = {
    id: "main", state: mainState, word: {
      "in-progress": "Running", stopped: "Red", green: "Green", unread: "Not read",
    }[mainState],
    ...(last ? { lastMerge: last } : {}),
    line: last ? `PR #${last.number} merged ${clockWord(last.at, now)}`
      : line.past ? "No recent merge" : "Last merge not read",
  };
  return [upstream, sync, integration, main].map(attach);
}

function doorsOf(line: LineModel, rows: readonly ServiceHomeRow[], complete: boolean): ServiceHomeDoor[] {
  const doors: ServiceHomeDoor[] = (["template", "release", "other", "dependabot"] as const)
    .map((id) => ({ id, count: null, prs: [] }));
  const seen = new Set([line.syncPr?.pr.number, line.cascadePr?.pr.number]);
  for (const { pr, prClass } of line.prs) {
    if (seen.has(pr.number)) continue;
    seen.add(pr.number);
    const id = pr === line.templatePr?.pr ? "template" : pr === line.releasePr?.pr ? "release"
      : prClass === "dependabot" ? "dependabot" : "other";
    doors.find((door) => door.id === id)?.prs.push(pull(pr));
  }
  return doors.map((door) => {
    const row = rows.find((row) => row.links.some(({ url }) => door.prs.some((pr) => pr.url === url)));
    return { ...door, count: complete ? door.prs.length : null, ...(row ? { row: row.id } : {}) };
  });
}

export function serviceHome(input: HomeInput): Map<string, ServiceHome> {
  const { model, facts, reads, versions } = input;
  const slots = rolloutVisual(input)?.slots ?? [];
  return new Map(model.lines.flatMap((line) => {
    const { id, repo, upstream } = line.fork;
    const fork = model.upstream.forks.find((entry) => entry.service === id);
    if (!fork) return [];
    const github = facts.github.data?.repos[repo];
    const openPrTotal = github?.openPrs;
    const failed = (area: AreaName, source: string) =>
      reads[area]?.some((read) =>
        (read.source === source || read.object === source) && read.failure !== undefined,
      );
    const pullsRead = !!github && !github.prsUnread && !facts.github.error && !failed("github", repo);
    const complete = pullsRead && (openPrTotal === undefined || openPrTotal === github.prs.length);
    const runsRead = !!facts.runs.data?.[repo] && !facts.runs.error && !failed("runs", repo);
    const rows = overviewOf(input, line);
    const yours = rows.filter((row) => row.section === "blocked" || row.section === "waiting");
    const unread = !complete || !runsRead || !line.upstream || !!facts.upstream.error || failed("upstream", upstream) ||
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
      ...(line.releasePr ? { releasePr: pull(line.releasePr.pr) } : {}),
      stations: stationsOf(input, line, fork, rows, complete, runsRead),
      doors: doorsOf(line, rows, complete),
      ...(openPrTotal !== undefined ? { openPrTotal } : {}),
      overview: rows,
      mark: yours.length > 0
        ? { kind: "count", count: yours.length, tone: yours.some((row) => row.section === "blocked") ? "error" : "warning" }
        : { kind: unread ? "unread" : "check" },
    }]];
  }));
}
