// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PrFact } from "../facts.js";

/** What an open PR needs before it can merge; undefined when its merge and review facts do not say. */
export function gateOf(pr: PrFact, integration: boolean): string | undefined {
  if (pr.draft) return "Draft";
  if (pr.mergeState === "DIRTY") return "Merge conflicts";
  if (pr.mergeState === "BEHIND") return integration ? "Update branch, then approve" : "Update branch";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
  if (pr.reviewDecision === "APPROVED") return "Approved";
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    const reviews = pr.reviewers;
    return reviews && !reviews.cut && !reviews.requested.length && !reviews.latest.length
      ? "No reviewer"
      : "Review required";
  }
  return undefined;
}
