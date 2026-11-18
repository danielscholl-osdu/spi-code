// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceAlertRow, ServiceUpstreamSecurity } from "@spi-code/contracts";
import type { ReadRecord } from "../evidence/index.js";
import type {
  CodeAlertFact,
  DependencyAlertFact,
  Facts,
  Measured,
  MrFact,
  PastPrFact,
} from "../facts.js";
import type { Model } from "../model/index.js";
import type { LineModel } from "../model/lines.js";
import {
  forkPaths,
  newerVersion,
  ownerOf,
  type Paths,
  reachOf,
  SEVERITY_ORDER,
} from "../model/repos.js";
import { syncSplit } from "../model/upstream.js";
import type { SweepReads } from "../sweep/index.js";

const IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const MR_LIST = "merge_requests?state=opened&target_branch=master";
const PORT_READS =
  /^(merge_requests\?state=opened&target_branch=master|merged MRs|port PRs|pulls\/\d+\/commits|merge_requests\/\d+\/(diffs|changes)\b.*|\.github\/upstream-filter\.yml)$/;
const GROUP_ORDER = Object.freeze({ spi: 0, upstream: 1, tests: 2 });

const NO_FILE = "no file associated with this alert";
const VERSION = /^v?\d+(\.[0-9a-z]+)+([-+][0-9a-z.]+)*$/;

type Read = { read: boolean; at?: string };

const missed = (record: ReadRecord) =>
  record.failure !== undefined || (record.object === "merged MRs" && record.completeness.kind === "cut");

/** Whether one source's rows were read this sweep, and when the rows held were read. */
export function readOf(
  area: Measured<unknown>,
  records: readonly ReadRecord[] | undefined,
  match: (record: ReadRecord) => boolean,
  held: boolean,
): Read {
  if (!held) return { read: false };
  const failed = (records ?? []).filter((record) => match(record) && missed(record));
  if (failed.length > 0) {
    const times = failed.map((record) => record.retainedFrom);
    const at = times.every((time): time is string => time !== undefined)
      ? times.sort()[0]
      : undefined;
    return { read: false, ...(at ? { at } : {}) };
  }
  return { read: !area.error, ...(area.at ? { at: area.at } : {}) };
}

/** Open upstream MRs: non-drafts that moved within 30 days, newest first; the rest counted once. */
export function openUpstream(mrs: readonly MrFact[], now: Date) {
  const drafts = mrs.filter((mr) => mr.draft).length;
  const fresh = (mr: MrFact) => now.getTime() - Date.parse(mr.updatedAt) <= IDLE_MS;
  const shown = mrs
    .filter((mr) => !mr.draft && fresh(mr))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.iid - a.iid)
    .map((mr) => ({
      iid: mr.iid,
      title: mr.title,
      url: mr.url,
      ...(mr.author ? { author: mr.author } : {}),
      updatedAt: mr.updatedAt,
    }));
  return { total: mrs.length, shown, drafts, idle: mrs.length - drafts - shown.length };
}

const slug = (name: string) => name.toLowerCase().replace(/[:@]/g, "-").replace(/^-+/, "");

/** A Dependabot PR closed unmerged whose head branch names this package in this manifest directory. */
export function closedFix(
  alert: Pick<DependencyAlertFact, "package" | "manifest">,
  past: readonly PastPrFact[],
): PastPrFact | undefined {
  const at = alert.manifest.lastIndexOf("/");
  const dir = at < 0 ? "" : `${alert.manifest.slice(0, at)}/`;
  const want = `${slug(alert.package)}-`;
  let found: PastPrFact | undefined;
  for (const pr of past) {
    if (pr.mergedAt || !pr.closedAt) continue;
    const rest = /^dependabot\/[^/]+\/(.+)$/.exec(pr.head)?.[1];
    if (!rest?.startsWith(dir)) continue;
    const name = rest.slice(dir.length).toLowerCase();
    if (!name.startsWith(want) || !VERSION.test(name.slice(want.length))) continue;
    if (!found || Date.parse(pr.closedAt) > Date.parse(found.closedAt ?? "")) found = pr;
  }
  return found;
}

/** Settings (no file) and tooling paths join the tests group as tooling, whatever the dependency's scope. */
function groupOf(path: string | undefined, paths: Paths, scope?: string): Pick<ServiceAlertRow, "group" | "tooling"> {
  if (!path || reachOf(path) === "tooling") return { group: "tests", tooling: true };
  if (reachOf(path, scope) === "tests") return { group: "tests" };
  return { group: ownerOf(path, paths) === "upstream" ? "upstream" : "spi" };
}

const rank = (severity: ServiceAlertRow["severity"]) =>
  severity ? SEVERITY_ORDER.indexOf(severity) : SEVERITY_ORDER.length;

