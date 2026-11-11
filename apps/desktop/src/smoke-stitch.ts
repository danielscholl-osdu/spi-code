// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";

export type Pixels = { width: number; height: number; bitmap: Buffer };

/** The window and its scrolling pane, in CSS pixels. */
export interface PaneGeometry {
  width: number;
  height: number;
  left: number;
  top: number;
  clientWidth: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * The window at rest with the pane drawn to its full height: the pane is captured strip by strip
 * as it scrolls, and the columns beside it continue their last row below the window.
 */
export async function stitchPane(
  page: PaneGeometry,
  first: Pixels,
  scrollTo: (target: number) => Promise<{ scrolled: number; strip: Pixels }>,
): Promise<Pixels> {
  const scale = first.width / page.width;
  const extra = Math.max(0, page.scrollHeight - page.clientHeight);
  const px = (css: number) => Math.round(css * scale);
  const row = first.width * 4;
  const out = Buffer.alloc(row * px(page.height + extra));
  const paneBottom = px(page.top + page.clientHeight);
  const extraRows = px(page.height + extra) - first.height;
  first.bitmap.copy(out, 0, 0, paneBottom * row);
  first.bitmap.copy(out, (paneBottom + extraRows) * row, paneBottom * row);
  const last = first.bitmap.subarray((paneBottom - 1) * row, paneBottom * row);
  for (let y = paneBottom; y < paneBottom + extraRows; y++) last.copy(out, y * row);
  const [left, right] = [px(page.left), px(page.left + page.clientWidth)];
  const paneEnd = out.length / row - (first.height - paneBottom);
  let covered = page.clientHeight;
  while (covered < page.scrollHeight) {
    const target = Math.min(covered, extra);
    const { scrolled, strip } = await scrollTo(target);
    assert.equal(strip.width, first.width, "Capture width changed while scrolling");
    const atEnd = target === extra;
    const end = atEnd
      ? page.scrollHeight
      : Math.min(page.scrollHeight, scrolled + page.clientHeight);
    const stop = atEnd ? paneEnd : px(page.top + end);
    for (let y = px(page.top + covered); y < stop; y++) {
      const from = Math.min(y - px(scrolled), strip.height - 1);
      if (from < 0) continue;
      strip.bitmap.copy(out, y * row + left * 4, from * row + left * 4, from * row + right * 4);
    }
    assert(end > covered, "Today's pane did not scroll");
    covered = end;
  }
  return { width: first.width, height: out.length / row, bitmap: out };
}
