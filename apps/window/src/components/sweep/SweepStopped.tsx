// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress } from "@spi-code/contracts";
import { sourceName } from "../evidence/words.js";
import { at } from "./words.js";

/** Where a sweep stopped and why, and when SPI Code tries again. */
export function SweepStopped({
  progress,
  now,
  nextSweepAt,
}: {
  progress: SweepProgress;
  now: number;
  nextSweepAt?: string | null | undefined;
}) {
  const failure = progress.outcome === "failed" ? progress : null;
  const retryAt = failure ? failure.nextAttemptAt : nextSweepAt;
  const reason = failure?.failure.replace(/[.!?]$/, "");
  const where = failure?.source ? `while reading ${sourceName(failure.source)}` : "while saving";
  return (
    <>
      {failure ? `It stopped ${where}: ${reason}.` : "The sweep was cancelled."}
      {retryAt && Date.parse(retryAt) > now && (
        <>
          {" SPI Code tries again at "}
          <time dateTime={retryAt}>{at(retryAt, now)}</time>.
        </>
      )}
    </>
  );
}
