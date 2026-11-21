// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  SECURITY_RULE_SUBJECT,
  type SecurityCount,
  type SecurityLane,
  type SecurityPane,
  type SecurityRuleRow,
  type SecurityWords,
  type ViewSnapshot,
} from "@spi-code/contracts";
import { NOT_READ } from "./sweep.js";

/** What a Security chip may hold, so it travels with seven others in a message. */
export const SECURITY_CHIP_BYTE_BUDGET = 2000;
export const SECURITY_TOOL = "spi_security";
const UNREAD: typeof NOT_READ = NOT_READ;

/** The page's words as it draws them: a count an unread list could change carries ≥. */
export const wordsText = (words: SecurityWords) =>
  words
    .map((part) =>
      typeof part === "string"
        ? part
        : "code" in part
          ? part.code
          : `${part.atLeast ? "≥" : ""}${part.n}`,
    )
    .join("");

const counted = (count: SecurityCount) => wordsText([count]);
const said = (key: string, words: SecurityWords) =>
  words.length > 0 ? { [key]: wordsText(words) } : {};

/** Each list the pane did not read, in the banner's words. */
export function unreadLists(pane: SecurityPane | undefined): string[] {
  return (pane?.unread ?? []).map(({ repository, list }) =>
    list === undefined
      ? `Dependabot and code scanning alerts in ${repository}`
      : `${list === "dependabot" ? "Dependabot" : "code scanning"} alerts in ${repository}`,
  );
}

function ruleLine(rule: SecurityRuleRow, detail: boolean) {
  return {
    rule: rule.key,
    title: rule.title,
    worst: rule.severity,
    ...(detail ? said("sub", rule.sub) : {}),
    alerts: counted(rule.alerts),
    ...said("spread", rule.spread),
    ...said("fix", rule.fix),
    ...said("age", rule.age),
    ...(detail ? said("prs", rule.prs) : {}),
  };
}

const laneLine = (lane: SecurityLane) => ({
  lane: lane.id,
  label: lane.figure.label,
  who: lane.figure.who,
  alerts: counted(lane.total),
  ...said("high", lane.figure.high),
  ...said("empty", lane.figure.empty),
});

/** The Security page as the pane draws it: totals, headline, banner, the three bars and By rule. */
export function paneReading(pane: SecurityPane | undefined, detail = false) {
  if (!pane) return UNREAD;
  const head = {
    ...said("totals", pane.page.totals),
    ...said("headline", pane.page.headline),
    ...said("banner", pane.page.banner),
  };
  if (!pane.read) return head;
  return {
    ...head,
    lanes: pane.lanes.map(laneLine),
    rules: pane.lanes.flatMap(({ byRule }) => byRule.rules.map((rule) => ruleLine(rule, detail))),
  };
}

export const ruleSubject = (key: string) => `${SECURITY_RULE_SUBJECT}${key}`;

export function findRule(pane: SecurityPane | undefined, key: string) {
  for (const [index, lane] of (pane?.lanes ?? []).entries()) {
    const at = lane.byRule.rules.findIndex((rule) => rule.key === key);
    const rule = lane.byRule.rules[at];
    if (rule) return { lane, rule, at: `/security/lanes/${index}/byRule/rules/${at}` };
  }
  return undefined;
}

/** One rule or package as its opened row draws it: its facts, its Where lines and the other bars. */
export function ruleReading(view: ViewSnapshot, key: string) {
  const pane = view.security;
  const found = findRule(pane, key);
  if (!found) {
    if (!pane?.read) return { title: key, at: undefined, reading: UNREAD };
    const open =
      pane.unread.length > 0
        ? "No open alert in the lists read this sweep; a list not read may still hold it."
        : "No open alert this sweep.";
    return { title: key, at: undefined, reading: { rule: key, open } };
  }
  const { lane, rule, at } = found;
  const { facts, where, also, help, cwe } = rule.opened;
  const advisories = facts.flatMap(({ advisories }) =>
    advisories
      ? [...advisories.preview, ...advisories.rest].map((advisory) => ({
          id: advisory.id,
          words: wordsText(advisory.words),
          fix: wordsText(advisory.fix),
        }))
      : [],
  );
  return {
    title: rule.title,
    at,
    reading: {
      lane: lane.id,
      label: lane.figure.label,
      who: lane.figure.who,
      ...ruleLine(rule, true),
      facts: facts.map(({ label, words }) => ({ label, words: wordsText(words) })),
      ...(help === undefined ? {} : { help }),
      ...(cwe === undefined ? {} : { cwe }),
      ...(also.length > 0 ? { also: also.map(({ words }) => wordsText(words)) } : {}),
      where: where.map((line) => ({
        repository: line.repository,
        ...(line.read ? {} : { read: false }),
        ...said("count", line.count),
        ...said("files", line.files),
        ...said("needs", line.needs),
        ...(line.prs.length > 0 ? { prs: line.prs.map(({ label }) => label) } : {}),
      })),
      ...(advisories.length > 0 ? { advisories } : {}),
    },
  };
}
