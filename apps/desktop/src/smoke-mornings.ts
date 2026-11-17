// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";

export const MORNINGS = ["calm", "busy", "bad"] as const;
export type Morning = (typeof MORNINGS)[number];

export const MORNING_FIXTURES: Readonly<Record<Morning, string>> = {
  calm: "snapshot-calm.json",
  busy: "snapshot-busy.json",
  bad: "snapshot-bad.json",
};

export const TODAY_SECTIONS = ["blocked", "waiting"] as const;

/** Each section's member ids as "blocked <ids> · waiting <ids>", in the order Today lists them. */
export function membersText(members: Readonly<Record<string, readonly string[]>>): string {
  return TODAY_SECTIONS.map((section) => [section, ...(members[section] ?? [])].join(" ")).join(
    " · ",
  );
}

/** The members of core's lines, by section. */
export function lineMembersText(
  lines: readonly { section: string; members: readonly { id: string }[] }[] | undefined,
): string {
  return membersText(
    Object.fromEntries(
      TODAY_SECTIONS.map((section) => [
        section,
        (lines ?? [])
          .filter((line) => line.section === section)
          .flatMap((line) => line.members.map(({ id }) => id)),
      ]),
    ),
  );
}

/** The number of members in the fixture's section lists, independent of their grouping. */
export function lineMemberCount(members: string): number {
  return members.split(" · ").reduce((count, section) => count + section.split(" ").length - 1, 0);
}

/** In the window: the member rows Today draws in each section, single lines and group sub-rows. */
export const DRAWN_MEMBERS = `Object.fromEntries(${JSON.stringify(TODAY_SECTIONS)}.map(section => [section,
  [...document.querySelectorAll(".today [data-section=" + section + "] tr.today-row[data-item-id]")].map(row => row.dataset.itemId)]))`;

/** Throws unless Today draws a row for every member of core's lines, each in its section. */
export function assertDrawnMembers(drawn: unknown, members: unknown, label: string): void {
  assert(
    typeof members === "string" && members !== membersText({}),
    `Missing line members: ${label}`,
  );
  assert.equal(drawn, members, `Today draws "${drawn}", not core's "${members}": ${label}`);
}

/** Today's blocks top to bottom, as the frame draws them; each capture names the ones it holds. */
export const TODAY_BLOCKS = [
  "caveat",
  "calm",
  "blocked",
  "waiting",
  "can-wait",
  "moving",
  "history",
] as const;
export type TodayBlock = (typeof TODAY_BLOCKS)[number];

const LOWER = ["can-wait", "moving", "history"] as const;
const required: Readonly<Record<Morning, readonly TodayBlock[]>> = {
  calm: ["waiting", ...LOWER],
  busy: ["blocked", "waiting", ...LOWER],
  bad: ["caveat", "blocked", "waiting", ...LOWER],
};
const absent: Readonly<Record<Morning, readonly TodayBlock[]>> = {
  calm: ["caveat", "calm", "blocked"],
  busy: ["caveat", "calm"],
  bad: ["calm"],
};

export const MORNING_SURFACES = MORNINGS.flatMap((morning) => [
  {
    id: `today-${morning}`,
    morning,
    open: false,
    widths: morning === "busy" ? [1440, 1000, 740] : [1440, 740],
  },
  { id: `today-${morning}-open`, morning, open: true, widths: [1440] },
]) satisfies { id: string; morning: Morning; open: boolean; widths: number[] }[];
export type MorningSurface = (typeof MORNING_SURFACES)[number];

const DESIGN = {
  sections:
    "Today items 1-5 and X7: Blocked, Waiting on you, Can wait, Moving without you, Last 24 hours",
  rows: "X4: Today is a table (Fork, What, Open, Age)",
  counts: "X3: the lower three are counts, not sentences; X8: each opens its place",
  bad: "Z4: what the sweep did not read opens Evidence",
  narrow: "Today's table at a narrow centre",
  open: "Z2: on Today, a row opens in place",
} as const;

/** The spi-code-today-and-places.md rulings a reviewer checks this capture against. */
export function morningSections(morning: Morning, open: boolean, width: number): string[] {
  return [
    DESIGN.sections,
    DESIGN.rows,
    DESIGN.counts,
    ...(morning === "bad" ? [DESIGN.bad] : []),
    ...(width < 1440 ? [DESIGN.narrow] : []),
    ...(open ? [DESIGN.open] : []),
  ];
}

export interface MorningBlock {
  name: TodayBlock;
  top: number;
  height: number;
}

