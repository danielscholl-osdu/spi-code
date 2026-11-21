// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  SecurityAdvisory,
  SecurityLaneId,
  SecurityList,
  SecurityOpenedRule,
  SecurityPill,
  SecurityWhere,
  SecurityWords,
} from "./contract.js";
import type { SecurityRuleHead } from "./by-rule.js";
import { count, LANES, type SecurityAlert, type SecurityInput, type SecurityRepository, unreadList } from "./classify.js";
import { compareVersions } from "../model/releases.js";
import { SEVERITY_ORDER } from "../model/repos.js";

const LIST_WORD = Object.freeze({ dependabot: "Dependabot alerts", code: "Code scanning alerts" });
const IN_LANE = Object.freeze({
  spi: "shipped SPI code",
  upstream: "shipped upstream code",
  tests: "tests, tooling and settings",
});
const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
/** A line or an advisory list longer than this is cut behind a disclosure. */
const FEW = 4;
const CWE_TAG = /^external\/cwe\/cwe-0*(\d+)$/i;

type Words = SecurityWords;

const exact = (n: number) => count(n, false);
const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
const rank = (alert: SecurityAlert) =>
  alert.severity ? SEVERITY_ORDER.indexOf(alert.severity) : SEVERITY_ORDER.length;
const severityWord = (alert: SecurityAlert) =>
  alert.severity ?? alert.code?.ruleSeverity ?? "no severity";
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const day = (at: string) => {
  const date = new Date(at);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
};
/** A deep path keeps its first two and last parts. */
const shortPath = (path: string) => {
  const parts = path.split("/");
  return parts.length > 4 ? [...parts.slice(0, 2), "…", ...parts.slice(-1)].join("/") : path;
};
/** Every path these words name is one an alert gives, whole. */
const whole = (words: Words, paths: readonly (string | undefined)[]) =>
  words.every((part) => typeof part === "string" || !("code" in part) || paths.includes(part.code));
const AS_WRITTEN = Object.freeze({ verbatim: true as const });
const byFile = (a: SecurityAlert, b: SecurityAlert) =>
  (a.path ?? "").localeCompare(b.path ?? "") || a.number - b.number;

function join(parts: readonly Words[], by = ", "): Words {
  return parts.flatMap((part, index) => (index === 0 ? part : [by, ...part]));
}

/** High or critical, in words that say critical only when one is. */
function heavyWords(alerts: readonly SecurityAlert[], atLeast: boolean): Words {
  const heavy = alerts.filter((alert) => alert.high);
  const critical = heavy.some((alert) => alert.severity === "critical");
  return [count(heavy.length, atLeast), critical ? " high or critical" : " high"];
}

function toolOf(alert: SecurityAlert) {
  return alert.code?.tool ?? "Dependabot";
}

function pill(repository: string, alert: SecurityAlert, withFile: boolean): SecurityPill {
  const advisory = alert.dependabot && (alert.dependabot.cve ?? alert.dependabot.advisory);
  const what = advisory ?? (withFile && alert.path ? basename(alert.path) : undefined);
  const head = `${toolOf(alert)} #${alert.number}`;
  const where = advisory
    ? `${advisory} in ${alert.path}`
    : (alert.path ?? "repository setting");
  return {
    label: what ? `${head} · ${what}` : head,
    url: alert.url,
    heavy: alert.high,
    name: `${repository}: ${head}, ${severityWord(alert)}, ${where}`,
  };
}

function prPills(repo: SecurityRepository, alerts: readonly SecurityAlert[]): SecurityPill[] {
  const [first] = alerts;
  const dependency = first?.dependabot;
  if (!first?.path || !dependency) return [];
  const dir = dirOf(first.path);
  const open = repo.openPrs
    .filter((pr) => pr.package?.toLowerCase() === dependency.package.toLowerCase() && pr.dir === dir)
    .map(({ pr, state, to }) => ({
      label: `PR #${pr.number} ${state}`,
      url: pr.url,
      heavy: false,
      name: `${repo.name}: PR #${pr.number}, ${state}${to ? `, to ${to}` : ""}, ${first.path}`,
    }));
  const closed = [...new Map(alerts.flatMap(({ closedPr }) => (closedPr ? [[closedPr.number, closedPr]] : []))).values()]
    .sort((a, b) => a.number - b.number)
    .map((pr) => ({
      label: `PR #${pr.number} closed`,
      url: pr.url,
      heavy: false,
      name: `${repo.name}: PR #${pr.number}, closed unmerged, ${first.path}`,
    }));
  return [...open, ...closed];
}

