// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  SecurityBlock,
  SecurityFigure,
  SecurityLaneId,
  SecurityList,
  SecurityWords,
} from "./contract.js";
import { count, LANES, type SecurityAlert, type SecurityInput, unreadList } from "./classify.js";

const LANE_WORDS: Readonly<Record<SecurityLaneId, { label: string; who: string }>> = Object.freeze({
  spi: { label: "Shipped SPI code", who: "Ours to fix" },
  upstream: { label: "Shipped upstream code", who: "Upstream’s to fix, the fix arrives by sync" },
  tests: { label: "Tests, tooling and settings", who: "Not in the running service" },
});

/** A rule or package gets a block of its own at this share of the longest lane or more. */
const OWN_BLOCK = 0.04;

const SEVERITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 } as const);

/** One rule or package in a lane, counted from its alerts. */
export interface SecurityTally {
  key: string;
  list: SecurityList;
  title: string;
  alerts: number;
  high: number;
  critical: number;
  /** Rank of its worst severity: 0 critical to 4 none. */
  worst: number;
  repositories: string[];
}

export const word = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

const titleOf = (alert: SecurityAlert) =>
  alert.code
    ? alert.code.description.replaceAll("`", "")
    : (alert.dependabot?.package.split(":").pop() ?? alert.key);

/** A lane's rules and packages in By rule's order: worst severity, then high or critical, then alerts. */
export function securityTallies(input: SecurityInput, lane: SecurityLaneId): SecurityTally[] {
  const tallies = new Map<string, SecurityTally>();
  for (const alert of input.alerts) {
    if (alert.lane !== lane) continue;
    const tally = tallies.get(alert.key) ?? {
      key: alert.key,
      list: alert.list,
      title: titleOf(alert),
      alerts: 0,
      high: 0,
      critical: 0,
      worst: 4,
      repositories: [],
    };
    tally.alerts += 1;
    if (alert.high) tally.high += 1;
    if (alert.severity === "critical") tally.critical += 1;
    if (alert.severity) tally.worst = Math.min(tally.worst, SEVERITY_RANK[alert.severity]);
    if (!tally.repositories.includes(alert.repository)) tally.repositories.push(alert.repository);
    tallies.set(alert.key, tally);
  }
  return [...tallies.values()].sort(
    (a, b) =>
      a.worst - b.worst ||
      b.high - a.high ||
      b.alerts - a.alerts ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/** The longest lane's alerts: the one scale the three bars share. */
export const securityBarMax = (input: SecurityInput) =>
  Math.max(0, ...LANES.map((lane) => input.totals[lane].total.n));

/** "N forks" when every repository is a fork, "N repositories" otherwise. */
export function repositoryWords(
  input: SecurityInput,
  names: readonly string[],
  atLeast: boolean,
): SecurityWords {
  const program = new Set(input.repositories.filter((r) => r.program).map((r) => r.name));
  const forks = names.every((name) => !program.has(name));
  const n = names.length;
  return [count(n, atLeast), " ", forks ? word(n, "fork") : word(n, "repository", "repositories")];
}

function severityWords(high: number, n: number, atLeast: boolean): SecurityWords {
  if (high === 0) return ["none high"];
  if (high < n) return [count(high, atLeast), " high or critical"];
  return [n === 1 ? "high or critical" : "all high or critical"];
}

const byKey = (a: SecurityTally, b: SecurityTally) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function blocksOf(input: SecurityInput, lane: SecurityLaneId): SecurityBlock[] {
  const max = securityBarMax(input);
  const short = input.totals[lane].total.atLeast;
  const segs = securityTallies(input, lane).sort(
    (a, b) => b.alerts - a.alerts || b.high - a.high || byKey(a, b),
  );
  let own = segs.filter((t) => t.alerts / max >= OWN_BLOCK || (lane === "spi" && t.high > 0));
  if (segs.length - own.length === 1) own = segs;
  const rest = segs
    .filter((t) => !own.includes(t))
    .sort((a, b) => b.high / b.alerts - a.high / a.alerts || b.alerts - a.alerts || byKey(a, b));
  const blocks: SecurityBlock[] = own.map((t) => {
    const ruleShort = unreadList(input, t.list);
    return {
      rules: [t.key],
      alerts: count(t.alerts, ruleShort),
      high: t.high,
      dividers: [],
      name: [
        t.title,
        ": ",
        count(t.alerts, ruleShort),
        ` ${word(t.alerts, "alert")}, `,
        ...severityWords(t.high, t.alerts, ruleShort),
        ", in ",
        ...repositoryWords(input, t.repositories, ruleShort),
      ],
    };
  });
  if (rest.length === 0) return blocks;
  const n = rest.reduce((sum, t) => sum + t.alerts, 0);
  const high = rest.reduce((sum, t) => sum + t.high, 0);
  let at = 0;
  const dividers = rest.slice(0, -1).map((t) => {
    at += t.alerts;
    return at / n;
  });
  const each = rest.flatMap((t, i): SecurityWords => [
    ...(i > 0 ? [", "] : []),
    `${t.title} `,
    count(t.alerts, unreadList(input, t.list)),
  ]);
  blocks.push({
    rules: rest.map((t) => t.key),
    alerts: count(n, short),
    high,
    dividers,
    name: [
      count(rest.length, short),
      " more rules and packages: ",
      count(n, short),
      ` ${word(n, "alert")}, `,
      ...severityWords(high, n, short),
      ". ",
      ...each,
    ],
  });
  return blocks;
}

/** How many of a set of alerts are critical and high, in words: "2 critical and 22 high". */
export function severeWords(critical: number, high: number, atLeast: boolean): SecurityWords {
  if (critical > 0 && high > 0)
    return [count(critical, atLeast), " critical and ", count(high, atLeast), " high"];
  return critical > 0 ? [count(critical, atLeast), " critical"] : [count(high, atLeast), " high"];
}

/** A lane's bar on the page's one scale: its name, subtitle, high count and blocks. */
export function securityFigure(input: SecurityInput, lane: SecurityLaneId): SecurityFigure {
  const { total, high } = input.totals[lane];
  const critical = input.alerts.filter((a) => a.lane === lane && a.severity === "critical").length;
  const highWords: SecurityWords =
    total.n === 0
      ? []
      : high.n === 0
        ? ["none high"]
        : severeWords(critical, high.n - critical, high.atLeast);
  return {
    ...LANE_WORDS[lane],
    high: highWords,
    blocks: total.n === 0 ? [] : blocksOf(input, lane),
    empty: total.n > 0 ? [] : [total.atLeast ? "Nothing open in the lists read" : "Nothing open"],
  };
}
