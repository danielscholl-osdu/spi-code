// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReleaseLine } from "../brief/release.js";
import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { Facts } from "../facts.js";
import { withoutNoise } from "../model/noise.js";
import { type ReleasePr, releasePrs } from "../model/queue.js";
import { plural } from "../util.js";
import {
  clockOf,
  NOT_READ,
  type PlaceReading,
  placeReading,
  type ReadingGroup,
  type ReadingItem,
  type ReadingTile,
} from "./index.js";

// The fields of a release month the Releases place reads; the rest sit on the month itself.
export type ReleaseMonth = Pick<ReleaseLine, "id" | "month" | "name" | "open" | "stateText" | "notes">;

export interface ReleasesReadingInput<T extends ReadingItem> {
  facts: Pick<Facts, "github" | "details">;
  // The briefing's items; the failing release PRs among them pass through as the reading's items.
  items: readonly T[];
  // Release months, newest first, as the Releases pane lists them.
  months: readonly ReleaseMonth[];
  // The release reads and the GitHub reads; the reading qualifies itself on failed or cut ones.
  reads: readonly ReadRecord[];
  context: CoreContext;
}

const NOTES: Readonly<Record<ReleaseMonth["notes"], string>> = Object.freeze({
  approved: "notes approved",
  draft: "notes in draft",
  none: "no notes yet",
  invalid: "notes file invalid",
});

function prName(r: ReleasePr): string {
  return `${r.name} ${r.tag === `#${r.pr.number}` ? "" : `${r.tag} `}#${r.pr.number}`;
}

// What an open release PR waits on, in the words the queue's release rows use.
function waitsOn(r: ReleasePr): string {
  if (r.ready) return "ready to merge";
  if (r.pr.reviewDecision === "CHANGES_REQUESTED") return "changes requested";
  if (r.pr.reviewDecision === "REVIEW_REQUIRED") return "wait for review";
  return "wait on checks";
}

const WAIT_ORDER = Object.freeze(["ready to merge", "wait for review", "changes requested", "wait on checks"]);

// The same groups as the folded line names them.
const WAIT_HEAD: Readonly<Record<string, string>> = Object.freeze({
  "ready to merge": "Ready to merge",
  "wait for review": "Waiting for review",
  "changes requested": "Changes requested",
  "wait on checks": "Waiting on checks",
});

function byWait(open: readonly ReleasePr[]): { word: string; prs: ReleasePr[] }[] {
  return WAIT_ORDER.map((word) => ({ word, prs: open.filter((r) => waitsOn(r) === word) })).filter(
    (g) => g.prs.length > 0,
  );
}

