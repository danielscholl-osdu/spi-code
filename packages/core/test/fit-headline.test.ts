// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { fitHeadline } from "../src/util.js";

const at = "2026-11-07T00:00:00.000Z";

it("counts an instant as the date and clock time the window may draw it as", () => {
  const twelve = `At ${at}, 2 commits reach 1 fork; 23 in a sync PR.`;
  const short = `At ${at}, 2 commits reach 1 fork.`;
  expect(fitHeadline([twelve, short])).toBe(short);
  expect(fitHeadline(["At 18:00, 2 commits reach 1 fork; 23 in a sync PR.", short])).toBe(
    "At 18:00, 2 commits reach 1 fork; 23 in a sync PR.",
  );
});
