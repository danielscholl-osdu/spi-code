// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress, SweepSourceProgress } from "@spi-code/contracts";
import { sourceName, sourceReads } from "../evidence/words.js";
import { at, duration, failedCount, type SourceOutcome, sourceOutcome, sweepEnd } from "./words.js";
import "./sweep.css";

const GITLAB_SOURCES: ReadonlySet<string> = new Set(["upstream", "radar"]);

function outcomeOf(
  progress: SweepProgress,
  source: SweepSourceProgress,
  now: number,
): SourceOutcome {
  const stoppedHere =
    progress.outcome === "failed" &&
    progress.source === source.source &&
    (source.state === "reading" || source.state === "throttled");
  return stoppedHere
    ? { mark: "✕", tone: "bad", text: "failed", why: progress.failure, code: progress.code }
    : sourceOutcome(source, now);
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
          {" · after "}
          <time dateTime={outcome.after}>{at(outcome.after, now)}</time>
        </>
      )}
    </>
  );
}

/**
 * One sweep's sources in sweep order: the meta line, a throttle notice, one bar segment per source,
 * and a row each with its mark, name, what it reads and how it went. Today shows it on first
 * launch; Evidence shows the same list for a later sweep.
 */
export function SweepSources({
  progress,
  now,
  meta = true,
  onOpenSettings,
}: {
  progress: SweepProgress;
  now: number;
  meta?: boolean;
  onOpenSettings: () => void;
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
    outcome: outcomeOf(progress, source, end),
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
          const signin = failed && outcome.code === "signin";
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
              <span className="sweep-outcome">
                <Outcome outcome={outcome} now={now} />
                {stopped && failed && why && ` · ${why}`}
              </span>
              {why && !(stopped && failed) && (
                <span className="sweep-why">
                  {why}
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
