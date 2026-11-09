// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { ordinal, placeLine } from "./BeforeFirstSweep.js";
import { midSweep } from "./test-helper.js";

it("gives each place its line and where its source falls in the first sweep", () => {
  const progress = midSweep();
  expect(
    [
      { kind: "upstream" },
      { kind: "environment" },
      { kind: "engineering-system" },
      { kind: "releases" },
      { kind: "security" },
      { kind: "service", id: "partition" },
      { kind: "release", month: "2026-11" },
    ].map((route) => placeLine(route as Parameters<typeof placeLine>[0], progress)),
  ).toEqual([
    "Upstream opens after the first sweep. It is read 9th of 12.",
    "Environment opens after the first sweep. It is read 6th of 12.",
    "Engineering system opens after the first sweep. It is read 7th of 12.",
    "Releases opens after the first sweep. It is read 12th of 12.",
    "Security opens after the first sweep. It is read 11th of 12.",
    "partition opens after the first sweep. It is read 2nd of 12.",
    "Release 2026-11 opens after the first sweep. It is read 12th of 12.",
  ]);
});

it("leaves out the position before any progress or when the sweep does not read the source", () => {
  expect(placeLine({ kind: "upstream" }, null)).toBe("Upstream opens after the first sweep.");
  const progress = midSweep();
  const without = {
    ...progress,
    sources: progress.sources.filter(({ source }) => source !== "upstream"),
  };
  expect(placeLine({ kind: "upstream" }, without)).toBe("Upstream opens after the first sweep.");
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
    "1st",
    "2nd",
    "3rd",
    "4th",
    "11th",
    "12th",
    "13th",
    "21st",
    "22nd",
    "23rd",
    "101st",
    "111th",
  ]);
});
