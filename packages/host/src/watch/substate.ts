// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { StationSubstate } from "@spi-code/contracts";
import type { Model } from "@spi-code/core";
import type { WatchInput } from "./project.js";

export function stationSubstate(
  station: Model["lines"][number]["stations"][number],
  _line: Model["lines"][number],
  _input: WatchInput,
): StationSubstate {
  if (station.state === "stopped") return "stopped";
  if (station.state === "moving") return "in-progress";
  return "ready";
}
