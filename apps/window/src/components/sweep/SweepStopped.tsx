// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress } from "@spi-code/contracts";
import { sourceName } from "../evidence/words.js";
import { at } from "./words.js";

/** Where a sweep stopped and why, and when SPI Code tries again. */
export function SweepStopped({
  progress,
  now,
}: {
  progress: Extract<SweepProgress, { outcome: "failed" }>;
  now: number;
}) {
  const reason = progress.failure.replace(/[.!?]$/, "");
  const where = progress.source ? `while reading ${sourceName(progress.source)}` : "while saving";
  return (
    <>
      It stopped {where}: {reason}.
      {progress.nextAttemptAt && (
        <>
          {" SPI Code tries again at "}
          <time dateTime={progress.nextAttemptAt}>{at(progress.nextAttemptAt, now)}</time>.
        </>
      )}
    </>
  );
}
