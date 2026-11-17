// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  FocusItem,
  Link,
  RepoLine,
  TodayDeadline,
  TodayLine,
  TodayMember,
} from "@spi-code/contracts";
import type { Destination, EvidenceSelection, OpenSelection } from "../../app/navigation.js";
import { bridgeOpens } from "../../panels/detail-action.js";

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
  const one = member ?? (line.members.length === 1 ? line.members[0] : undefined);
  const members = one ? [one] : line.members;
  const lead = members[0];
  const ids = new Set(lead ? [lead.id, ...lead.ids] : []);
  const blockers = new Set(members.map((m) => m.blockedBy));
  const sources = items.filter((item) => ids.has(item.id) && !blockers.has(item.id));
  const reading = one ?? line;
  const next = sources.find((item) => item.id === lead?.id)?.next;
  return {
    title: `${one?.fork ?? line.subject} · ${line.headline}`,
    place,
    subject: one ? { kind: "item", id: one.id } : { kind: "line", id: line.id },
    section: line.section,
    cause: reading.cause,
    effect: reading.effect,
    steps: reading.steps.length ? reading.steps : next ? [next] : [],
    ...(reading.deadline ? { deadline: reading.deadline } : {}),
    ...(members[0]?.primary ? { primary: members[0].primary } : {}),
    links: [...sources.flatMap((item) => item.evidence), ...links],
    notRead: [...new Set(members.flatMap((m) => m.evidence.notRead))],
  };
}

/** A repository source follows the existing URL association until core's companion join lands. */
export function repositoryContent({
  entry,
  lines,
  items,
  place,
  source,
}: {
  entry: RepoLine;
  lines: readonly TodayLine[];
  items: readonly FocusItem[];
  place: BodyPlace;
  source?: Link;
}): OpenedContent {
  const eligible = items.filter(({ actor }) => actor === "operator");
  const item = entry.url
    ? (eligible.find(({ subject }) => subject === entry.url) ??
      eligible.find(({ evidence }) => evidence.some(({ url }) => url === entry.url)))
    : undefined;
  const line = item && lines.find(({ members }) => members.some((m) => m.ids.includes(item.id)));
  const member = line?.members.find((m) => m.id === item?.id || m.ids.includes(item?.id ?? ""));
  if (line && member)
    return todayContent({ line, member, items, place, links: source ? [source] : [] });
  return {
    title: entry.text,
    place,
    subject: null,
    cause: "Not on Today. Counted under Can wait.",
    ...(source ? { primary: source } : {}),
  };
}

/** Only sources accepted by the desktop bridge can occupy the action row. No operations ship yet. */
export function bodySources(content: OpenedContent, rowUrl?: string): Link[] {
  const primary = content.primary && bridgeOpens(content.primary.url) ? content.primary : undefined;
  const seen = new Set([rowUrl, primary?.url]);
  return [
    ...(primary ? [primary] : []),
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
