// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { expect, test } from "vitest";
import { checksOf, pullRequestChecksState } from "../src/brief/service-work-checks";

// Check combinations in T3 Code's pullRequestDetail.logic.test.ts, plus terminal edge cases.
test.each([
  [["success"], "passing"],
  [["success", "pending"], "pending"],
  [["action-required"], "pending"],
  [["failure"], "failing"],
  [["failure", "pending"], "failing"],
  [["cancelled", "success"], "failing"],
  [["neutral"], null],
  [[], null],
] as const)("classifies %j as %s", (statuses, state) => {
  expect(pullRequestChecksState(statuses.map((status) => ({ status })))).toBe(state);
});

test("keeps the newest attempt and names failed checks beside the passed count", () => {
  expect(
    checksOf([
      { id: 1, name: "Build", status: "COMPLETED", conclusion: "FAILURE" },
      { id: 2, name: "Build", status: "COMPLETED", conclusion: "SUCCESS" },
      { id: 3, name: "license/cla", status: "COMPLETED", conclusion: "FAILURE" },
    ]),
  ).toEqual({ state: "failing", passed: 1, failed: ["license/cla"] });
});
