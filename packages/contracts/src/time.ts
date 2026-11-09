// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** Bind a number or range to its unit, leaving compound durations free to wrap between pairs. */
export function timeUnit(value: number | string, unit: "s" | "min" | "h" | "d"): string {
  return `${value}\u00a0${unit}`;
}
