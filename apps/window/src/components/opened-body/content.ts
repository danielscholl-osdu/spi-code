// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  FocusItem,
  Link,
  RepoLine,
  TodayDeadline,
  TodayLine,
  TodayMember,
  TodaySummary,
} from "@spi-code/contracts";
import { bridgeOpens } from "../../app/external-links.js";
import type { Destination, EvidenceSelection, OpenSelection } from "../../app/navigation.js";

export type BodyPlace = {
  label: string;
  destination: Destination;
  selection?: OpenSelection;
};

/** The shared reading; place callers supply their own non-member state and source links. */
export type OpenedContent = {
  title: string;
  place: BodyPlace;
  subject: EvidenceSelection | null;
  section?: TodayLine["section"];
  cause?: string;
  effect?: string;
  steps?: readonly string[];
  deadline?: TodayDeadline;
  primary?: Link;
  fork?: string;
  /** The one fork the subject belongs to, which a thread about it is scoped to. */
  scope?: string;
  links?: readonly Link[];
  notRead?: readonly string[];
};

/** Keep core's ordering and membership; raw items only supply the single step and further sources. */
export function todayContent({
  line,
  member,
  items,
  place,
  links = [],
}: {
  line: TodayLine;
  member?: TodayMember;
  items: readonly FocusItem[];
  place: BodyPlace;
  /** Companion or place-specific links already resolved by the caller. */
  links?: readonly Link[];
}): OpenedContent {
  const one = member ?? (line.members.length === 1 && !line.rollout ? line.members[0] : undefined);
  const rollout = !member && line.rollout ? items.find(({ id }) => id === "rollout") : undefined;
  const members = one ? [one] : line.members;
  const lead = members[0];
  const blockers = new Set(members.map((m) => m.blockedBy));
  const memberSources = members.map((m) => {
    const ids = new Set([m.id, ...m.ids]);
    return [
      ...(m.primary ? [m.primary] : []),
      ...items
        .filter((item) => ids.has(item.id) && !blockers.has(item.id))
        .flatMap((item) => item.evidence),
    ];
  });
  const common = (memberSources[0] ?? []).filter(({ url }) =>
    memberSources.every((sources) => sources.some((link) => link.url === url)),
  );
  const memberUrls = new Set(memberSources.flat().map(({ url }) => url));
  const sources = one ? (memberSources[0] ?? []) : line.rollout ? [] : common;
  const companions = one
    ? links
    : links.filter(({ url }) => !memberUrls.has(url) || common.some((link) => link.url === url));
  const reading = one ?? line;
  const next = rollout?.next ?? items.find((item) => item.id === lead?.id)?.next;
  const primary = lead?.primary && sources.find(({ url }) => url === lead.primary?.url);
  return {
    title: `${one?.fork ?? line.subject} · ${line.headline}`,
    place,
    subject: one ? { kind: "item", id: one.id } : { kind: "line", id: line.id },
    section: line.section,
    cause: reading.cause,
    effect: reading.effect,
    steps: reading.steps.length
      ? reading.steps
      : rollout?.next
        ? [rollout.next]
        : lead?.steps.length
          ? lead.steps
          : next
            ? [next]
            : [],
    ...(reading.deadline ? { deadline: reading.deadline } : {}),
    ...(primary ? { primary } : {}),
    ...(one && line.members.length > 1 ? { fork: one.fork } : {}),
    ...(one ? { scope: one.fork } : {}),
    links: [...sources, ...companions, ...(rollout?.evidence ?? [])],
    notRead: [...new Set(members.flatMap((m) => m.evidence.notRead))],
  };
}

/** Repository disposition comes only from core membership and counted Can wait URLs. */
export function repositoryContent({
  entry,
  lines,
  items,
  place,
  source,
  canWait = [],
}: {
  entry: RepoLine;
  lines: readonly TodayLine[];
  items: readonly FocusItem[];
  place: BodyPlace;
  source?: Link;
  canWait?: TodaySummary["canWait"];
}): OpenedContent {
  const id = entry.onToday?.id;
  const line =
    id === undefined ? undefined : lines.find(({ members }) => members.some((m) => m.id === id));
  const member = line?.members.find((m) => m.id === id);
  if (line && member)
    return todayContent({ line, member, items, place, links: source ? [source] : [] });
  return {
    title: entry.text,
    place,
    subject: null,
    ...(entry.url &&
    canWait.some(({ counts }) => counts.some(({ urls }) => urls.includes(entry.url ?? "")))
      ? { cause: "Not on Today. Counted under Can wait." }
      : {}),
    ...(source ? { primary: source } : {}),
  };
}

/** Only sources accepted by the desktop bridge can occupy the action row. No operations ship yet. */
export function bodySources(content: OpenedContent, rowUrl?: string): Link[] {
  const primary = content.primary && bridgeOpens(content.primary.url) ? content.primary : undefined;
  const seen = new Set([rowUrl, primary?.url]);
  return [
    ...(primary && primary.url !== rowUrl ? [primary] : []),
    ...(content.links ?? []).filter(({ url }) => {
      if (seen.has(url) || !bridgeOpens(url)) return false;
      seen.add(url);
      return true;
    }),
  ];
}

/** Omit a cause when its meaningful words are already carried by the headline. */
export function restatesHeadline(cause: string, title: string): boolean {
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .match(/[a-z0-9#]+/g)
        ?.filter((word) => word.length > 2),
    );
  const causeWords = words(cause);
  const titleWords = words(title);
  return (
    causeWords.size === 0 ||
    [...causeWords].filter((word) => titleWords.has(word)).length / causeWords.size >= 0.7
  );
}
