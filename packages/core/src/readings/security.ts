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
import {
  NOT_READ,
  type PlaceReading,
  placeReading,
  type ReadingCampaign,
  type ReadingGroup,
} from "./index.js";

export interface SecurityReadingItem extends FocusItem {
  attention: AttentionTier;
  owned: boolean;
  due?: { at: string; before: string } | undefined;
}

export interface SecurityReadingInput {
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

function urgency(
  a: Pick<SecurityReadingItem, "attention" | "due">,
  b: Pick<SecurityReadingItem, "attention" | "due">,
): number {
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

function ruleItem(
  findings: readonly Finding[],
  items: SecurityReadingInput["items"],
  campaigns: readonly ReadingCampaign[],
): { item: SecurityReadingItem; rank: AlertGroup } {
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
  const repos = [...new Set(findings.map(({ repo }) => repo.name))];
  const programRepos = [
    ...new Set(findings.filter(({ repo }) => repo.group !== "fork").map(({ repo }) => repo.name)),
  ];
  const reaches = [
    ...new Set(
      findings.map(({ alert: g }) =>
        g.reach === "settings"
          ? "repository settings"
          : g.reach === "shipped"
            ? "shipped code"
            : g.reach,
      ),
    ),
  ];
  const severity = SEVERITY_ORDER.find((level) =>
    findings.some(({ alert: g }) => g.severity === level),
  );
  const name =
    alert.source === "code" && alert.tool === "Scorecard"
      ? `Scorecard: ${groupName(alert).replace(/-/g, " ").toLowerCase()}`
      : groupName(alert);
  const title = `${campaign ? "Detected: " : ""}${name}${
    alert.source === "dependabot" ? " vulnerabilities" : ""
  }`;
  return {
    rank: { ...alert, count, ...(severity ? { severity } : {}) },
    item: {
      origin: "system",
      id: campaign?.id ?? alertId(first),
      ids: [...new Set([...ids, ...projected.flatMap((item) => item.ids)])],
      rung: source?.rung ?? 2,
      cls: "SECURITY",
      scope: campaign
        ? [plural(campaign.forks.length, "fork"), ...programRepos].join(", ")
        : repos.length === 1
          ? first.repo.name
          : plural(repos.length, "repository", "repositories"),
      title,
      sub: [
        plural(count, "SPI-owned finding"),
        severity ? `worst ${severity}` : undefined,
        reaches.join(", "),
      ]
        .filter(Boolean)
        .join(" · "),
      cause: `${plural(count, "SPI-owned finding")} for ${name}.`,
      effect: "",
      next: campaign ? "" : (source?.next ?? ""),
      verb: campaign ? "" : (source?.verb ?? ""),
      evidence: findings.map((finding) => ({
        label: `${finding.repo.name} findings`,
        url: groupUrl(finding.repo, finding.alert),
      })),
      attention: source?.attention ?? "ambient",
      owned: source?.owned ?? false,
      ...(source?.due ? { due: source.due } : {}),
    },
  };
}

function groupOf(item: SecurityReadingItem): string {
  if (item.attention === "interrupt") return "Needs you now";
  if (item.due) return `Before ${item.due.before}`;
  return item.attention === "surface" ? "Needs attention" : "In the background";
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

export function securityReading(input: SecurityReadingInput): PlaceReading<SecurityReadingItem> {
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
  const findings = rows.flatMap((repo) => repo.alerts.map((alert) => ({ repo, alert })));
  const ours = findings.filter(({ alert }) => spiOwned(alert));
  const total = ours.reduce((sum, { alert }) => sum + alert.count, 0);
  const upstream = findings
    .filter(({ alert }) => alert.owner === "upstream")
    .reduce((sum, { alert }) => sum + alert.count, 0);
  const rules = new Map<string, Finding[]>();
  for (const finding of ours) {
    const key = keyOf(finding.alert);
    const members = rules.get(key) ?? [];
    members.push(finding);
    rules.set(key, members);
  }
  const ranked = [...rules.values()]
    .map((members) => ruleItem(members, input.items, input.campaigns))
    .sort((a, b) => urgency(a.item, b.item) || groupRank(a.rank, b.rank));
  const groups: ReadingGroup<SecurityReadingItem>[] = [];
  for (const { item } of ranked) {
    const group = groupOf(item);
    const found = groups.find((entry) => entry.group === group);
    if (found) (found.items as SecurityReadingItem[]).push(item);
    else groups.push({ group, items: [item] });
  }
  const qualifier = qualifierOf(input.reads);
  return placeReading({
    headline:
      listsRead === 0
        ? `Security ${NOT_READ}.`
        : high > 0
          ? `${unread > 0 ? "At least " : ""}${plural(high, "high or critical finding")} ${high === 1 ? "needs" : "need"} SPI fixes.`
          : total > 0
            ? `${plural(total, "SPI-owned finding")} ${total === 1 ? "remains" : "remain"} across the lists read.`
            : "No SPI-owned findings in the lists read.",
    ...(qualifier ? { qualifier } : {}),
    tiles: [
      {
        label: "High",
        value: listsRead === 0 ? NOT_READ : String(high),
        counts: `high or critical in SPI-owned shipped code${missing}`,
      },
      {
        label: "Total",
        value: listsRead === 0 ? NOT_READ : String(total),
        counts: `SPI-owned findings at all severities${missing}`,
      },
      {
        label: "Upstream origin",
        value: listsRead === 0 ? NOT_READ : String(upstream),
        counts: `upstream-owned findings at all severities${missing}`,
      },
    ],
    groups,
    fold: (rest) =>
      `${plural(rest.length, "more rule or package", "more rules or packages")} with SPI-owned findings.`,
  });
}
