// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { StationSubstate } from "@spi-code/contracts";
import { type Model, stationSubstateOf } from "@spi-code/core";
import type { WatchInput } from "./project.js";

export function stationSubstate(
  station: Model["lines"][number]["stations"][number],
  line: Model["lines"][number],
  input: WatchInput,
): StationSubstate {
  return stationSubstateOf(station, line, input.facts);
}
