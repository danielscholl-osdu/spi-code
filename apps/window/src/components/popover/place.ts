// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export type Box = { top: number; bottom: number; left: number };
export type Size = { width: number; height: number };
export type Placement = { top: number; left: number; side: "below" | "above"; maxHeight?: number };

const GAP = 6;
const MARGIN = 12;

/**
 * Hangs a popover under its anchor, flips it above when only that side fits, and otherwise keeps
 * the roomier side with a height that fits. It never crosses the viewport's margin.
 */
export function placePopover(anchor: Box, size: Size, viewport: Size): Placement {
  const left = Math.max(MARGIN, Math.min(anchor.left, viewport.width - size.width - MARGIN));
  const below = viewport.height - MARGIN - (anchor.bottom + GAP);
  const above = anchor.top - GAP - MARGIN;
  if (size.height <= below) return { top: anchor.bottom + GAP, left, side: "below" };
  if (size.height <= above) return { top: anchor.top - GAP - size.height, left, side: "above" };
  if (below >= above)
    return { top: anchor.bottom + GAP, left, side: "below", maxHeight: Math.max(0, below) };
  const height = Math.max(0, above);
  return { top: anchor.top - GAP - height, left, side: "above", maxHeight: height };
}
