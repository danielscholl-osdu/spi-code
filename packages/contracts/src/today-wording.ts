// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** Today's wording: no internal names, no core verb names, and no › between words. */
export function todayWording(text: string): string {
  return text
    .replace(/\b[A-Z]+(?:_[A-Z]+)+\b/g, "an unrecognised entry")
    .replace(/(^|\. )Absorb the toolchain move\b/g, "$1Make the toolchain move")
    .replace(/(^|\. )Absorb /g, "$1Upgrade ")
    .replace(
      /(^|\. )Pre-classify: (\p{L})/gu,
      (_, lead: string, first: string) => lead + first.toUpperCase(),
    )
    .replace(/(\S) › (?=\S)/g, "$1, step ");
}
