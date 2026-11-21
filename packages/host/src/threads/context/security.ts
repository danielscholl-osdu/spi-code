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
import type { SpiRedactor } from "./redaction.js";
import { areaEnvelopes, NOT_READ, type ReadState, readState } from "./sweep.js";

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

/** The most of a scanner's title Copilot is told, ellipsis included, as characters and as UTF-8 bytes in JSON. */
export const TITLE_MAX_CHARS = 120;
export const TITLE_MAX_BYTES = 360;
const ELLIPSIS = "…";
const INVISIBLE = /(?![\t\n\v\f\r])[\p{Cc}\p{Cf}]/gu;
const encoded = (text: string) => Buffer.byteLength(JSON.stringify(text)) - 2;

/** Within the bound, cut at the last space it holds, or between characters when it holds none. */
function shortened(text: string): string {
  const chars = [...text];
  if (chars.length <= TITLE_MAX_CHARS && encoded(text) <= TITLE_MAX_BYTES) return text;
  let kept = 0;
  let bytes = encoded(ELLIPSIS);
  for (const char of chars) {
    if (kept === TITLE_MAX_CHARS - 1 || bytes + encoded(char) > TITLE_MAX_BYTES) break;
    bytes += encoded(char);
    kept += 1;
  }
  const head = chars.slice(0, kept).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}${ELLIPSIS}`;
}

/** The scanner's title redacted while it is whole, then put on one line and shortened. */
function titleOf(rule: SecurityRuleRow, redactor: SpiRedactor): string {
  let safe: unknown;
  try {
    safe = redactor.value(rule.title);
  } catch {
    throw new Error("Security title withheld.");
  }
  if (typeof safe !== "string") throw new Error("Security title withheld.");
  return shortened(safe.replace(INVISIBLE, "").replace(/\s+/g, " ").trim());
}

/** The help the collector cut, by its flag or, from a sweep before the flag, by the cut's ellipsis. */
const cutHelp = (rule: SecurityRuleRow) =>
  rule.cut || rule.opened.help?.endsWith(ELLIPSIS) ? rule.opened.help : undefined;

function ruleLine(rule: SecurityRuleRow, detail: boolean, redactor: SpiRedactor) {
  return {
    rule: rule.key,
    title: titleOf(rule, redactor),
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
export function paneReading(pane: SecurityPane | undefined, redactor: SpiRedactor, detail = false) {
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
    rules: pane.lanes.flatMap(({ byRule }) =>
      byRule.rules.map((rule) => ruleLine(rule, detail, redactor)),
    ),
  };
}

/** The area's envelope says when the sweep ran; whether Security was read is the pane's to say. */
export function securityState(view: ViewSnapshot): ReadState {
  const state = readState(areaEnvelopes(view, ["security"]));
  const pane = view.security;
  if (!pane)
    return { ...state, read: NOT_READ, notRead: [...new Set([...state.notRead, "security"])] };
  return {
    ...state,
    read: !pane.read ? NOT_READ : pane.unread.length > 0 ? "partly read" : "read",
  };
}

/** The pane's pointer for spi_evidence; a snapshot with no pane has nothing there. */
export const securityAt = (view: ViewSnapshot, at?: string) =>
  view.security ? (at ?? "/security") : undefined;

export const ruleSubject = (key: string) => `${SECURITY_RULE_SUBJECT}${key}`;

export function findRule(pane: SecurityPane | undefined, key: string) {
  for (const [index, lane] of (pane?.lanes ?? []).entries()) {
    const at = lane.byRule.rules.findIndex((rule) => rule.key === key);
    const rule = lane.byRule.rules[at];
    if (rule) return { lane, rule, at: `/security/lanes/${index}/byRule/rules/${at}` };
  }
  return undefined;
}

export const SECURITY_CAMPAIGN = "campaign:security:";
const FROM = "The campaign row this was started from is no longer drawn.";
const CAMPAIGN_FACT = /^([^\s:/\\?#]+(?: [^\s:/\\?#]+)*): ([^\s\\?#]+)$/u;
const NOT_A_PART: readonly string[] = Object.freeze([
  "",
  ".",
  "..",
  "__proto__",
  "constructor",
  "prototype",
]);

/** The `tool: rule` a campaign subject was saved with, read from the subject alone; undefined unless canonical. */
function campaignFact(id: string): string | undefined {
  const encoded = id.slice(SECURITY_CAMPAIGN.length);
  if (encoded.length === 0 || encoded.length > 512) return undefined;
  let fact: string;
  try {
    fact = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  if (encodeURIComponent(fact) !== encoded || /[\p{Cc}\p{Cf}]/u.test(fact)) return undefined;
  const [, tool, rule] = CAMPAIGN_FACT.exec(fact) ?? [];
  if (!tool || !rule) return undefined;
  const parts = [...tool.split(" "), ...rule.split(/[/:]/)];
  return parts.some((part) => NOT_A_PART.includes(part)) ? undefined : fact;
}

/** A code rule whose key ends in a campaign's `tool: rule` fact, in any lane. */
function campaignRules(pane: SecurityPane | undefined, fact: string) {
  return (pane?.lanes ?? []).flatMap((lane) =>
    lane.byRule.rules.flatMap((rule) => {
      const rest = rule.key.slice(`${lane.id}:code:`.length);
      const split = rule.key.startsWith(`${lane.id}:code:`)
        ? [...rest.matchAll(/:/g)].some(
            ({ index }) => `${rest.slice(0, index)}: ${rest.slice(index + 1)}` === fact,
          )
        : false;
      return split ? [rule.key] : [];
    }),
  );
}

/** A campaign subject saved before the pane: its one rule, or the page with the rules it now is. */
export function campaignReading(view: ViewSnapshot, id: string, redactor: SpiRedactor) {
  const fact = campaignFact(id);
  if (fact === undefined) return undefined;
  const keys = campaignRules(view.security, fact);
  const [only] = keys;
  const rule = only && keys.length === 1 ? findRule(view.security, only) : undefined;
  if (rule) return { rule: true, ...packed(rule, redactor, { from: FROM }) };
  const page = paneReading(view.security, redactor);
  return {
    rule: false,
    title: "Security",
    at: undefined,
    reading: { from: FROM, open: keys, ...(typeof page === "string" ? { reading: page } : page) },
  };
}

/** The same scanner and rule, or the same package, open in another lane. */
function elsewhere(pane: SecurityPane, key: string) {
  const rest = key.slice(key.indexOf(":"));
  return pane.lanes.flatMap((lane) => {
    const other = `${lane.id}${rest}`;
    return other === key ? [] : (findRule(pane, other) ?? []);
  });
}

/** One rule or package as its opened row draws it: its facts, its Where lines and the other bars. */
export function ruleReading(view: ViewSnapshot, key: string, redactor: SpiRedactor) {
  const pane = view.security;
  const found = findRule(pane, key);
  if (!found) {
    if (!pane?.read) return { title: key, at: undefined, reading: UNREAD };
    const others = elsewhere(pane, key);
    const [only] = others;
    const unread = pane.unread.length > 0;
    const was = pane.lanes.find(({ id }) => key.startsWith(`${id}:`))?.figure.label;
    if (only && others.length === 1)
      return packed(only, redactor, {
        moved:
          unread && was
            ? `Open in ${only.lane.figure.label} now; a list not read may still hold it in ${was}.`
            : `Open in ${only.lane.figure.label} now.`,
      });
    const lanes = others.map(({ lane }) => lane.figure.label).join(" and ");
    const open =
      others.length > 1 && was
        ? unread
          ? `Open in ${lanes} now; a list not read may still hold it in ${was}.`
          : `No open alert in ${was} this sweep; open in ${lanes}.`
        : unread
          ? "No open alert in the lists read this sweep; a list not read may still hold it."
          : "No open alert this sweep.";
    return {
      title: key,
      at: undefined,
      reading: {
        rule: key,
        open,
        ...(others.length > 1 ? { rules: others.map(({ rule }) => rule.key) } : {}),
      },
    };
  }
  return packed(found, redactor);
}

function packed(
  { lane, rule, at }: NonNullable<ReturnType<typeof findRule>>,
  redactor: SpiRedactor,
  note = {},
) {
  const { facts, where, also } = rule.opened;
  const advisories = facts.flatMap(({ advisories }) =>
    advisories
      ? [...advisories.preview, ...advisories.rest].map((advisory) => ({
          id: advisory.id,
          words: wordsText(advisory.words),
          fix: wordsText(advisory.fix),
        }))
      : [],
  );
  const help = cutHelp(rule);
  const told = facts.filter(({ words }) => help === undefined || !words.includes(help));
  const line = ruleLine(rule, true, redactor);
  return {
    title: line.title,
    at,
    reading: {
      lane: lane.id,
      label: lane.figure.label,
      who: lane.figure.who,
      ...note,
      ...line,
      facts: told.map(({ label, words }) => ({ label, words: wordsText(words) })),
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
