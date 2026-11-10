// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { BarSegment } from "./SegmentedBar.js";
import "./kit.css";

export type StackTone = "bad" | "warn" | "ok" | "accent" | "upstream" | "neutral";

export interface StackSegment extends BarSegment {
  tone: StackTone;
}

export interface StackedBarProps {
  segments: readonly StackSegment[];
  /** The complete sentence supplied by core, shared by hover and accessible name. */
  text: string;
  /** An optional number beside the bar, as core words it. */
  figure?: string;
}

export function StackedBar({ segments, text, figure }: StackedBarProps) {
  const drawn = segments.filter((segment) => segment.count > 0);
  return (
    <span className="kit-stacked">
      <span className="kit-stacked-bar" role="img" aria-label={text} title={text}>
        <span className="kit-bar" aria-hidden="true">
          {drawn.map(({ id, label, count, tone }) => (
            <span
              key={id}
              className={`kit-segment kit-segment--${tone}`}
              data-count={count}
              style={{ flexGrow: count }}
              title={`${count} ${label}`}
            />
          ))}
        </span>
        {figure !== undefined && <span className="kit-bar-figure">{figure}</span>}
      </span>
      {drawn.length > 0 && (
        <ul className="kit-legend">
          {drawn.map(({ id, label, count, tone }) => (
            <li key={id} data-segment={id}>
              <span className={`kit-swatch kit-segment--${tone}`} aria-hidden="true" />
              <b>{count}</b> {label}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
