// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  SecurityByRepository,
  SecurityLaneId,
  SecurityList,
  SecurityPill,
  SecurityRepoRow,
  SecurityRepoRule,
  SecurityWords,
} from "./contract.js";
import { count, type SecurityAlert, type SecurityInput, type SecurityRepository } from "./classify.js";
import { SEVERITY_ORDER } from "../model/repos.js";

const COLUMNS = Object.freeze({ repository: "Repository", alerts: "Alerts", top: "Top rules and packages" });
const LANE_WORDS: Readonly<Record<SecurityLaneId, string>> = Object.freeze({
  spi: "shipped SPI code",
  upstream: "shipped upstream code",
  tests: "tests, tooling and settings",
});
const LIST_WORDS: Readonly<Record<SecurityList, string>> = Object.freeze({
  dependabot: "Dependabot",
  code: "code scanning",
});
const TOP_RULES = 2;
const BY_FILE_OVER = 6;
const FILE_PILLS_UP_TO = 4;
const CLEAN_NAMES_UP_TO = 8;
const CLEAN_SHOWN = 6;

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);
const listOf = (key: string): SecurityList => (key.split(":")[1] === "dep" ? "dependabot" : "code");
const rank = (alert: SecurityAlert) =>
  alert.severity ? SEVERITY_ORDER.indexOf(alert.severity) : SEVERITY_ORDER.length;
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const capital = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);
const plain = (title: string) => title.replaceAll("`", "");

/** A scanner's title, its backticked words as code. */
const titleWords = (title: string): SecurityWords =>
  title
    .split("`")
    .flatMap((part, i): SecurityWords => (part === "" ? [] : i % 2 ? [{ code: part }] : [part]));

const toolOf = (alert: SecurityAlert) => alert.code?.tool ?? "Dependabot";
const whatOf = (alert: SecurityAlert) =>
  alert.code ? (alert.path ? baseName(alert.path) : "repository setting") : (alert.dependabot?.cve ?? alert.dependabot?.advisory ?? "");

function pill(alert: SecurityAlert, underFile: boolean): SecurityPill {
  const mark = `${toolOf(alert)} #${alert.number}`;
  const what = whatOf(alert);
  return {
    label: underFile || !what ? mark : `${mark} · ${what}`,
    url: alert.url,
    heavy: alert.high,
    name: [
      `${mark} in ${alert.repository}`,
      alert.severity ? `, ${alert.severity}` : "",
      alert.path ? `: ${alert.path}` : what ? `: ${what}` : "",
    ].join(""),
  };
}

const bySeverity = (a: SecurityAlert, b: SecurityAlert) => rank(a) - rank(b) || a.number - b.number;

function filesOf(alerts: readonly SecurityAlert[], short: boolean): SecurityRepoRule["files"] {
  const by = new Map<string, SecurityAlert[]>();
  for (const alert of alerts) by.set(alert.path ?? "", [...(by.get(alert.path ?? "") ?? []), alert]);
  return [...by]
    .sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))
    .map(([path, mine]) => {
      const pills = [...mine].sort((a, b) => a.number - b.number).map((alert) => pill(alert, true));
      const tool = mine[0] ? toolOf(mine[0]) : "";
      return {
        path,
        words: path ? [{ code: baseName(path) }] : ["repository setting"],
        alerts: pills,
        ...(mine.length > FILE_PILLS_UP_TO
          ? { more: [count(mine.length, short), ` ${tool} ${plural(mine.length, "alert")}`] }
          : {}),
      };
    });
}

function ruleOf(
  repository: SecurityRepository,
  key: string,
  alerts: readonly SecurityAlert[],
): SecurityRepoRule {
  const [first] = alerts;
  const list = listOf(key);
  const short = !repository.read[list];
  const title = (list === "code" ? first?.code?.description : first?.dependabot?.package) ?? key;
  const high = alerts.filter((a) => a.high).length;
  const critical = alerts.some((a) => a.severity === "critical");
  const n = count(alerts.length, short);
  const byFile = list === "code" && alerts.length > BY_FILE_OVER;
  return {
    key,
    title,
    words: [
      n,
      ` ${plural(alerts.length, "alert")}`,
      ...(high > 0 && high < alerts.length
        ? [", ", count(high, short), critical ? " high or critical" : " high"]
        : []),
    ],
    name: [`Open ${plain(title)} in By rule: `, n, ` ${plural(alerts.length, "alert")} in ${repository.name}`],
    alerts: byFile ? [] : [...alerts].sort(bySeverity).map((alert) => pill(alert, false)),
    files: byFile ? filesOf(alerts, short) : [],
  };
}

function severityWords(alerts: readonly SecurityAlert[], short: boolean): SecurityWords {
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const high = alerts.filter((a) => a.severity === "high").length;
  if (critical && high) return [count(critical, short), " critical and ", count(high, short), " high"];
  if (critical) return [count(critical, short), " critical"];
  if (high) return [count(high, short), " high"];
  return [];
}

