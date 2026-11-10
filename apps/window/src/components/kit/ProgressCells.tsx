// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import "./kit.css";

export interface ProgressCellsProps {
  filled: number;
  total: number;
  /** The number beside the cells, as core words it ("7/13"). */
  figure: string;
  /** The complete sentence supplied by core, shared by hover and accessible name. */
  text: string;
}

export function ProgressCells({ filled, total, figure, text }: ProgressCellsProps) {
  const count = Math.max(0, Math.floor(total));
  const done = Math.min(count, Math.max(0, Math.floor(filled)));
  return (
    <span className="kit-progress" role="img" aria-label={text} title={text}>
      <span className="kit-cells" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional and carry no identity
            key={index}
            className={`kit-cell kit-cell--${index < done ? "filled" : "outlined"}`}
          />
        ))}
      </span>
      <span className="kit-bar-figure">{figure}</span>
    </span>
  );
}
