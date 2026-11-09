// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Envelope, SweepProgress, SweepSourceProgress } from "@spi-code/contracts";
import type { ReactNode } from "react";
import { sourceName, sourceReads } from "../evidence/words.js";
import {
  at,
  duration,
  failedCount,
  readinessCanFix,
  type SourceOutcome,
  sourceOutcome,
  sweepEnd,
} from "./words.js";
import "./sweep.css";

const GITLAB_SOURCES: ReadonlySet<string> = new Set(["upstream", "radar"]);

function outcomeOf(
  progress: SweepProgress,
  source: SweepSourceProgress,
  now: number,
  last: Envelope | undefined,
): SourceOutcome {
  const stoppedHere =
    progress.outcome === "failed" &&
    progress.source === source.source &&
    (source.state === "reading" || source.state === "throttled");
  return stoppedHere
    ? { mark: "✕", tone: "bad", text: "failed", why: progress.failure, code: progress.code }
    : sourceOutcome(source, now, last);
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function Outcome({ outcome, now }: { outcome: SourceOutcome; now: number }) {
  return (
    <>
      {outcome.text}
      {outcome.after && (
        <>
          {" · "}
          <span className="sweep-after">
            after <time dateTime={outcome.after}>{at(outcome.after, now)}</time>
          </span>
        </>
      )}
    </>
  );
}

/**
 * One sweep's sources in sweep order: the meta line, a throttle notice, one bar segment per source,
 * and a row each with its mark, name, what it reads and how it went. Today shows it on first
 * launch; Evidence shows the same list for a later sweep, with each source's `fact` after its
 * outcome and its `envelope`, so a source not due this sweep shows how its last read went.
 */
export function SweepSources({
  progress,
  now,
  meta = true,
  onOpenSettings,
  fact,
  envelope,
}: {
  progress: SweepProgress;
  now: number;
  meta?: boolean;
  onOpenSettings: () => void;
  fact?: ((source: string) => ReactNode) | undefined;
  envelope?: ((source: string) => Envelope | undefined) | undefined;
}) {
  const end = sweepEnd(progress, now);
  const running = progress.outcome === "running";
  const stopped = progress.outcome === "failed";
  const failures = failedCount(progress);
  const throttled = running
    ? progress.sources
        .flatMap((source) => (source.state === "throttled" ? [source] : []))
        .sort((a, b) => Date.parse(a.resumeAt) - Date.parse(b.resumeAt))[0]
    : undefined;
  const rows = progress.sources.map((source) => ({
    source,
    outcome: outcomeOf(progress, source, end, envelope?.(source.source)),
  }));
  return (
    <div className="sweep-sources">
      {meta && (
        <p className="sweep-meta">
          {duration(end - Date.parse(progress.startedAt))} so far
          {failures > 0 && ` · ${failures} source${failures === 1 ? "" : "s"} failed`}
        </p>
      )}
      {throttled && (
        <p className="sweep-throttled">
          {GITLAB_SOURCES.has(throttled.source) ? "GitLab" : "GitHub"} asked SPI Code to slow down.
          Resumes at <time dateTime={throttled.resumeAt}>{at(throttled.resumeAt, now)}</time>.
        </p>
      )}
      <div className="sweep-bar" aria-hidden="true">
        {rows.map(({ source, outcome }) => (
          <span key={source.source} className="sweep-segment" data-tone={outcome.tone} />
        ))}
      </div>
      <ul className="sweep-rows" aria-label="Sources">
        {rows.map(({ source, outcome }) => {
          const failed = outcome.tone === "bad";
          const signin = failed && readinessCanFix(outcome.code);
          const extra = fact?.(source.source);
          const why =
            outcome.why &&
            (running && failed && !signin
              ? `${sentence(outcome.why)} Today will say what is missing.`
              : sentence(outcome.why));
          return (
            <li
              key={source.source}
              className="sweep-row"
              data-source={source.source}
              data-tone={outcome.tone}
            >
              <span className="sweep-mark" aria-hidden="true">
                {outcome.mark}
              </span>
              <span className="sweep-name">{sourceName(source.source)}</span>
              <span className="sweep-what">{sourceReads(source.source) ?? ""}</span>
              <span
                className="sweep-outcome"
                title={outcome.detail}
                aria-description={outcome.detail}
              >
                <Outcome outcome={outcome} now={now} />
                {extra && <> · {extra}</>}
                {stopped && failed && why && ` · ${why}`}
              </span>
              {why && (!(stopped && failed) || (progress.first && signin)) && (
                <span className="sweep-why">
                  {!(stopped && failed) && why}
                  {signin && (
                    <button type="button" onClick={onOpenSettings}>
                      Open Settings
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
