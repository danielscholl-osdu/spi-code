// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { parseDestination } from "./destination.js";

it("accepts only the closed set of window destinations", () => {
  expect(parseDestination({ to: "evidence" })).toEqual({ to: "evidence" });
  for (const input of [
    { to: "settings" },
    { to: "evidence", item: "x" },
    { to: "constructor" },
    { to: ["evidence"] },
    ["evidence"],
    "evidence",
    null,
    undefined,
  ])
    expect(parseDestination(input)).toBeUndefined();
});