function missedWords(repository: SecurityRepository): string {
  const missed = (["dependabot", "code"] as const).filter((list) => !repository.read[list]);
  return missed.map((list) => LIST_WORDS[list]).join(" and ");
}

function moreWords(rules: readonly SecurityRepoRule[], short: boolean): SecurityWords {
  const rest = rules.slice(TOP_RULES);
  if (rest.length === 0) return [];
  const packages = rest.filter((r) => listOf(r.key) === "dependabot").length;
  const noun = short
    ? "rules and packages"
    : packages === 0
      ? plural(rest.length, "rule")
      : packages === rest.length
        ? plural(rest.length, "package")
        : "rules and packages";
  return [count(rest.length, short), ` more ${noun}`];
}

function topWords(rules: readonly SecurityRepoRule[], read: boolean): SecurityWords {
  const named = rules
    .slice(0, TOP_RULES)
    .flatMap((r, i): SecurityWords => [...(i > 0 ? [" · "] : []), ...titleWords(r.title), " ", r.words[0] ?? ""]);
  const more = moreWords(rules, !read);
  const parts: SecurityWords[] = [named, more, read ? [] : [rules.length ? "from the lists read" : "none in the lists read"]];
  return parts.filter((p) => p.length > 0).flatMap((p, i) => (i > 0 ? [" · ", ...p] : p));
}

function unreadLine(input: SecurityInput, repository: SecurityRepository): SecurityWords {
  const entry = input.unread.find((u) => u.repository === repository.name);
  const words = `${capital(missedWords(repository))} alerts not read this sweep`;
  return [entry?.retained ? `${words}; counted from an earlier read.` : `${words}.`];
}

function rowOf(input: SecurityInput, repository: SecurityRepository, lane: SecurityLaneId): SecurityRepoRow {
  const read = repository.read.dependabot && repository.read.code;
  const mine = input.alerts.filter((a) => a.repository === repository.name);
  const here = mine.filter((a) => a.lane === lane);
  const groups = new Map<string, SecurityAlert[]>();
  for (const alert of here) groups.set(alert.key, [...(groups.get(alert.key) ?? []), alert]);
  const rules = [...groups]
    .map(([key, alerts]) => ({ rule: ruleOf(repository, key, alerts), alerts }))
    .sort(
      (a, b) =>
        b.alerts.length - a.alerts.length ||
        b.alerts.filter((x) => x.high).length - a.alerts.filter((x) => x.high).length ||
        a.rule.title.localeCompare(b.rule.title) ||
        a.rule.key.localeCompare(b.rule.key),
    )
    .map(({ rule }) => rule);
  const of = (list: SecurityList) => mine.filter((a) => a.list === list).length;
  const total = count(mine.length, !read);
  const missed = read ? "" : `${missedWords(repository)} not read`;
  const split = severityWords(here, !read);
  return {
    repository: repository.name,
    program: repository.program,
    url: repository.url,
    read,
    alerts: count(here.length, !read),
    high: here.filter((a) => a.high).length,
    sub: [...split, ...(split.length && missed ? [" · "] : []), ...(missed ? [missed] : [])],
    page: [total, " open overall"],
    pageName: [
      total,
      " open overall: ",
      count(of("dependabot"), !repository.read.dependabot),
      " Dependabot, ",
      count(of("code"), !repository.read.code),
      " code scanning",
    ],
    top: topWords(rules, read),
    rules,
    unread: read ? [] : unreadLine(input, repository),
  };
}

function cleanWords(lane: SecurityLaneId, names: readonly string[]): SecurityWords {
  return names.length ? [`Nothing open in ${LANE_WORDS[lane]}: ${names.join(", ")}`] : [];
}

/** The chosen lane read by repository: a row per repository with alerts, and the ones with nothing. */
export function securityByRepository(input: SecurityInput, lane: SecurityLaneId): SecurityByRepository {
  const empty = { columns: COLUMNS, barMax: 0, rows: [], clean: [] };
  if (!input.alerts.some((a) => a.lane === lane)) return empty;
  const all = input.repositories.map((repository) => rowOf(input, repository, lane));
  const rows = all
    .filter((row) => row.alerts.n > 0 || !row.read)
    .sort(
      (a, b) =>
        b.alerts.n - a.alerts.n || b.high - a.high || a.repository.localeCompare(b.repository),
    );
  const clean = all.filter((row) => row.alerts.n === 0 && row.read).map((row) => row.repository);
  const rest = clean.length - CLEAN_SHOWN;
  return {
    columns: COLUMNS,
    barMax: Math.max(0, ...rows.map((row) => row.alerts.n)),
    rows,
    clean: cleanWords(lane, clean),
    ...(clean.length > CLEAN_NAMES_UP_TO
      ? {
          cleanShort: {
            words: [`Nothing open in ${LANE_WORDS[lane]}: ${clean.slice(0, CLEAN_SHOWN).join(", ")} and `],
            more: [count(rest, false), " more"],
          },
        }
      : {}),
  };
}