/** What patches one manifest's alerts, version by version, newest first. */
function patched(alerts: readonly SecurityAlert[], atLeast: boolean): Words {
  const byVersion = new Map<string, SecurityAlert[]>();
  const none = alerts.filter((alert) => !alert.dependabot?.fixed);
  for (const alert of alerts) {
    const fixed = alert.dependabot?.fixed;
    if (fixed) byVersion.set(fixed, [...(byVersion.get(fixed) ?? []), alert]);
  }
  const parts = [...byVersion]
    .sort(([a], [b]) => compareVersions(b, a))
    .map(([version, mine]): Words => {
      const lower = mine.filter((alert) => !alert.high).length;
      const heavy = mine.length > lower ? heavyWords(mine, atLeast) : [];
      const rest: Words = lower > 0 ? [count(lower, atLeast), " lower"] : [];
      return [{ code: version }, " for ", ...join([heavy, rest].filter((part) => part.length > 0), " and ")];
    });
  if (none.length > 0) parts.push(["none yet for ", count(none.length, atLeast)]);
  return ["first patched in ", ...join(parts)];
}

/** Paths, directories or files; from a list not read this sweep, every count is at least. */
function files(alerts: readonly SecurityAlert[], code: boolean, atLeast: boolean): Words {
  const paths = [...new Set(alerts.flatMap(({ path }) => (path ? [path] : [])))];
  if (paths.length === 0) return ["Repository setting"];
  if (!code || paths.length === 1) return paths.map((path) => ({ code: shortPath(path) }));
  if (alerts.length <= FEW) {
    const dirs = [...new Set(paths.map(dirOf))];
    const shown = dirs.slice(0, 2).map((dir): Words => [{ code: dir ? `${shortPath(dir)}/` : "/" }]);
    const more = dirs.length - shown.length;
    return [...join(shown), ...(more > 0 ? [" and ", count(more, atLeast), plural(more, " more directory", " more directories")] : [])];
  }
  const tally = paths
    .map((path) => [path, alerts.filter((alert) => alert.path === path).length] as const)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const times = (n: number): Words => (n < 2 ? [] : atLeast ? [" ×", count(n, true)] : [` ×${n}`]);
  const shown = tally.slice(0, 3).map(([path, n]): Words => [{ code: basename(path) }, ...times(n)]);
  const more = tally.length - shown.length;
  return [...join(shown), ...(more > 0 ? [" and ", count(more, atLeast), plural(more, " more file")] : [])];
}

