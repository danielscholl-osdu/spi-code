// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AttentionTier } from "../attention.js";
import { AREAS, type AreaName } from "../facts.js";
import { names, plural, span } from "../util.js";
import type { Origin } from "./horizon.js";

type Mark = "stopped" | "needs-person" | "in-progress" | "nothing-due";

interface VerdictItem {
  id: string;
  attention: AttentionTier;
  origin?: Origin | undefined;
}

export interface VerdictInput {
  items: readonly VerdictItem[];
  horizon: {
    cards?: readonly { itemIds: readonly string[] }[] | undefined;
    counts?: { needYouCards: number } | undefined;
    owed?: { itemIds?: readonly string[] | undefined } | undefined;
  };
  /** The strip's stopped forks, model.stoppedForks. */
  stoppedForks: readonly string[];
  forks: number;
  deployable: { state: "yes" | "no" | "unknown" };
  version?: string | undefined;
  /** An open maintenance hold: how long it has lasted when known, the run working on it, its item. */
  hold?:
    | {
        ms?: number | undefined;
        run?: { kind: string; target?: string | undefined } | undefined;
        itemId?: string | undefined;
      }
    | undefined;
  places: readonly { areas: readonly AreaName[] }[];
  areas: readonly { area: AreaName; envelope: { state: string } }[];
}

const LABELS: Readonly<Record<AreaName, readonly [label: string, many: boolean]>> = Object.freeze({
  fleet: ["fleet membership", false],
  github: ["GitHub", false],
  runs: ["workflow runs", true],
  approvals: ["run approvals", true],
  lifecycle: ["stack lifecycle runs", true],
  details: ["run details", true],
  upstream: ["upstream GitLab", false],
  radar: ["the upstream radar", false],
  template: ["the template", false],
  auth: ["sign-in", false],
  security: ["security alerts", true],
});

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

// The line stop leads: how long the environment has been in maintenance, and whether a run clears it.
function holdSentence(hold: NonNullable<VerdictInput["hold"]>): string {
  const held = span(hold.ms);
  const state = held ? `has been in maintenance for ${held}` : "is in maintenance";
  if (!hold.run) return `The environment ${state}, and nothing is running to clear it.`;
  const what = `${hold.run.kind}${hold.run.target ? ` to ${hold.run.target}` : ""}`;
  return `The environment ${state} while ${article(what)} ${what} runs.`;
}

function notRead(areas: readonly AreaName[], how: string): string | undefined {
  if (areas.length === 0) return undefined;
  const many = areas.length > 1 || LABELS[areas[0] as AreaName][1];
  return `${cap(names(areas.map((area) => LABELS[area][0])))} ${many ? "weren't" : "wasn't"} ${how} this sweep.`;
}

/**
 * Today's one sentence: each origin at its loudest tier, the strip's stopped forks, and what
 * wasn't read. An upstream change is one horizon card, or one upstream item with no home.
 */
export function briefingVerdict(input: VerdictInput): { text: string; mark: Mark } {
  const housed = new Set([
    ...(input.horizon.cards ?? []).flatMap((card) => card.itemIds),
    ...(input.horizon.owed?.itemIds ?? []),
  ]);
  const upstream = (item: VerdictItem) => item.origin === "upstream" || housed.has(item.id);
  const hold = input.hold;
  const lead = hold ? holdSentence(hold) : undefined;
  const interrupts = input.items.filter((item) => item.attention === "interrupt");
  const others = hold ? interrupts.filter((item) => item.id !== hold.itemId) : interrupts;
  const surface = input.items.filter((item) => item.attention === "surface");
  const systemSurface = surface.filter((item) => !upstream(item)).length;
  const tierOf = new Map(input.items.map((item) => [item.id, item.attention]));
  const cardChanges =
    input.horizon.counts?.needYouCards ??
    (input.horizon.cards ?? []).filter((card) =>
      card.itemIds.some((id) => tierOf.get(id) === "surface" || tierOf.get(id) === "interrupt"),
    ).length;
  const upstreamSurface =
    cardChanges + surface.filter((item) => !housed.has(item.id) && item.origin === "upstream").length;
  const stopped = input.stoppedForks.length;

  const clauses: string[] = [];
  if (others.length > 0)
    clauses.push(
      `${plural(others.length, lead ? "other thing" : "thing")} ${others.length === 1 ? "needs" : "need"} you`,
    );
  if (stopped > 0) clauses.push(`${plural(stopped, "fork")} ${stopped === 1 ? "is" : "are"} stopped`);
  if (systemSurface > 0 && !others.some((item) => !upstream(item)))
    clauses.push(`${plural(systemSurface, "decision")} ${systemSurface === 1 ? "waits" : "wait"} on you`);
  if (upstreamSurface > 0 && !others.some(upstream))
    clauses.push(
      `${plural(upstreamSurface, "upstream change")} ${upstreamSurface === 1 ? "needs you before it lands" : "need you before they land"}`,
    );

  const declared = [...new Set(input.places.flatMap((place) => place.areas))];
  const depends = AREAS.filter(
    (area) =>
      area === "fleet" ||
      (declared.length > 0 ? declared.includes(area) : input.areas.some((entry) => entry.area === area)),
  );
  const stateOf = (area: AreaName) =>
    input.areas.find((entry) => entry.area === area)?.envelope.state ?? "unread";
  const cut = depends.filter((area) => stateOf(area) === "incomplete");
  const unread = depends.filter((area) => !["fresh", "incomplete"].includes(stateOf(area)));
  const caveats =
    unread.length > 1 && unread.length === depends.length
      ? ["Nothing was read this sweep."]
      : [notRead(unread, "read"), notRead(cut, "fully read")].filter(
          (text): text is string => text !== undefined,
        );

  const deployable = input.deployable.state === "yes";
  const calm =
    !lead &&
    clauses.length === 0 &&
    surface.length === 0 &&
    caveats.length === 0 &&
    deployable &&
    input.forks > 0;
  if (calm) {
    const forks = input.forks === 1 ? "the fork is flowing" : `all ${input.forks} forks are flowing`;
    return {
      text: `Nothing urgent needs you. ${input.version ?? "The environment"} is ready; ${forks}.`,
      mark: "nothing-due",
    };
  }

  const sentences = lead
    ? [lead, ...(clauses.length > 0 ? [`${cap(clauses.join("; "))}.`] : [])]
    : clauses.length > 0
      ? [`${cap(clauses.join("; "))}.`]
      : [
          caveats.length > 0 ? "Nothing read needs you." : "Nothing urgent needs you.",
          ...(input.deployable.state === "no"
            ? ["The environment isn't ready."]
            : !deployable
              ? ["The environment isn't shown ready."]
              : []),
          ...(input.forks === 0 ? ["No forks were read."] : []),
        ];
  const mark: Mark =
    (hold && !hold.run) || interrupts.length > 0 || stopped > 0
      ? "stopped"
      : surface.length > 0
        ? "needs-person"
        : "in-progress";
  return { text: [...sentences, ...caveats].join(" "), mark };
}
