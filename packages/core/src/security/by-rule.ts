// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  SecurityByRule,
  SecurityCount,
  SecurityLaneId,
  SecurityList,
  SecurityRuleRow,
  SecurityTick,
  SecurityWords,
} from "./contract.js";
import { count, type SecurityAlert, type SecurityInput, unreadList } from "./classify.js";
import { newerVersion, SEVERITY_ORDER } from "../model/repos.js";

export type SecurityRuleHead = Omit<SecurityRuleRow, "opened">;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const COLUMNS = Object.freeze({ worst: "Worst", rule: "Rule or package", alerts: "Alerts", fix: "Fix and age" });
const STRIP_KEYS = "Arrow keys name a repository; Enter opens it.";
const OWNER = Object.freeze({ spi: "SPI", upstream: "upstream" });

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
const counted = (n: number, short: boolean, one: string, many?: string): SecurityWords => [
  count(n, short),
  ` ${plural(n, one, many)}`,
];
const join = (parts: SecurityWords[], by = " · "): SecurityWords =>
  parts.filter((part) => part.length > 0).flatMap((part, i) => (i === 0 ? part : [by, ...part]));
const rank = (alert: SecurityAlert) =>
  alert.severity ? SEVERITY_ORDER.indexOf(alert.severity) : SEVERITY_ORDER.length;
const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** "3 forks" when every repository is a fork, otherwise "3 repositories". */
function unit(input: SecurityInput, names: readonly string[], short: boolean): SecurityWords {
  const forks = names.every((name) => !input.repositories.find((r) => r.name === name)?.program);
  return forks
    ? counted(names.length, short, "fork")
    : counted(names.length, short, "repository", "repositories");
}

function severityWords(alerts: readonly SecurityAlert[], short: boolean): SecurityWords {
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const high = alerts.filter((a) => a.severity === "high").length;
  const heavy = critical + high;
  if (heavy === 0 || heavy === alerts.length) return [];
  const lead: SecurityWords =
    critical && high
      ? [count(critical, short), " critical and ", count(high, short), " high"]
      : critical
        ? [count(critical, short), " critical"]
        : [count(high, short), " high"];
  return [...lead, ", ", count(alerts.length - heavy, short), " lower"];
}

const advisoryOf = (alert: SecurityAlert) => alert.dependabot?.advisory ?? "";

/** Whose paths a tests-lane rule sits in: "SPI path", "upstream paths", "SPI and upstream paths", "SPI setting". */
function ownerWords(alerts: readonly SecurityAlert[]): SecurityWords {
  const paths = (["spi", "upstream"] as const).filter((owner) => alerts.some((a) => a.owner === owner));
  const files = new Set(alerts.filter((a) => a.owner !== "setting").map((a) => `${a.repository}:${a.path}`));
  const [only] = paths;
  return join([
    paths.length > 1 ? ["SPI and upstream paths"] : only ? [`${OWNER[only]} ${plural(files.size, "path")}`] : [],
    alerts.some((a) => a.owner === "setting") ? ["SPI setting"] : [],
  ]);
}

function sub(alerts: readonly SecurityAlert[], list: SecurityList, short: boolean): SecurityWords {
  const split = severityWords(alerts, short);
  const owner = alerts[0]?.lane === "tests" ? ownerWords(alerts) : [];
  if (list === "code") {
    const files = new Set(alerts.filter((a) => a.path).map((a) => `${a.repository}:${a.path}`)).size;
    const tool = alerts[0]?.code?.tool ?? "";
    return join([["Code scanning"], [tool], files ? counted(files, short, "file") : [], split, owner]);
  }
  const advisories = new Set(alerts.map(advisoryOf));
  const [only] = alerts;
  const named =
    advisories.size === 1 && only?.dependabot
      ? [only.dependabot.cve ?? only.dependabot.advisory]
      : counted(advisories.size, short, "advisory", "advisories");
  return join([["Dependabot"], split, named, owner]);
}

/** What patches the package: one version stated, several as a range, never the one to upgrade to. */
function fixWords(alerts: readonly SecurityAlert[], short: boolean): SecurityWords {
  const fixed = alerts.map((a) => a.dependabot?.fixed);
  const versions = [...new Set(fixed.filter((v): v is string => !!v))].sort((a, b) =>
    newerVersion(a, b) ? 1 : newerVersion(b, a) ? -1 : 0,
  );
  const [lowest] = versions;
  const highest = versions.at(-1);
  if (!lowest || !highest) return ["no patched version"];
  const advisories = new Set(alerts.map(advisoryOf)).size;
  return [
    ...(advisories > 1 ? [count(advisories, short), " advisories, "] : []),
    "first patched ",
    { code: lowest },
    ...(highest !== lowest ? [" to ", { code: highest }] : []),
    ...(fixed.some((v) => !v) ? [", some without"] : []),
  ];
}

function ageWords(alerts: readonly SecurityAlert[], now: Date, short: boolean): SecurityWords {
  const times = alerts.map((a) => Date.parse(a.createdAt)).filter((t) => !Number.isNaN(t));
  if (times.length === 0) return [];
  const days = Math.max(0, Math.floor((now.getTime() - Math.min(...times)) / DAY_MS));
  const fresh = times.filter((t) => now.getTime() - t < WEEK_MS).length;
  return join([
    [count(days, short), " d open"],
    fresh > 0 && fresh < alerts.length ? [count(fresh, short), " new this week"] : [],
  ]);
}

const dirOf = (path: string | undefined) => {
  const at = path?.lastIndexOf("/") ?? -1;
  return path && at >= 0 ? path.slice(0, at) : "";
};

