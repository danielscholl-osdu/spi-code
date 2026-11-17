// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { TodayLine, TodayMember, ViewSnapshot, WatchBriefing } from "@spi-code/contracts";

export type MemberPlace = "line" | "environment" | "engineering" | "upstream" | "security";
export type PlaceMember = { line: TodayLine; member: TodayMember };

/** The lines own identity and order; repository associations are cross-references, never homes. */
export function todayMembers(briefing: Pick<WatchBriefing, "lines">): PlaceMember[] {
  const seen = new Set<string>();
  return (briefing.lines ?? []).flatMap((line) =>
    line.members.flatMap((member) => {
      if (seen.has(member.id)) return [];
      seen.add(member.id);
      return [{ line, member }];
    }),
  );
}

export function placeMembers(
  snapshot: ViewSnapshot | undefined,
  place: MemberPlace,
): PlaceMember[] {
  if (!snapshot) return [];
  const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
  return todayMembers(snapshot.briefing).filter(({ member }) => {
    const homes = (snapshot.briefing.places ?? []).filter(({ itemIds }) =>
      itemIds.includes(member.id),
    );
    if (homes.length === 1) return homes[0]?.place === place;
    if (homes.length > 1) return false;
    const item = items.find(({ id }) => id === member.id);
    return place === "upstream" && item?.cls === "PORT" && item.origin === "upstream";
  });
}
