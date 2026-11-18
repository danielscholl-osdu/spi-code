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

import type { CheckFact } from "../facts.js";
import { latestChecks } from "../model/checks.js";

type Status = "failure" | "cancelled" | "pending" | "action-required" | "success" | "neutral";

export function pullRequestChecksState(
  checks: ReadonlyArray<{ status: Status }>,
): "failing" | "pending" | "passing" | null {
  const statuses = new Set(checks.map((check) => check.status));
  if (statuses.has("failure") || statuses.has("cancelled")) return "failing";
  if (statuses.has("pending") || statuses.has("action-required")) return "pending";
  return statuses.has("success") ? "passing" : null;
}

function checkStatus(check: CheckFact): Status {
  if (check.status !== "COMPLETED") return "pending";
  switch (check.conclusion) {
    case "SUCCESS": return "success";
    case "CANCELLED": return "cancelled";
    case "ACTION_REQUIRED": return "action-required";
    case "FAILURE":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    case "STALE": return "failure";
    default: return "neutral";
  }
}

export function checksOf(facts: readonly CheckFact[]) {
  const checks = latestChecks(facts).map((check) => ({ name: check.name, status: checkStatus(check) }));
  return {
    state: pullRequestChecksState(checks),
    passed: checks.filter(({ status }) => status === "success").length,
    failed: [...new Set(checks.filter(({ status }) => status === "failure" || status === "cancelled").map(({ name }) => name))],
  };
}
