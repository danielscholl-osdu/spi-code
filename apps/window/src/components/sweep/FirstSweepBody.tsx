// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress } from "@spi-code/contracts";
import { useState } from "react";
import { SweepSources } from "./SweepSources.js";
import { SweepStopped } from "./SweepStopped.js";
import { about, readinessCanFix } from "./words.js";
import "./sweep.css";

/** The first sweep's live or stopped panel, shared by Today and sweep Evidence. */
export function FirstSweepBody({
  progress,
  now,
  nextSweepAt,
  onOpenSettings,
  onRequestSweep,
}: {
  progress: SweepProgress | null;
  now: number;
  nextSweepAt?: string | null | undefined;
  onOpenSettings: () => void;
  onRequestSweep: () => void | Promise<void>;
}) {
  const [error, setError] = useState<string>();
  const retry = () => {
    setError(undefined);
    Promise.resolve()
      .then(onRequestSweep)
      .catch(() => setError("Could not send the request to SPI Code."));
  };
  if (progress?.outcome === "failed" || progress?.outcome === "cancelled") {
    return (
      <div className="today-first">
        <h2 className="today-first-lead">The first sweep stopped.</h2>
        <p className="today-first-sub">
          <SweepStopped progress={progress} now={now} nextSweepAt={nextSweepAt} />
        </p>
        <div className="today-first-actions">
          <button type="button" onClick={retry}>
            Try again
          </button>
          {progress.outcome === "failed" && readinessCanFix(progress.code) && (
            <button type="button" onClick={onOpenSettings}>
              Open Settings
            </button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
        <SweepSources progress={progress} now={now} meta={false} onOpenSettings={onOpenSettings} />
      </div>
    );
  }
  return (
    <div className="today-first">
      <h2 className="today-first-lead">First sweep is reading the program.</h2>
      <p className="today-first-sub">
        {progress?.usualMs
          ? `Usually about ${about(progress.usualMs)}.`
          : "A first sweep takes a few minutes. Today opens here when it's done."}
      </p>
      {progress && <SweepSources progress={progress} now={now} onOpenSettings={onOpenSettings} />}
      <p className="today-first-foot">
        You can close this window. SPI Code tells you when Today is ready.
      </p>
    </div>
  );
}
