// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityFigure, SecurityLaneId } from "@spi-code/contracts";
import type { SecurityInput } from "./classify.js";

/** A lane's bar on the page's one scale: its name, subtitle, high count and blocks. */
export function securityFigure(_input: SecurityInput, _lane: SecurityLaneId): SecurityFigure {
  return { label: "", who: "", high: [], blocks: [], empty: [] };
}