/** DOM evidence for one Today capture: the whole frame, measured in the full-page layout. */
export interface MorningEvidence {
  morning: Morning;
  fixture: string;
  open: boolean;
  sections: string[];
  /** The sentence Today draws in place of its rows; none on a morning whose lines core sends. */
  headline: string;
  /** The member rows Blocked and Waiting on you draw, and the members of the fixture's lines. */
  members: string;
  lineMembers: string;
  /** The sidebar's Today count, empty when it draws none. */
  todayCount: string;
  viewportHeight: number;
  scrollHeight: number;
  clientHeight: number;
  pageHeight: number;
  blocks: MorningBlock[];
  /** The place link of the row opened in place, drawn directly under that row. */
  opened?: string;
}

/** Throws unless the capture holds Today's whole frame for its morning, every block inside it. */
export function assertMorningEvidence(
  surface: MorningSurface,
  shot: {
    viewportWidth: number;
    width: number;
    height: number;
    qualifiers: unknown;
    morning?: unknown;
  },
): void {
  const label = `${surface.id}/${shot.viewportWidth}`;
  const evidence = shot.morning as Partial<MorningEvidence> | undefined;
  assert(evidence && typeof evidence === "object", `Missing morning evidence: ${label}`);
  assert.equal(evidence.morning, surface.morning, `Wrong morning: ${label}`);
  assert.equal(evidence.fixture, MORNING_FIXTURES[surface.morning], `Wrong fixture: ${label}`);
  assert.equal(evidence.open, surface.open, `Wrong opened state: ${label}`);
  assert.deepEqual(
    evidence.sections,
    morningSections(surface.morning, surface.open, shot.viewportWidth),
    `Wrong decision sections: ${label}`,
  );
  assert.equal(evidence.headline, "", `Wrong headline: ${label}`);
  const { members, lineMembers, todayCount } = evidence;
  assertDrawnMembers(members, lineMembers, label);
  assert(
    typeof todayCount === "string" && /^\d*$/.test(todayCount),
    `Missing Today count: ${label}`,
  );
  assert.equal(
    todayCount,
    String(lineMemberCount(lineMembers as string)),
    `Sidebar Today count differs from core line members: ${label}`,
  );
  const qualifiers = shot.qualifiers;
  assert(
    Array.isArray(qualifiers) && qualifiers.every((text) => typeof text === "string"),
    `Missing qualifiers: ${label}`,
  );
  assert(/swept/i.test(qualifiers[0] ?? ""), `Missing sweep qualifier: ${label}`);
  if (surface.morning === "bad")
    assert(
      /^GitHub\b.* read failed at \d\d:\d\d; items from it may be missing\. Evidence ›/.test(
        qualifiers[1] ?? "",
      ),
      `Missing caveat band qualifier: ${label} (${qualifiers[1]})`,
    );
  else assert.equal(qualifiers[1], "", `Unexpected caveat band: ${label}`);
  const { viewportHeight, scrollHeight, clientHeight, pageHeight, blocks } = evidence;
  for (const value of [viewportHeight, scrollHeight, clientHeight, pageHeight])
    assert(typeof value === "number" && value > 0, `Missing page height: ${label}`);
  assert(viewportHeight && scrollHeight && clientHeight && pageHeight);
  assert(
    pageHeight >= viewportHeight + Math.max(0, scrollHeight - clientHeight) - 0.5,
    `Capture stops above the fold: ${label}`,
  );
  assert(
    Math.abs(shot.height / shot.width - pageHeight / shot.viewportWidth) < 0.01,
    `Image is not the full page: ${label}`,
  );
  assert(Array.isArray(blocks), `Missing blocks: ${label}`);
  const names = blocks.map(({ name }) => name);
  assert.deepEqual(
    names,
    TODAY_BLOCKS.filter((name) => names.includes(name)),
    `Blocks out of order: ${label}`,
  );
  for (const name of required[surface.morning])
    assert(names.includes(name), `Missing block ${name}: ${label}`);
  for (const name of absent[surface.morning])
    assert(!names.includes(name), `Unexpected block ${name}: ${label}`);
  for (const { name, top, height } of blocks)
    assert(
      typeof top === "number" &&
        typeof height === "number" &&
        top >= 0 &&
        height > 0 &&
        top + height <= pageHeight + 0.5,
      `Block ${name} outside the capture: ${label}`,
    );
  if (surface.open)
    assert(
      typeof evidence.opened === "string" && /\S.* ›$/.test(evidence.opened),
      `Missing row opened in place: ${label}`,
    );
  else assert.equal(evidence.opened, undefined, `Unexpected opened row: ${label}`);
}
