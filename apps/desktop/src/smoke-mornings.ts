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
  "head",
  "caveat",
  "table",
  "horizon",
  "places",
  "releases",
  "motion",
] as const;
export type TodayBlock = (typeof TODAY_BLOCKS)[number];

const required: Readonly<Record<Morning, readonly TodayBlock[]>> = {
  calm: ["table", "horizon", "places", "releases", "motion"],
  busy: ["table", "horizon", "places", "releases", "motion"],
  bad: ["caveat", "table", "horizon", "places", "releases"],
};
const absent: Readonly<Record<Morning, readonly TodayBlock[]>> = {
  calm: ["head", "caveat"],
  busy: ["head", "caveat"],
  bad: ["head", "motion"],
};

export const MORNING_SURFACES = MORNINGS.flatMap((morning) => [
  {
    id: `today-${morning}`,
    morning,
    detail: false,
    widths: morning === "busy" ? [1440, 1000, 740] : [1440, 740],
  },
  { id: `today-${morning}-detail`, morning, detail: true, widths: [1440] },
]) satisfies { id: string; morning: Morning; detail: boolean; widths: number[] }[];
export type MorningSurface = (typeof MORNING_SURFACES)[number];

const DECISION = {
  wide: "Today at 1440 × 900 (sidebar 232, centre 1208, Detail closed), this morning's data",
  calmFirst: "Calm first (draft 7)",
  horizon: "On the horizon: what's coming from GitLab (draft 7)",
  words: "Words and visuals (draft 7)",
  column: "One column: 740 px, and 1440 with Detail open (centre about 850)",
  calm: "Calm and bad mornings: Calm",
  bad: "Calm and bad mornings: Bad",
  clicks: "Click targets: a version opens that service's release in Detail",
} as const;

/** The decision.md (draft 7) sections a reviewer checks this capture against. */
export function morningSections(morning: Morning, detail: boolean, width: number): string[] {
  return [
    ...(morning === "busy" ? [DECISION.wide] : [DECISION[morning]]),
    DECISION.calmFirst,
    DECISION.horizon,
    DECISION.words,
    ...(detail || width < 1440 ? [DECISION.column] : []),
    ...(detail ? [DECISION.clicks] : []),
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
  detail: boolean;
  sections: string[];
  /** The verdict Today draws; none on a morning whose lines core sends. */
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
  detailTitle?: string;
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
  assert.equal(evidence.detail, surface.detail, `Wrong Detail state: ${label}`);
  assert.deepEqual(
    evidence.sections,
    morningSections(surface.morning, surface.detail, shot.viewportWidth),
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
    String({ calm: 1, busy: 13, bad: 14 }[surface.morning]),
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
  if (surface.detail)
    assert(
      typeof evidence.detailTitle === "string" && evidence.detailTitle.length > 0,
      `Missing Detail: ${label}`,
    );
  else assert.equal(evidence.detailTitle, undefined, `Unexpected Detail: ${label}`);
}
