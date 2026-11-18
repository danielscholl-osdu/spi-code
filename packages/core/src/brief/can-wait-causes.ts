// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CanWaitCause, CanWaitCauses } from "@spi-code/contracts";
import { plainText } from "../readings/index.js";
import { age } from "../util.js";

type CauseKind = CanWaitCause["kind"];
export type CauseObject = {
  id: string;
  repo: string;
  fork: string;
  group: NonNullable<CanWaitCause["forks"][number]["group"]>;
  notRead?: true;
  label: string;
  url: string;
  title: string;
  since?: string | undefined;
  count?: number;
  package?: { ecosystem: string; name: string };
  rule?: string;
};

const normalized = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
const when = (at: string | undefined) => {
  const time = Date.parse(at ?? "");
  return Number.isFinite(time) ? time : Infinity;
};
const byName = (a: string, b: string) => a.localeCompare(b, "en");
const countOf = (objects: readonly CauseObject[]) =>
  objects.reduce((sum, object) => sum + (object.count ?? 1), 0);

function grouped<T>(objects: readonly T[], keyOf: (object: T) => string): Map<string, [T, ...T[]]> {
  const groups = new Map<string, [T, ...T[]]>();
  for (const object of objects) {
    const key = keyOf(object);
    const group = groups.get(key);
    if (group) group.push(object);
    else groups.set(key, [object]);
  }
  return groups;
}

function headline(title: string): string {
  const words = plainText(title).split(/\s+/);
  return words.length > 12 ? `${words.slice(0, 11).join(" ")}…` : words.join(" ");
}

function sharedPackages(
  objects: readonly CauseObject[],
): NonNullable<CanWaitCause["packages"]> {
  const named = objects.flatMap(({ package: pkg, fork, group, notRead }) =>
    pkg && group === "fork" && !notRead ? [{ ...pkg, fork }] : []);
  return [...grouped(named, ({ ecosystem, name }) => JSON.stringify([ecosystem, name])).values()]
    .flatMap(([pkg, ...rest]) => {
      if (!pkg) return [];
      const forks = [...new Set([pkg, ...rest].map(({ fork }) => fork))];
      return forks.length > 1 ? [{ ecosystem: pkg.ecosystem, name: pkg.name, forks }] : [];
    })
    .sort((a, b) => byName(a.ecosystem, b.ecosystem) || byName(a.name, b.name));
}

function topRules(objects: readonly CauseObject[]): CanWaitCause["rules"] {
  const rules = [...grouped(objects, ({ rule, title }) => rule ?? title).values()]
    .flatMap((entries) => {
      const first = entries[0];
      return first ? [{
        name: first.title, alerts: countOf(entries),
        forks: new Set(entries.filter(({ group }) => group === "fork").map(({ fork }) => fork)).size,
      }] : [];
    });
  const most = (field: "alerts" | "forks") => {
    const first = [...rules].sort((a, b) => b[field] - a[field] || byName(a.name, b.name))[0];
    return first ? { name: plainText(first.name), count: first[field] } : undefined;
  };
  const mostAlerts = most("alerts");
  const mostForks = most("forks");
  return mostAlerts && mostForks ? { mostAlerts, mostForks } : undefined;
}

export function canWaitCauses(
  objects: Readonly<Record<CauseKind, readonly CauseObject[]>>,
  notRead: CanWaitCauses["notRead"],
  remainders: Record<"release" | "dependabot", NonNullable<CanWaitCause["remainder"]>>,
  now: Date,
): CanWaitCauses {
  const make = (kind: CauseKind, id: string, title: string, entries: readonly CauseObject[]): CanWaitCause => {
    const groups = [...grouped(entries, (entry) => entry.repo).values()];
    const counted = entries.filter(({ group, notRead }) => group === "fork" && !notRead);
    const programOnly = entries.every(({ group }) => group === "program");
    return {
      id, kind, headline: headline(title), count: countOf(programOnly ? entries : counted),
      forkCount: new Set(counted.map(({ repo }) => repo)).size,
      forks: groups.map((members) => ({
        fork: members[0].fork, group: members[0].group, count: countOf(members),
        ...(members[0].notRead ? { notRead: true as const } : {}),
        objects: members.map(({ id, url, label, since, count }) => ({
          id, url, label, age: age(since, now), count: count ?? 1,
        })),
      })),
    };
  };
  const singular = (kind: "other" | "issue") =>
    [...grouped(objects[kind], ({ title }) => normalized(title))].flatMap(([key, entries]) => {
      const first = entries[0];
      if (!first) return [];
      const row = make(kind, `${kind}:${encodeURIComponent(key)}`, first.title, entries);
      return [{ row, oldest: Math.min(...entries.map(({ since }) => when(since))) }];
    });
  const rows: CanWaitCause[] = [];
  const hasRemainder = (kind: "release" | "dependabot") => remainders[kind].blocked || remainders[kind].waiting;
  if (objects.release.length || hasRemainder("release"))
    rows.push({ ...make("release", "release", "Release PRs", objects.release), place: "releases", remainder: remainders.release });
  if (objects.dependabot.length || hasRemainder("dependabot"))
    rows.push({ ...make("dependabot", "dependabot", "Dependabot PRs", objects.dependabot), packages: sharedPackages(objects.dependabot), remainder: remainders.dependabot });
  rows.push(...[...singular("other"), ...singular("issue")].sort((a, b) =>
    b.row.forkCount - a.row.forkCount || a.oldest - b.oldest || byName(a.row.id, b.row.id),
  ).map(({ row }) => row));
  if (objects.alert.length)
    rows.push({ ...make("alert", "alert", "Alerts in shipped code", objects.alert), place: "security",
      rules: topRules(objects.alert.filter(({ group }) => group === "fork")) });
  return { rows, notRead };
}
