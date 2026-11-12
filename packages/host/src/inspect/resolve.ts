// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import {
  buildModel,
  type CoreContext,
  cacheSchema,
  type Exec,
  type Facts,
  type InspectOptions,
  inspectRepo,
  inspectUpstreamFork,
  inspectUpstreamPlan,
  isMonth,
  type Model,
  monthFacts,
  mrBoard,
  mrTitle,
  RELEASE_PREFIX,
  REPO_PREFIX,
  releaseDoc,
  STEP_PREFIX,
  UPSTREAM_ITEM,
  UPSTREAM_PREFIX,
} from "@spi-code/core";
import { readNotes } from "../watch/project.js";
import { holdResult } from "./hold.js";
import { inspectResult } from "./item.js";
import { mrResult } from "./mr.js";
import {
  HOLD_PREFIX,
  RUN_PREFIX,
  SERVICE_PREFIX,
  STATION_PREFIX,
  THEME_PREFIX,
} from "./prefixes.js";
import { releaseResult } from "./release.js";
import { repoResult, repositoryLineResult } from "./repo.js";
import { coveringItem, findRun, runResult } from "./run.js";
import { stationResult } from "./station.js";
import { stepResult } from "./step.js";
import { themeResult } from "./theme.js";
import { upstreamForkResult, upstreamPlanResult } from "./upstream.js";

/** What an inspection reads from the latest persisted sweep. */
export interface InspectSnapshot {
  readonly view: ViewSnapshot;
  readonly facts: Facts;
  readonly releases: unknown;
}

export interface InspectDependencies {
  readonly ctx: CoreContext;
  readonly appData: string;
  /** Runs the inspector's on-demand reads. */
  readonly exec: Exec;
  readonly inspect?: InspectOptions;
}

export interface InspectScope {
  readonly snapshot: InspectSnapshot;
  readonly deps: InspectDependencies;
  readonly model: Model;
  readonly now: Date;
}

export interface InspectRow {
  readonly kind: string;
  readonly claims: (id: string, scope: InspectScope) => boolean;
  readonly resolve: (
    id: string,
    scope: InspectScope,
  ) => InspectResult | undefined | Promise<InspectResult | undefined>;
}

const prefixed = (prefix: string) => (id: string) => id.startsWith(prefix);