/** One row per package or rule in each group, holding every alert number with its severity. */
export function alertRows(
  alerts: { dependabot?: DependencyAlertFact[]; code?: CodeAlertFact[] },
  paths: Paths,
  past: readonly PastPrFact[],
): ServiceAlertRow[] {
  const rows = new Map<string, ServiceAlertRow & { fixes: (string | null)[]; details: Set<string> }>();
  const add = (
    key: string,
    base: Omit<ServiceAlertRow, "id" | "alerts" | "severity" | "fix" | "detail">,
    alert: ServiceAlertRow["alerts"][number],
    fix: string | null | undefined,
    detail: string,
  ) => {
    const id = `${base.group}:${key}`;
    const row = rows.get(id) ?? { id, ...base, alerts: [], fixes: [], details: new Set<string>() };
    if (base.tooling) row.tooling = true;
    row.alerts.push(alert);
    if (fix !== undefined) row.fixes.push(fix);
    row.details.add(detail);
    if (alert.severity && rank(alert.severity) < rank(row.severity)) row.severity = alert.severity;
    rows.set(id, row);
  };
  for (const a of alerts.dependabot ?? []) {
    const pr = closedFix(a, past);
    add(
      `dep:${a.package.toLowerCase()}`,
      { source: "dependabot", title: a.package, ...groupOf(a.manifest, paths, a.scope) },
      {
        number: a.number,
        severity: a.severity,
        url: a.url,
        path: a.manifest,
        ...(pr ? { closedPr: { number: pr.number, url: pr.url } } : {}),
      },
      a.fixed ?? null,
      a.summary,
    );
  }
  for (const a of alerts.code ?? []) {
    const path = a.path && a.path.toLowerCase() !== NO_FILE ? a.path : undefined;
    add(
      `code:${a.tool}:${a.rule}`,
      { source: "code", title: a.description, ...groupOf(path, paths) },
      {
        number: a.number,
        ...(a.severity ? { severity: a.severity } : {}),
        ...(a.ruleSeverity ? { ruleSeverity: a.ruleSeverity } : {}),
        url: a.url,
        ...(path ? { path } : {}),
      },
      undefined,
      "",
    );
  }
  return [...rows.values()]
    .map(({ fixes, details, ...row }) => {
      const [detail] = details;
      const fix = fixes.includes(null)
        ? null
        : fixes.reduce<string | undefined>((best, v) => (v && (!best || newerVersion(v, best)) ? v : best), undefined);
      return {
        ...row,
        alerts: row.alerts.sort((a, b) => b.number - a.number),
        ...(row.source === "dependabot" ? { fix: fix ?? null } : {}),
        ...(details.size === 1 && detail ? { detail } : {}),
      };
    })
    .sort(
      (a, b) =>
        GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
        rank(a.severity) - rank(b.severity) ||
        b.alerts.length - a.alerts.length ||
        a.title.localeCompare(b.title),
    );
}

/** What the next sync brings; null when an open sync PR's holdings are unknown, so the split is unread. */
function nextSyncOf(line: LineModel, model: Model) {
  const fork = model.upstream.forks.find((entry) => entry.service === line.fork.id);
  const behind = line.upstream?.lag;
  if (!fork || behind === undefined) return undefined;
  if (fork.syncPr && fork.syncPr.holds === undefined) return null;
  const split = syncSplit(fork);
  const commits = line.upstream?.commits ?? [];
  return {
    behind,
    ...(line.upstream?.head ? { head: line.upstream.head.sha } : {}),
    ...(split.held > 0 && fork.syncPr
      ? { held: { count: split.held, pr: { number: fork.syncPr.number, url: fork.syncPr.url } } }
      : {}),
    next: commits.slice(split.held).map(({ sha, title, url }) => ({ sha, title, url })),
  };
}

export function serviceUpstream(input: {
  model: Model;
  facts: Facts;
  reads: SweepReads;
  now: Date;
}): Map<string, ServiceUpstreamSecurity> {
  const { model, facts, reads, now } = input;
  return new Map(
    model.lines.map((line) => {
      const { id, repo, upstream } = line.fork;
      const radar = facts.radar.data?.services[id];
      const ports = model.radar.services[id]?.ports;
      const portRead = readOf(
        facts.radar,
        reads.radar,
        (r) => (r.source === upstream || r.source === repo) && PORT_READS.test(r.object),
        !!ports,
      );
      const listRead = readOf(facts.radar, reads.radar, (r) => r.source === upstream && r.object === MR_LIST, !!radar);
      const queue = nextSyncOf(line, model);
      const syncRead = readOf(facts.upstream, reads.upstream, (r) => r.source === upstream, queue !== undefined);
      const alerts = facts.security.data?.[repo];
      const securityRead = (list: unknown) =>
        readOf(facts.security, reads.security, (r) => r.source === repo && r.object === "security", list !== undefined);
      const dependabot = securityRead(alerts?.dependabot);
      const code = securityRead(alerts?.code);
      const paths = forkPaths(line.fork, facts.radar.data?.filters, facts.template.data?.synced);
      const past = facts.github.data?.repos[repo]?.pastPrs ?? [];
      const rows = alerts ? alertRows(alerts, paths, past) : [];
      const mrs = ports?.owed
        .map(({ iid, title, url, mergedAt, trees }) => ({ iid, title, url, mergedAt, trees }))
        .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
      return [
        id,
        {
          upstream: {
            count: portRead.read && mrs ? mrs.length : null,
            toPort: { ...portRead, ...(mrs ? { mrs } : {}) },
            nextSync: queue ? { ...syncRead, queue } : { ...syncRead, read: false },
            open: { ...listRead, ...(radar ? { list: openUpstream(radar.mrs, now) } : {}) },
          },
          security: {
            count:
              dependabot.read && code.read
                ? rows.filter((row) => row.group !== "tests").reduce((n, row) => n + row.alerts.length, 0)
                : null,
            dependabot,
            code,
            rows,
          },
        },
      ] as const;
    }),
  );
}
