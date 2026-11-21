// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AttentionTier } from "../attention.js";
import type { FocusItem } from "../brief/index.js";
import { groupName } from "../brief/repos.js";
import type { ReadRecord } from "../evidence/index.js";
import { groupUrl } from "../inspect/repo.js";
import type { Model } from "../model/index.js";
import { type AlertGroup, groupRank, type RepoRow, SEVERITY_ORDER } from "../model/repos.js";
import { plural } from "../util.js";
import { NOT_READ, plainText, type ReadingCampaign, type ReadingTile } from "./index.js";

export interface SecurityReadingItem extends FocusItem {
  attention: AttentionTier;
  owned: boolean;
  due?: { at: string; before: string } | undefined;
}

export interface SecurityPlaceInput {
  model: Model;
  items: readonly Omit<SecurityReadingItem, "more">[];
  campaigns: readonly ReadingCampaign[];
  reads: readonly ReadRecord[];
}

interface Finding {
  repo: RepoRow;
  alert: AlertGroup;
}

function spiOwned(alert: AlertGroup): boolean {
  return alert.owner !== "upstream";
}

export function serviceSecurityItem(
  service: string,
  repo: RepoRow | undefined,
): SecurityReadingItem {
  const listsRead = Number(repo?.codeAlerts !== undefined) + Number(repo?.dependabotAlerts !== undefined);
  const ours = (repo?.alerts ?? []).filter(spiOwned);
  const counts = new Map<string, number>();
  for (const alert of ours) {
    const kind = alert.source === "code" ? (alert.tool || "code-scanning") : "dependency";
    counts.set(kind, (counts.get(kind) ?? 0) + alert.count);
  }
  const title =
    listsRead === 0
      ? `Security ${NOT_READ}`
      : counts.size === 0
        ? "No SPI-owned security findings in the lists read"
        : [...counts].map(([kind, count]) => plural(count, `SPI-owned ${kind} finding`)).join(" · ");
  const upstream = (repo?.alerts ?? [])
    .filter((alert) => !spiOwned(alert))
    .reduce((sum, alert) => sum + alert.count, 0);
  const high = (repo?.vulnerabilities?.ours ?? 0) + (repo?.codeScanning?.ours ?? 0);
  const sub =
    listsRead === 0
      ? "Code scanning and dependency alerts"
      : [
          `${high} high or critical in SPI-owned shipped code`,
          plural(upstream, "upstream-origin finding"),
          repo?.codeAlerts === undefined ? `Code scanning ${NOT_READ}` : undefined,
          repo?.dependabotAlerts === undefined ? `Dependency alerts ${NOT_READ}` : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
  return {
    origin: "system",
    id: `repo:${service}`,
    ids: repo ? ours.map((alert) => alertId({ repo, alert })) : [],
    rung: 2,
    cls: "SECURITY",
    scope: service,
    title,
    sub,
    cause: `${title}.`,
    effect: "",
    next: "",
    verb: "",
    evidence: repo
      ? ours.map((alert) => ({ label: groupName(alert), url: groupUrl(repo, alert) }))
      : [],
    attention: "ambient",
    owned: false,
  };
}

const attentionRank: Readonly<Record<AttentionTier, number>> = Object.freeze({
  interrupt: 0,
  surface: 1,
  ambient: 2,
  background: 3,
});

type Urgency = Pick<SecurityReadingItem, "attention" | "due">;

function urgency(a: Urgency, b: Urgency): number {
  return (
    attentionRank[a.attention] - attentionRank[b.attention] ||
    (a.due ? Date.parse(a.due.at) : Infinity) - (b.due ? Date.parse(b.due.at) : Infinity)
  );
}

function alertId({ repo, alert }: Finding): string {
  return `alert:${repo.repo}:${alert.id}`;
}

function keyOf(alert: AlertGroup): string {
  return alert.source === "code"
    ? `code:${alert.tool}:${alert.rule}`
    : `dep:${alert.name.toLowerCase()}`;
}

interface Member extends Urgency {
  id: string;
  ids: string[];
}

/** One rule or package's ids on Today: its alerts, its campaign and the Briefing items it projects. */
function ruleMember(
  findings: readonly Finding[],
  items: SecurityPlaceInput["items"],
  campaigns: readonly ReadingCampaign[],
): { member: Member; rank: AlertGroup } {
  const sorted = [...findings].sort((a, b) => groupRank(a.alert, b.alert));
  const first = sorted[0];
  if (!first) throw new Error("A security rule needs at least one finding");
  const { alert } = first;
  const count = findings.reduce((sum, finding) => sum + finding.alert.count, 0);
  const campaign = campaigns.find(
    (c) =>
      c.kind === "security" &&
      alert.source === "code" &&
      c.fact === `${alert.tool}: ${alert.rule}`,
  );
  const ids = findings.map(alertId);
  const queueIds = new Set(
    findings.map(({ alert: g }) => `security:${g.source}:${g.name.toLowerCase()}`),
  );
  const projected = items
    .filter(
      (item) =>
        item.cls === "SECURITY" &&
        (queueIds.has(item.id) || ids.includes(item.id) || item.ids.some((id) => ids.includes(id))),
    )
    .sort(urgency);
  const source = projected[0];
  const severity = SEVERITY_ORDER.find((level) =>
    findings.some(({ alert: g }) => g.severity === level),
  );
  return {
    rank: { ...alert, count, ...(severity ? { severity } : {}) },
    member: {
      id: campaign?.id ?? alertId(first),
      ids: [...new Set([...ids, ...projected.flatMap((item) => item.ids)])],
      attention: source?.attention ?? "ambient",
      ...(source?.due ? { due: source.due } : {}),
    },
  };
}

function groupOf(member: Member): string {
  if (member.attention === "interrupt") return "Needs you now";
  if (member.due) return `Before ${member.due.before}`;
  return member.attention === "surface" ? "Needs attention" : "In the background";
}

function qualifierOf(reads: readonly ReadRecord[]): string | undefined {
  const failed = reads.filter((read) => read.failure !== undefined).length;
  const incomplete = reads.filter((read) => read.completeness.kind === "cut").length;
  const parts = [
    failed > 0 ? `${plural(failed, "security read")} failed` : undefined,
    incomplete > 0
      ? `${plural(incomplete, "security read")} ${incomplete === 1 ? "was" : "were"} incomplete`
      : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(" and ")}, so findings could be missing.` : undefined;
}

export interface SecurityPlace {
  headline: string;
  qualifier?: string;
  tiles: [ReadingTile];
  /** Today's Security row holds these Briefing and alert ids, grouped by urgency as before. */
  itemIds: string[];
}

/** What Today's Security place row reads; the Security page itself draws the pane. */
export function securityPlace(input: SecurityPlaceInput): SecurityPlace {
  const rows = input.model.repositories.rows;
  const listsRead = rows.reduce(
    (sum, row) =>
      sum + Number(row.dependabotAlerts !== undefined) + Number(row.codeAlerts !== undefined),
    0,
  );
  const unread = rows.length * 2 - listsRead;
  const missing = unread > 0 ? ` · ${plural(unread, "list")} ${NOT_READ}` : "";
  const high = rows.reduce(
    (sum, row) => sum + (row.vulnerabilities?.ours ?? 0) + (row.codeScanning?.ours ?? 0),
    0,
  );
  const ours = rows
    .flatMap((repo) => repo.alerts.map((alert) => ({ repo, alert })))
    .filter(({ alert }) => spiOwned(alert));
  const total = ours.reduce((sum, { alert }) => sum + alert.count, 0);
  const rules = new Map<string, Finding[]>();
  for (const finding of ours) {
    const key = keyOf(finding.alert);
    rules.set(key, [...(rules.get(key) ?? []), finding]);
  }
  const ranked = [...rules.values()]
    .map((members) => ruleMember(members, input.items, input.campaigns))
    .sort((a, b) => urgency(a.member, b.member) || groupRank(a.rank, b.rank));
  const groups = new Map<string, Member[]>();
  for (const { member } of ranked)
    groups.set(groupOf(member), [...(groups.get(groupOf(member)) ?? []), member]);
  const seen = new Set<string>();
  const members = [...groups.values()].flat().filter(({ id }) => !seen.has(id) && seen.add(id));
  const qualifier = qualifierOf(input.reads);
  return {
    headline: plainText(
      listsRead === 0
        ? `Security ${NOT_READ}.`
        : high > 0
          ? `${unread > 0 ? "At least " : ""}${plural(high, "high or critical finding")} ${high === 1 ? "needs" : "need"} SPI fixes.`
          : total > 0
            ? `${plural(total, "SPI-owned finding")} ${total === 1 ? "remains" : "remain"} across the lists read.`
            : "No SPI-owned findings in the lists read.",
    ),
    ...(qualifier ? { qualifier: plainText(qualifier) } : {}),
    tiles: [
      {
        label: "High",
        value: listsRead === 0 ? NOT_READ : String(high),
        counts: plainText(`high or critical in SPI-owned shipped code${missing}`),
      },
    ],
    itemIds: [...new Set(members.flatMap(({ id, ids }) => [id, ...ids]))],
  };
}
