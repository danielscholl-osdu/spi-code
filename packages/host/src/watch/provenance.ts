// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AreaEnvelope, ValueSource } from "@spi-code/contracts";
import {
  AREAS,
  type AreaName,
  type Briefing,
  envelopeOf,
  type ReadRecord,
  type StackModel,
} from "@spi-code/core";

// Each binding is a superset of the Facts areas core reads to build the value, following
// buildModel's inputs. Over-naming an area can only hide an "inferred" mark; under-naming
// would hide a stale or failed input, so unknown values fall back to MODEL.
/** buildStack: the stack repository and fork deployments (github) and lifecycle runs. */
const STACK = ["github", "lifecycle"] as const satisfies readonly AreaName[];
/** buildLine: repositories, fork runs, upstream, template compares, job details, radar and the stack. */
const LINES = [
  ...STACK,
  "runs",
  "upstream",
  "template",
  "details",
  "radar",
] as const satisfies readonly AreaName[];
/** buildTemplate and buildRollout read only LINES inputs, so the template fact uses LINES. */
/** buildQueue and themes read the whole model, which adds approvals and security alerts. */
const MODEL = [...LINES, "approvals", "security"] as const satisfies readonly AreaName[];
/** Lifecycle-only values: replayed maintenance, availability, proof runs and lane events. */
const LIFECYCLE = ["lifecycle"] as const satisfies readonly AreaName[];

/** The environment figure is the running version (lifecycle), else the declared one (github). */
function versionAreas(stack: StackModel): readonly AreaName[] {
  if (stack.running) return LIFECYCLE;
  return stack.declared ? ["github"] : STACK;
}

function briefFactAreas(label: string, stack: StackModel): readonly AreaName[] {
  if (label === "Environment") return versionAreas(stack);
  if (label === "Upstream sync" || label.startsWith("Template")) return LINES;
  return MODEL;
}

function environmentFactAreas(label: string, stack: StackModel): readonly AreaName[] {
  if (label === "Running") return versionAreas(stack);
  if (label.startsWith("Deployable") || label === "Last proof") return LIFECYCLE;
  return MODEL;
}

function ordered(areas: readonly AreaName[]): AreaName[] {
  return AREAS.filter((area) => areas.includes(area));
}

/** Provenance for every briefing value the Watch views draw, keyed by RFC 6901 pointer. */
export function briefingProvenance(briefing: Briefing, stack: StackModel): ValueSource[] {
  const sources: ValueSource[] = [];
  const add = (path: string, areas: readonly AreaName[]): void => {
    sources.push({ path, areas: ordered(areas) });
  };
  const each = (items: readonly unknown[], prefix: string, areas: readonly AreaName[]): void => {
    for (const i of items.keys()) add(`${prefix}/${i}`, areas);
  };
  briefing.facts.forEach((fact, i) => {
    add(`/briefing/facts/${i}/figure`, briefFactAreas(fact.label, stack));
  });
  each(briefing.focus, "/briefing/focus", MODEL);
  each(briefing.rest, "/briefing/rest", MODEL);
  each(briefing.ready, "/briefing/ready", MODEL);
  each(briefing.themes, "/briefing/themes", MODEL);
  each(briefing.flow.tiles, "/briefing/flow/tiles", LINES);
  each(briefing.flow.rows, "/briefing/flow/rows", LINES);
  briefing.environment.facts.forEach((fact, i) => {
    add(`/briefing/environment/facts/${i}/figure`, environmentFactAreas(fact.label, stack));
  });
  each(briefing.environment.lanes, "/briefing/environment/lanes", LIFECYCLE);
  return sources;
}

/** Stations come from buildLine, one row per fork. */
export function stationProvenance(
  stations: readonly { readonly stations: readonly unknown[] }[],
): ValueSource[] {
  return stations.flatMap((row, s) =>
    row.stations.map((_, k) => ({ path: `/stations/${s}/stations/${k}`, areas: ordered(LINES) })),
  );
}

/** One envelope per area, each judged against its own sweep interval; no area is omitted. */
export function areaEnvelopes(
  reads: Partial<Record<AreaName, readonly ReadRecord[]>>,
  intervalOf: (area: AreaName) => number,
  now: Date,
): AreaEnvelope[] {
  return AREAS.map((area) => {
    const envelope = envelopeOf(reads[area] ?? [], {
      intervalMs: intervalOf(area),
      now: now.getTime(),
    });
    if (envelope.state === "unread") return { area, envelope: { source: area, state: "unread" } };
    return {
      area,
      envelope: {
        source: area,
        state: envelope.state,
        ...(envelope.observedAt === undefined ? {} : { observedAt: envelope.observedAt }),
        completeness: envelope.completeness,
        inferred: envelope.inferred,
      },
    };
  });
}