function where(
  input: SecurityInput,
  alerts: readonly SecurityAlert[],
  list: SecurityList,
): SecurityWhere[] {
  const code = list === "code";
  const manifests = (mine: readonly SecurityAlert[]) =>
    code
      ? mine.length > 0
        ? [mine]
        : []
      : [...new Set(mine.map(({ path }) => path))].sort().map((path) => mine.filter((alert) => alert.path === path));
  const patches = code
    ? new Set<string>()
    : new Set(
        input.repositories.flatMap((repo) =>
          manifests(alerts.filter((alert) => alert.repository === repo.name)).map((group) =>
            JSON.stringify(patched(group, false)),
          ),
        ),
      );
  const held = input.repositories
    .map((repo) => ({ repo, mine: alerts.filter((alert) => alert.repository === repo.name).sort(byFile) }))
    .filter(({ repo, mine }) => mine.length > 0 || !repo.read[list])
    .sort((a, b) => b.mine.length - a.mine.length || a.repo.name.localeCompare(b.repo.name));
  return held.flatMap(({ repo, mine }) => {
    const read = repo.read[list];
    const lines = manifests(mine).map((group, index): SecurityWhere => {
      const several = new Set(group.map(({ path }) => path)).size > 1;
      const heavy = mine.filter((alert) => alert.high).length;
      const shown = files(group, code, !read);
      return {
        repository: repo.name,
        first: index === 0,
        read: true,
        count:
          index > 0
            ? []
            : [count(mine.length, !read), ...(heavy > 0 && heavy < mine.length ? [", ", ...heavyWords(mine, !read)] : [])],
        files: shown,
        needs: patches.size > 1 ? patched(group, !read) : [],
        alerts: group.map((alert) => pill(repo.name, alert, several)),
        prs: prPills(repo, group),
        ...(whole(shown, group.map(({ path }) => path)) ? AS_WRITTEN : {}),
        ...(group.length > FEW ? { more: `${group.length} ${toolOf(group[0] as SecurityAlert)} alerts` } : {}),
      };
    });
    if (read) return lines;
    const retained = mine.length > 0;
    return [
      ...lines,
      {
        repository: repo.name,
        first: !retained,
        read: false,
        count: [],
        files: [retained ? `${LIST_WORD[list]} not read this sweep; those shown are from the last read` : `${LIST_WORD[list]} not read`],
        needs: [],
        alerts: [],
        prs: [],
        ...AS_WRITTEN,
      },
    ];
  });
}

function advisories(alerts: readonly SecurityAlert[], short: boolean) {
  const byId = new Map<string, SecurityAlert[]>();
  for (const alert of alerts) {
    const id = alert.dependabot?.advisory;
    if (id) byId.set(id, [...(byId.get(id) ?? []), alert]);
  }
  const list = [...byId.values()]
    .map((mine) => ({ mine, worst: Math.min(...mine.map(rank)) }))
    .sort(
      (a, b) =>
        a.worst - b.worst ||
        b.mine.length - a.mine.length ||
        (a.mine[0]?.number ?? 0) - (b.mine[0]?.number ?? 0),
    )
    .map(({ mine }): SecurityAdvisory => {
      const [first] = [...mine].sort((a, b) => rank(a) - rank(b));
      const fact = first?.dependabot;
      const fixes = [...new Set(mine.flatMap((alert) => alert.dependabot?.fixed ?? []))].sort(compareVersions);
      return {
        ...(fact && fact.summary === fact.summary.trim() ? AS_WRITTEN : {}),
        id: fact?.cve ?? fact?.advisory ?? "",
        words: [`${capital(first ? severityWord(first) : "")}. `, fact?.summary.trim() ?? ""],
        fix: [
          ...(fixes.length === 0
            ? ["no patched version yet"]
            : ["first patched in ", ...join(fixes.map((version): Words => [{ code: version }]), " or ")]),
          ...(mine.length > 1 ? [", ", count(mine.length, short), " alerts"] : []),
        ],
      };
    });
  const rest = list.slice(FEW);
  const [head, ...others] = list.slice(0, FEW);
  if (!head) return undefined;
  return {
    preview: [head, ...others],
    rest,
    ...(rest.length > 0
      ? {
          disclosure: {
            more: [exact(rest.length), plural(rest.length, " more advisory", " more advisories")],
            fewer: ["Fewer advisories"],
          },
        }
      : {}),
  };
}

type Scanner = Pick<SecurityOpenedRule, "help" | "cwe">;

/** Whether the help scanner() takes is that alert's full_description byte for byte. */
const helpVerbatim = (alerts: readonly SecurityAlert[]) =>
  alerts.find((alert) => alert.code?.fullDescription)?.code?.verbatim === true;

/** A code rule's help and CWE, each from the first alert that carries it: retained alerts may predate both. */
function scanner(alerts: readonly SecurityAlert[]): Scanner {
  const help = alerts.find((alert) => alert.code?.fullDescription)?.code?.fullDescription;
  const cwe = alerts
    .map((alert) => [
      ...new Set((alert.code?.tags ?? []).flatMap((tag) => {
        const id = CWE_TAG.exec(tag)?.[1];
        return id ? [`CWE-${id}`] : [];
      })),
    ])
    .find((ids) => ids.length > 0);
  return { ...(help ? { help } : {}), ...(cwe ? { cwe: cwe.join(", ") } : {}) };
}

