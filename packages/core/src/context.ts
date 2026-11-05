// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Clock, systemClock } from "./clock.js";
import { builtInFleet, DEFAULT_FLEET, DEFAULT_PATHS, type Fleet, fleetOf } from "./config.js";
import { type EnvironmentPaths, environmentFromEnv } from "./environment.js";
import type { Rollout } from "./rollout.js";

export interface CoreContext {
  readonly fleet: Fleet;
  readonly paths: EnvironmentPaths;
  readonly rollout?: Rollout;
  readonly clock: Clock;
}

export function createContext(input: Partial<CoreContext> = {}): CoreContext {
  const rollout = input.rollout;
  const clock = input.clock ?? systemClock;
  return Object.freeze({
    fleet: input.fleet ? fleetOf(input.fleet.services) : DEFAULT_FLEET,
    paths: Object.freeze({ ...(input.paths ?? DEFAULT_PATHS) }),
    rollout: rollout
      ? Object.freeze({
          ...rollout,
          ordering: rollout.ordering
            ? Object.freeze(rollout.ordering.map((r) => Object.freeze({
                ...r,
                after: Object.freeze([...r.after]),
              })))
            : undefined,
        })
      : undefined,
    clock: Object.freeze({ now: () => clock.now() }),
  });
}

export const defaultContext = createContext();

export function contextFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  clock: Clock = systemClock,
): CoreContext {
  const paths = environmentFromEnv(env);
  return createContext({ paths, fleet: fleetOf(builtInFleet(paths.servicesFile ?? null)), clock });
}

export function replayFile(context: CoreContext = defaultContext): string | undefined {
  return context.paths.factsFile;
}
