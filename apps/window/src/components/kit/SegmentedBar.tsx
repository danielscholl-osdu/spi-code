// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import "./kit.css";

export interface BarSegment {
  id: string;
  label: string;
  count: number;
}

export interface SegmentedBarProps {
  segments: readonly BarSegment[];
  /** The number beside the bar, as core words it ("23 · 12 forks"). */
  figure: string;
  /** The complete sentence supplied by core, shared by hover and accessible name. */
  text: string;
  tint?: "upstream";
}

export function SegmentedBar({ segments, figure, text, tint }: SegmentedBarProps) {
  return (
    <span
      className={`kit-segmented${tint ? ` kit-segmented--${tint}` : ""}`}
      role="img"
      aria-label={text}
      title={text}
    >
      <span className="kit-bar" aria-hidden="true">
        {segments
          .filter((segment) => segment.count > 0)
          .map(({ id, label, count }) => (
            <span
              key={id}
              className="kit-segment"
              data-count={count}
              style={{ flexGrow: count }}
              title={`${label} ${count}`}
            />
          ))}
      </span>
      <span className="kit-bar-figure">{figure}</span>
    </span>
  );
}