function prWords(input: SecurityInput, alerts: readonly SecurityAlert[], short: boolean): SecurityWords {
  const name = alerts[0]?.dependabot?.package.toLowerCase();
  if (!name) return [];
  const open = input.repositories.reduce(
    (n, repository) =>
      n +
      repository.openPrs.filter(
        (pr) =>
          pr.package?.toLowerCase() === name &&
          alerts.some((a) => a.repository === repository.name && dirOf(a.path) === pr.dir),
      ).length,
    0,
  );
  const closed = new Set(alerts.flatMap((a) => (a.closedPr ? [a.closedPr.url] : []))).size;
  return join([
    open ? [...counted(open, short, "fix PR"), " open"] : [],
    closed ? [...counted(closed, short, "fix PR"), " closed unmerged"] : [],
  ]);
}

function ticks(input: SecurityInput, alerts: readonly SecurityAlert[], list: SecurityList): SecurityTick[] {
  return input.repositories.map(({ name, read }) => {
    const mine = alerts.filter((a) => a.repository === name);
    const high = mine.filter((a) => a.high).length;
    const tick = { repository: name, read: read[list], alerts: mine.length, high };
    if (mine.length === 0) return { ...tick, name: [`${name}: ${read[list] ? "none" : "not read"}`] };
    return {
      ...tick,
      name: [
        `${name} `,
        count(mine.length, !read[list]),
        ...(high && high < mine.length ? [", ", count(high, !read[list]), " high"] : []),
      ],
    };
  });
}

function row(input: SecurityInput, key: string, alerts: readonly SecurityAlert[]): SecurityRuleHead {
  const [first] = alerts;
  const list = first?.list ?? "code";
  const short = unreadList(input, list);
  const worst = [...alerts].sort((a, b) => rank(a) - rank(b))[0]?.severity;
  const strip = ticks(input, alerts, list);
  const held = strip.filter((t) => t.alerts > 0).sort((a, b) => b.alerts - a.alerts);
  const repositories = held.map((t) => t.repository);
  const title = (list === "code" ? first?.code?.description : first?.dependabot?.package) ?? key;
  const cut = alerts.some(
    ({ code }) =>
      code && (code.cut || code.description.endsWith("…") || code.fullDescription?.endsWith("…")),
  );
  const [top] = held;
  const spread: SecurityWords =
    held.length === 1 && top && !short
      ? [top.repository]
      : join([
          unit(input, repositories, short),
          !short && top && top.alerts > alerts.length / 2
            ? [count(top.alerts, false), ` in ${top.repository}`]
            : [],
        ]);
  const missed = strip.filter((t) => !t.read && t.alerts === 0).map((t) => t.repository);
  return {
    key,
    list,
    ...(worst ? { worst } : {}),
    severity: worst ? capital(worst) : "None",
    title,
    ...(cut ? { cut: true as const } : {}),
    sub: sub(alerts, list, short),
    ticks: strip,
    spread,
    strip: [
      `${title} by repository: `,
      ...join(
        held.map((t) => t.name),
        ", ",
      ),
      ...(missed.length ? [`; not read: ${missed.join(", ")}`] : []),
      `. ${STRIP_KEYS}`,
    ],
    alerts: count(alerts.length, short),
    high: alerts.filter((a) => a.high).length,
    fix: list === "dependabot" ? fixWords(alerts, short) : [],
    age: ageWords(alerts, input.now, short),
    prs: list === "dependabot" ? prWords(input, alerts, short) : [],
    repositories: input.repositories.filter((r) => repositories.includes(r.name)).map((r) => r.name),
  };
}

function summary(input: SecurityInput, alerts: readonly SecurityAlert[], rules: number): SecurityWords {
  const short = input.unread.length > 0;
  const of = (list: SecurityList) => alerts.filter((a) => a.list === list).length;
  const dependabot = of("dependabot");
  const code = of("code");
  const repositories = [...new Set(alerts.map((a) => a.repository))];
  return join([
    join(
      [
        dependabot ? [count(dependabot, unreadList(input, "dependabot")), " Dependabot"] : [],
        code ? [count(code, unreadList(input, "code")), " code scanning"] : [],
      ],
      ", ",
    ),
    [
      ...counted(rules, short, "rule or package", "rules and packages"),
      " in ",
      ...unit(input, repositories, short),
    ],
  ]);
}

const byOrder = (a: SecurityRuleHead, b: SecurityRuleHead) =>
  (a.worst ? SEVERITY_ORDER.indexOf(a.worst) : SEVERITY_ORDER.length) -
    (b.worst ? SEVERITY_ORDER.indexOf(b.worst) : SEVERITY_ORDER.length) ||
  b.high - a.high ||
  b.alerts.n - a.alerts.n ||
  a.title.localeCompare(b.title) ||
  a.key.localeCompare(b.key);

/** The chosen lane read by rule: its summary line and one row per rule or package. */
export function securityByRule(
  input: SecurityInput,
  lane: SecurityLaneId,
): Omit<SecurityByRule, "rules"> & { rules: SecurityRuleHead[] } {
  const alerts = input.alerts.filter((a) => a.lane === lane);
  const groups = new Map<string, SecurityAlert[]>();
  for (const alert of alerts) groups.set(alert.key, [...(groups.get(alert.key) ?? []), alert]);
  const rules = [...groups].map(([key, mine]) => row(input, key, mine)).sort(byOrder);
  const heading: SecurityCount = count(input.repositories.length, false);
  return {
    summary: rules.length ? summary(input, alerts, rules.length) : [],
    columns: COLUMNS,
    heading: [heading, ` ${plural(heading.n, "repository", "repositories")}`],
    tickMax: Math.max(0, ...rules.flatMap((r) => r.ticks.map((t) => t.alerts))),
    barMax: Math.max(0, ...rules.map((r) => r.alerts.n)),
    rules,
  };
}
