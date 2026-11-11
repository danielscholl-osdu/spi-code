// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Verdict as VerdictField, Mark as VerdictMark } from "@spi-code/contracts";
import { Mark, type MarkTier } from "../../components/kit/Mark.js";

const TIER: Readonly<Record<VerdictMark, MarkTier>> = {
  stopped: "interrupt",
  "needs-person": "surface",
  "in-progress": "ambient",
  "nothing-due": "background",
};

/** Core's one-sentence verdict with its mark; without a verdict nothing is drawn, never a calm mark. */
export function Verdict({ verdict }: { verdict: VerdictField | undefined }) {
  if (!verdict) return null;
  return (
    <div className="today-verdict" data-mark={verdict.mark}>
      <Mark tier={TIER[verdict.mark]} />
      <h2 className="today-headline">{verdict.text}</h2>
    </div>
  );
}
