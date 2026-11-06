// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AREAS, type AreaName } from "../facts.js";
import type { LaneLoad } from "../model/lanes.js";
import type { ActionItem } from "./action-item.js";

// A non-enumerable symbol, so JSON, equality, spread and structured clone see the action as the rib draws it.
const SOURCES = Symbol("reasonSources");

/** Records the Facts areas a disabled action's reason was read from; none for host-only state. */
export function sourced(action: ActionItem, from: Iterable<AreaName> | undefined): ActionItem {
  if (action.reason === undefined || from === undefined) return action;
  const areas = new Set(from);
  return Object.defineProperty({ ...action }, SOURCES, {
    value: Object.freeze(AREAS.filter((a) => areas.has(a))),
  });
}

/** The Facts areas behind an action's reason: empty for host-only state, undefined when unrecorded. */
export function reasonSources(action: ActionItem): readonly AreaName[] | undefined {
  return (action as { [SOURCES]?: readonly AreaName[] })[SOURCES];
}

// What a lane-cap reason rests on: the area still unread, or the runs and PR checks counted in flight.
export function loadSources(load: LaneLoad): AreaName[] {
  if (load.unread === "fork workflow runs") return ["runs"];
  return load.unread ? ["github"] : ["github", "runs"];
}

// A stop-the-line judgement reads a PR's failed checks and their job details.
export const JUDGEMENT_SOURCES: readonly AreaName[] = Object.freeze(["github", "details"]);