function facts(
  input: SecurityInput,
  alerts: readonly SecurityAlert[],
  short: boolean,
  { help, cwe }: Scanner,
): SecurityOpenedRule["facts"] {
  const [first] = alerts;
  const out: SecurityOpenedRule["facts"] = [];
  if (help) out.push({ label: "What it is", words: [help], ...(helpVerbatim(alerts) ? AS_WRITTEN : {}) });
  if (first?.code)
    out.push({ label: "Rule", words: [{ code: first.code.rule }, ` · ${first.code.tool}`, ...(cwe ? [` · ${cwe}`] : [])], ...AS_WRITTEN });
  if (first?.dependabot) {
    out.push({ label: "Package", words: [{ code: first.dependabot.package }, ` · ${first.dependabot.ecosystem}`], ...AS_WRITTEN });
    const body = advisories(alerts, short);
    if (body) out.push({ label: body.preview.length + body.rest.length === 1 ? "Advisory" : "Advisories", words: [], advisories: body, ...AS_WRITTEN });
  }
  const times = alerts.map(({ createdAt }) => createdAt).sort();
  const [since] = times;
  const newest = times.at(-1);
  if (since && newest)
    out.push({
      label: "Open since",
      words: [
        day(since),
        ...(day(newest) === day(since) ? [] : [", newest ", day(newest)]),
        ...(short ? [" in the lists read"] : []),
      ],
      ...AS_WRITTEN,
    });
  if (first?.code) {
    const spots = [...new Set(alerts.map(({ repository, path }) => `${repository}\n${path ?? ""}`))]
      .map((spot) => {
        const [repository = "", path = ""] = spot.split("\n");
        return { repository, path, n: alerts.filter((a) => a.repository === repository && (a.path ?? "") === path).length };
      })
      .filter(({ path, n }) => path && n >= 3 && n >= alerts.length / 5)
      .sort((a, b) => b.n - a.n || a.repository.localeCompare(b.repository) || a.path.localeCompare(b.path))
      .slice(0, 2);
    const unread = (name: string) => !input.repositories.find((repo) => repo.name === name)?.read.code;
    if (spots.length > 0) {
      const words = join(
        spots.map(({ repository, path, n }): Words => [{ code: basename(path) }, ` in ${repository}, `, count(n, unread(repository)), " alerts"]),
        " · ",
      );
      out.push({
        label: short ? "Most in lists read" : "Most in",
        words,
        ...(whole(words, spots.map(({ path }) => path)) ? AS_WRITTEN : {}),
      });
    }
  }
  return out;
}

/** An opened rule or package: its facts, where it sits by repository and file, and its pills. */
export function securityOpenedRule(input: SecurityInput, rule: SecurityRuleHead): SecurityOpenedRule {
  const lane = rule.key.slice(0, rule.key.indexOf(":")) as SecurityLaneId;
  const list: SecurityList = rule.key.startsWith(`${lane}:dep:`) ? "dependabot" : "code";
  const short = unreadList(input, list);
  const alerts = input.alerts.filter(({ key }) => key === rule.key);
  const also = LANES.filter((other) => other !== lane).flatMap((other) => {
    const key = `${other}${rule.key.slice(lane.length)}`;
    const n = input.alerts.filter((alert) => alert.key === key).length;
    return n > 0 ? [{ key, words: ["Also: ", count(n, short), ` in ${IN_LANE[other]}`] }] : [];
  });
  const repositories = [...new Set(alerts.map(({ repository }) => repository))];
  const [only] = repositories;
  const fork = only && input.repositories.find((repo) => repo.name === only && !repo.program);
  const scanned = list === "code" ? scanner(alerts) : {};
  return {
    facts: facts(input, alerts, short, scanned),
    ...scanned,
    where: where(input, alerts, list),
    also,
    ...(repositories.length === 1 && fork && !short ? { ask: { fork: fork.name } } : {}),
  };
}
