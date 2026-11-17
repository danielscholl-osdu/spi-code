// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { TodayLine, TodayMember, ViewSnapshot, WatchBriefing } from "@spi-code/contracts";

export type MemberPlace = NonNullable<TodayMember["home"]>;
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
  return todayMembers(snapshot.briefing).filter(({ member }) => member.home === place);
}