function list(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function headlineOf(open: number, red: readonly ReleasePr[], ready: number): string {
  const lead = open > 0 ? `${plural(open, "release PR")} open` : "No release PRs waiting";
  if (red.length > 0) {
    const refs = red.length <= 2 ? ` (${red.map((r) => `#${r.pr.number}`).join(", ")})` : "";
    return `${lead}, ${red.length} failing${refs}.`;
  }
  if (open === 0) return "No release PRs open.";
  return ready > 0 ? `${lead}, ${ready} ready to merge.` : `${lead}, none failing.`;
}

function openTile(open: readonly ReleasePr[]): ReadingTile {
  if (open.length === 0) return { label: "Release PRs open", value: "None", counts: "no release PR waits" };
  return {
    label: "Release PRs open",
    value: String(open.length),
    counts: byWait(open)
      .map((g) => `${g.prs.length} ${g.prs.length === 1 ? g.word.replace(/^wait\b/, "waits") : g.word}`)
      .join(", "),
  };
}

function failingTile(red: readonly ReleasePr[]): ReadingTile {
  if (red.length === 0) return { label: "Failing", value: "None", counts: "no release PR fails a check" };
  return { label: "Failing", value: String(red.length), counts: list(red.map((r) => `${r.name} #${r.pr.number}`)) };
}

function currentTile(months: readonly ReleaseMonth[]): ReadingTile {
  const current = months.find((m) => m.open) ?? months[0];
  if (!current) return { label: "Current release", value: NOT_READ, counts: "the release months" };
  return {
    label: current.open ? "Current release" : "Last release",
    value: current.name,
    counts: `${current.stateText} · ${NOTES[current.notes]}`,
  };
}

function foldOf(open: readonly ReleasePr[], months: readonly ReleaseMonth[]): string | undefined {
  const prs = byWait(open).map((g) => `${WAIT_HEAD[g.word]}: ${list(g.prs.map(prName))}.`);
  const current = months.find((m) => m.open) ?? months[0];
  const earlier = months.filter((m) => m !== current);
  const closed = earlier.some((m) => m.open) ? "" : earlier.length === 1 ? ", closed" : ", all closed";
  const past = earlier.length > 0 ? `Earlier months: ${list(earlier.map((m) => m.name))}${closed}.` : undefined;
  return [...prs, past].filter(Boolean).join(" ") || undefined;
}

const isCut = (read: ReadRecord): boolean => read.completeness.kind === "cut";
const isFailed = (read: ReadRecord): boolean => read.failure !== undefined;

function qualifierOf(reads: readonly ReadRecord[]): string | undefined {
  const count = (pick: (read: ReadRecord) => boolean) => new Set(reads.filter(pick).map((r) => r.object)).size;
  const cut = count(isCut);
  const failed = count(isFailed);
  const parts = [
    cut > 0 ? `GitHub cut the reads for ${plural(cut, "repository", "repositories")}` : undefined,
    failed > 0 ? `${cut > 0 ? "the" : "The"} reads failed for ${plural(failed, "repository", "repositories")}` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(" and ")}, so a release PR or month could be missing.` : undefined;
}

// Failing release PRs bite as the briefing projects them: stopped first, then by due time.
function groupsOf<T extends ReadingItem>(items: readonly T[]): ReadingGroup<T>[] {
  const tier = (i: T): number => (i.rung === 0 ? 0 : i.due ? 1 : i.rung === 1 ? 2 : 3);
  const name = (i: T): string =>
    i.rung === 0
      ? "Stopped"
      : i.due
        ? `Before ${clockOf(i.due.at)}`
        : i.rung === 1
          ? "Needs a decision"
          : "Ready to move";
  const time = (i: T): number => (i.due ? Date.parse(i.due.at) : 0);
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => tier(a.item) - tier(b.item) || time(a.item) - time(b.item) || a.index - b.index)
    .map(({ item }) => item);
  const groups: ReadingGroup<T>[] = [];
  for (const item of sorted) {
    const group = name(item);
    const found = groups.find((g) => g.group === group);
    if (found) (found.items as T[]).push(item);
    else groups.push({ group, items: [item] });
  }
  return groups;
}

export function releasesReading<T extends ReadingItem>(input: ReleasesReadingInput<T>): PlaceReading<T> {
  const { facts, items, months, reads, context } = input;
  const qualifier = qualifierOf(reads);
  const github = facts.github.data;
  if (!github) {
    return placeReading<T>({
      headline: `Release PRs ${NOT_READ}.`,
      ...(qualifier ? { qualifier } : {}),
      tiles: [
        { label: "Release PRs open", value: NOT_READ, counts: "open release PRs" },
        { label: "Failing", value: NOT_READ, counts: "release PRs that fail a check" },
        currentTile(months),
      ],
      groups: [],
    });
  }
  const all = releasePrs(withoutNoise(github.repos).repos, facts.details.data ?? {}, context);
  const red = all.filter((r) => r.real.length > 0);
  const open = all.filter((r) => r.real.length === 0);
  const own = items.filter((i) => i.id.startsWith("release-red:"));
  const extra = foldOf(open, months);
  return placeReading({
    headline: headlineOf(open.length, red, open.filter((r) => r.ready).length),
    ...(qualifier ? { qualifier } : {}),
    tiles: [openTile(open), failingTile(red), currentTile(months)],
    groups: groupsOf(own),
    ...(extra ? { extra } : {}),
  });
}