/** In order: the first row that claims an id answers it, so a queue item's own id comes first. */
export const INSPECT_TABLE: readonly InspectRow[] = [
  {
    kind: "queue item",
    claims: (id, { model }) => model.queue.items.some((entry) => entry.id === id),
    resolve: (id, { model, now, deps, snapshot }) => {
      const item = model.queue.items.find((entry) => entry.id === id);
      return item
        ? inspectResult(model, item, now, deps.ctx, deps.exec, snapshot.view.areas, deps.inspect)
        : undefined;
    },
  },
  {
    kind: "step",
    claims: (id, { model }) =>
      model.template.steps.some((step) => `${STEP_PREFIX}${step.marker}` === id),
    resolve: (id, { model, deps, snapshot }) =>
      stepResult(model, id, deps.ctx, snapshot.view.areas),
  },
  {
    kind: "MR",
    claims: (id, { model }) => Boolean(mrTitle(model, id)),
    resolve: (id, { model, now, deps, snapshot }) =>
      mrResult(mrBoard(model, id, now, deps.ctx), id, mrTitle(model, id), snapshot.view.areas),
  },
  {
    kind: "upstream plan",
    claims: (id) => id === UPSTREAM_ITEM,
    resolve: (_id, { model, now, snapshot }) =>
      upstreamPlanResult(inspectUpstreamPlan(model, now), snapshot.view.areas),
  },
  {
    kind: "upstream fork",
    claims: prefixed(UPSTREAM_PREFIX),
    resolve: (id, { model, now, snapshot }) => {
      const fork = inspectUpstreamFork(model, id.slice(UPSTREAM_PREFIX.length), now);
      return fork ? upstreamForkResult(id, fork, snapshot.view.areas) : undefined;
    },
  },
  {
    kind: "release",
    claims: prefixed(RELEASE_PREFIX),
    resolve: (id, { now, deps, snapshot }) => {
      const month = id.slice(RELEASE_PREFIX.length);
      if (
        !isMonth(month) ||
        !snapshot.view.releases.lines.some((line) => line.id === id) ||
        snapshot.releases === undefined
      ) {
        return undefined;
      }
      const { at, ...reads } = cacheSchema.shape.releases.parse(snapshot.releases);
      return releaseResult(
        releaseDoc(
          monthFacts({ ...reads, ...(at === undefined ? {} : { at }) }, month, now, deps.ctx),
          readNotes(deps.appData, month),
          now,
        ),
        snapshot.view.areas,
      );
    },
  },
  {
    kind: "repository",
    claims: prefixed(REPO_PREFIX),
    resolve: (id, { model, now, snapshot }) => {
      const repo = inspectRepo(model, id, now);
      return repo ? repoResult(id, repo, snapshot.view.areas) : undefined;
    },
  },
  {
    kind: "service",
    claims: prefixed(SERVICE_PREFIX),
    resolve: (id, { model, now, snapshot }) => {
      const service = id.slice(SERVICE_PREFIX.length);
      const fork = inspectUpstreamFork(model, service, now);
      if (fork) return upstreamForkResult(id, fork, snapshot.view.areas);
      const repo = inspectRepo(model, `${REPO_PREFIX}${service}`, now);
      return repo ? repoResult(id, repo, snapshot.view.areas) : undefined;
    },
  },
  {
    kind: "run",
    claims: prefixed(RUN_PREFIX),
    resolve: (id, { model, deps, snapshot }) => {
      const hit = findRun(snapshot.facts, id.slice(RUN_PREFIX.length), deps.ctx.stackRepo);
      return hit
        ? runResult(id, hit, coveringItem(model, hit.run), snapshot.view.areas)
        : undefined;
    },
  },
  {
    kind: "hold",
    claims: prefixed(HOLD_PREFIX),
    resolve: (id, { snapshot: { view } }) => {
      const hold = view.briefing.environment.lanes
        .find((lane) => lane.id === "holds")
        ?.events.find((e) => `${HOLD_PREFIX}${e.id}` === id);
      return hold ? holdResult(id, hold, view.briefing, view.areas) : undefined;
    },
  },
  {
    kind: "theme",
    claims: prefixed(THEME_PREFIX),
    resolve: (id, { snapshot: { view } }) => {
      const theme = view.briefing.themes.find((t) => `${THEME_PREFIX}${t.id}` === id);
      return theme
        ? themeResult(
            id,
            theme,
            view.areas,
            [...view.briefing.focus, ...view.briefing.rest].find(
              (item) => item.id === theme.inspect,
            ),
          )
        : undefined;
    },
  },
  {
    kind: "station",
    claims: prefixed(STATION_PREFIX),
    resolve: (id, { model, now, snapshot }) => stationResult(model, id, now, snapshot.view.areas),
  },
  {
    kind: "repository line",
    claims: (id) => ["pr:", "issue:", "alert:"].some((prefix) => id.startsWith(prefix)),
    resolve: (id, { snapshot }) => repositoryLineResult(snapshot.view, id),
  },
];

export function inspectScope(snapshot: InspectSnapshot, deps: InspectDependencies): InspectScope {
  const now = deps.ctx.clock.now();
  return { snapshot, deps, now, model: buildModel(snapshot.facts, now, {}, deps.ctx) };
}

/** Only the first row that claims the id answers: a row that finds nothing never falls through. */
export async function resolveIn(
  scope: InspectScope,
  id: string,
  table: readonly InspectRow[] = INSPECT_TABLE,
): Promise<InspectResult | undefined> {
  return table.find((row) => row.claims(id, scope))?.resolve(id, scope);
}

/** The latest sweep's answer for an inspect id, or undefined when nothing in it has that id. */
export function resolveInspect(
  snapshot: InspectSnapshot,
  id: string,
  deps: InspectDependencies,
): Promise<InspectResult | undefined> {
  return resolveIn(inspectScope(snapshot, deps), id);
}
