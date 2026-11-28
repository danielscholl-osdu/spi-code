// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createContext, useContext } from "react";
import { clockTime } from "../../time.js";
import type { TodayRead } from "./read.js";

/** The one line that stands in for an empty Blocked and Waiting on you: first read, then reading again, then partly read, then complete. */
export function calmLine(read: TodayRead): string | null {
  if (!read.sweptAt) return read.reading ? "Reading the fleet." : null;
  if (read.reading)
    return `At ${clockTime(read.sweptAt, { hint: false })}, nothing was yours to move.`;
  if (read.gaps.length > 0) return "Nothing is yours in what was read.";
  return "Nothing is yours to move.";
}

export const CalmContext = createContext<string | null>("Nothing is yours to move.");

/** An empty Yours: the caller's own words when it gives any, else the read's line. */
export function YoursCalm({ calm }: { calm: string | null | undefined }) {
  const line = useContext(CalmContext);
  const text = calm === undefined ? line : calm;
  return text ? <p className="today-table-calm">{text}</p> : null;
}
