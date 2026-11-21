// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityLaneId, SecurityList, SecurityPage, SecurityWords } from "./contract.js";
import { count, LANES, type SecurityInput, unreadList } from "./classify.js";
import { repositoryWords, securityBarMax, securityTallies, severeWords, word } from "./figure.js";

const LIST_WORDS: Readonly<Record<SecurityList, string>> = Object.freeze({
  dependabot: "Dependabot alerts",
  code: "code scanning alerts",
});

function totalsWords(input: SecurityInput): SecurityWords {
  const short = input.unread.length > 0;
  const n = input.alerts.length;
  if (n === 0) return [short ? "No open alerts in the lists read." : "No open alerts."];
  const by = (list: SecurityList, name: string): SecurityWords => {
    const k = input.alerts.filter((a) => a.list === list).length;
    return k === 0 ? [] : [count(k, unreadList(input, list)), ` ${name}`];
  };
  const dependabot = by("dependabot", "Dependabot");
  const code = by("code", "code scanning");
  return [
    count(n, short),
    ` open ${word(n, "alert")}: `,
    ...dependabot,
    ...(dependabot.length && code.length ? [", "] : []),
    ...code,
    ".",
  ];
}

function headlineWords(input: SecurityInput): SecurityWords {
  const short = input.unread.length > 0;
  const read = short ? " in the lists read" : "";
  const shipped = input.alerts.filter((a) => a.lane !== "tests");
  if (shipped.length === 0) return [`Nothing open in shipped code${read}.`];
  const critical = shipped.filter((a) => a.severity === "critical").length;
  const heavy = shipped.filter((a) => a.high).length;
  if (heavy === 0)
    return [
      count(shipped.length, short),
      ` ${word(shipped.length, "alert")} in shipped code, none high${read}.`,
    ];
  const lead = [
    ...severeWords(critical, heavy - critical, short),
    ` ${word(heavy, "alert")} in shipped code`,
  ];
  const ours = input.totals.spi.high.n;
  if (ours === 0) return [...lead, `, none in SPI code${read}.`];
  const rules = securityTallies(input, "spi");
  const [top] = rules;
  if (top && top.high > ours / 2 && rules.length > 1 && top.high > 1)
    return [
      ...lead,
      ". ",
      count(ours, short),
      " are ours to fix, ",
      count(top.high, short),
      ` from one ${top.list === "code" ? "rule" : "package"} in `,
      ...repositoryWords(input, top.repositories, short),
      ".",
    ];
  return [...lead, ". ", count(ours, short), ours === 1 ? " is ours to fix." : " are ours to fix."];
}

function unreadNames(input: SecurityInput, retained: boolean): SecurityWords {
  return input.unread.flatMap((entry, i): SecurityWords => [
    ...(i > 0 ? [", "] : []),
    entry.list ? `${LIST_WORDS[entry.list]} in ${entry.repository}` : entry.repository,
    ...(retained && entry.retained ? [" (counted from an earlier read)"] : []),
  ]);
}

function bannerWords(input: SecurityInput, end = ". Counts marked ≥ may be higher."): SecurityWords {
  if (input.unread.length === 0) return [];
  const lists = input.unread.reduce((n, entry) => n + (entry.list ? 1 : 2), 0);
  return [count(lists, false), ` ${word(lists, "list")} not read: `, ...unreadNames(input, true), end];
}

/** No list was read this sweep: the page says so and names each list, with no counts. */
export function securityUnreadPage(input: SecurityInput): Pick<SecurityPage, "headline" | "banner"> {
  return { headline: ["Security not read."], banner: bannerWords(input, ".") };
}

function opens(input: SecurityInput): SecurityLaneId {
  const has = (lane: SecurityLaneId) => input.totals[lane].total.n > 0;
  return (["spi", "upstream"] as const).find(has) ?? LANES.find(has) ?? "spi";
}

/** The line above the headline, the headline, the not-read banner and the lane the page opens on. */
export function securityPage(input: SecurityInput): SecurityPage {
  const short = input.unread.length > 0;
  return {
    totals: totalsWords(input),
    headline: headlineWords(input),
    banner: bannerWords(input),
    opens: opens(input),
    barMax: securityBarMax(input),
    stub: short ? ["Not read: ", ...unreadNames(input, false)] : [],
    legend: {
      high: "High or critical",
      rest: "Medium or low",
      ...(short ? { unread: "Not read" } : {}),
    },
  };
}
