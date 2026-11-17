// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type TodayEntry,
  type TodayMember,
  todayMembers,
  type ViewSnapshot,
} from "@spi-code/contracts";

export type MemberPlace = NonNullable<TodayMember["home"]>;
export type PlaceMember = TodayEntry;

export function placeMembers(
  snapshot: ViewSnapshot | undefined,
  place: MemberPlace,
): PlaceMember[] {
  if (!snapshot) return [];
  return todayMembers(snapshot.briefing).filter(({ member }) => member.home === place);
}
