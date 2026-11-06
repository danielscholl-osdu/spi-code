// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SeenState, WatchBriefing, WatchItem } from "@spi-code/contracts";
import type { Model } from "@spi-code/core";
import type { WatchInput } from "./project.js";

export interface SeenBaseline {
  readonly cursor: number;
  readonly items: readonly WatchItem[];
}

export function seenState(_model: Model, _input: WatchInput, _briefing: WatchBriefing): SeenState {
  return { cursor: null, since: [] };
}
