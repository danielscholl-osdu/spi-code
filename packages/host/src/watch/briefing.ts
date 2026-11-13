// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  ambientOf,
  type Briefing,
  briefingDecisions,
  briefingVerdict,
  buildBriefing,
  canWaitOf,
  cutServices,
  type FocusItem,
  failedServices,
  horizonCards,
  type Model,
  placesOf,
  sinceOf,
  type VerdictInput,
} from "@spi-code/core";
import { itemAttention } from "./attention.js";
import type { WatchInput } from "./project.js";
import type { areaEnvelopes } from "./provenance.js";
import type { placeReadings } from "./readings.js";
import { repositoryLines } from "./repository-lines.js";

type Over<A, B> = Omit<A, keyof B> & B;
type ProjectedItem = Over<FocusItem, ReturnType<typeof itemAttention>>;
type Horizon = ReturnType<typeof horizonCards>;

export type ProjectedBriefing = Over<
  Briefing,
  {
    horizon: Over<Briefing["horizon"], Horizon>;
    decisions: ReturnType<typeof briefingDecisions>;
    since: ReturnType<typeof sinceOf>;
    focus: ProjectedItem[];
    rest: ProjectedItem[];
    repositories: ReturnType<typeof repositoryLines>;
  }
>;

/** The core briefing with each item's attention, the horizon cards, decisions and since. */
export function projectBriefing(
  model: Model,
  input: WatchInput,
  now: Date,
): { briefing: ProjectedBriefing; horizon: Horizon } {
  const coreBriefing = buildBriefing(model, input.doctor, now, input.context);
  const projectItem = (item: FocusItem) => ({
    ...item,
    ...itemAttention(item, model, input, input.attention),
  });
  const focus = coreBriefing.focus.map(projectItem);
  const rest = coreBriefing.rest.map(projectItem);
  const radarReads = (input.envelopeReads ?? input.reads).radar ?? [];
  const horizon = horizonCards({
    model,
    items: [...focus, ...rest],
    themes: coreBriefing.themes,
    unread: [
      ...cutServices(radarReads, input.context.fleet),
      ...failedServices(radarReads, input.context.fleet),
    ],
  });
  const briefing = {
    ...coreBriefing,
    horizon: { ...coreBriefing.horizon, ...horizon },
    decisions: briefingDecisions(model, [...focus, ...rest], coreBriefing.themes),
    since: sinceOf(
      model,
      input.facts,
      now,
      input.intervals?.runs ?? input.intervalMs,
      undefined,
      input.reads,
    ),
    focus,
    rest,
    repositories: repositoryLines(coreBriefing.repositories, model, now),
  };
  return { briefing, horizon };
}

/** An open maintenance hold of the environment; unread lifecycle runs prove none. */
function holdOf(model: Model, now: Date): VerdictInput["hold"] {
  const { stack } = model;
  const a = stack.availability;
  if (stack.maintenance.state !== "set" && !a?.heldNow) return undefined;
  const run = stack.inflight?.run;
  return {
    ms: a?.heldNow && a.since !== undefined ? now.getTime() - a.since : undefined,
    run: run
      ? { kind: run.kind, target: run.target !== stack.running?.version ? run.target : undefined }
      : undefined,
    itemId: model.queue.items.find((item) => item.kind === "stack" || item.kind === "maintenance")
      ?.id,
  };
}

/** Adds the places, ambient, can-wait and verdict, which read the readings and area envelopes. */
export function settleBriefing(
  briefing: ProjectedBriefing,
  horizon: Horizon,
  model: Model,
  input: WatchInput,
  readings: ReturnType<typeof placeReadings>,
  areas: ReturnType<typeof areaEnvelopes>,
  now: Date,
): ReturnType<typeof placesOf> {
  const { focus, rest } = briefing;
  const places = placesOf({
    readings,
    items: [...briefing.focus, ...briefing.rest],
    areas,
    source: {
      model,
      facts: input.facts,
      reads: input.envelopeReads ?? input.reads,
      cards: horizon.cards,
    },
  });
  const verdict = briefingVerdict({
    items: [...briefing.focus, ...briefing.rest],
    horizon: briefing.horizon,
    stoppedForks: model.stoppedForks,
    forks: model.lines.length,
    deployable: model.stack.deployable,
    version: model.stack.running?.version,
    hold: holdOf(model, now),
    places,
    areas,
  });
  Object.assign(briefing, {
    places,
    ambient: ambientOf({
      model,
      items: [...focus, ...rest],
      cards: [...horizon.cards, horizon.owed],
      now,
    }),
    canWait: canWaitOf({
      model,
      items: [...focus, ...rest],
      places,
      cards: [...horizon.cards, horizon.owed],
      reads: input.envelopeReads ?? input.reads,
    }),
    verdict,
  });
  return places;
}
