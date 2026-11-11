// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type PaneGeometry, type Pixels, stitchPane } from "./smoke-stitch.js";

const CONTENT = 1;
const CHROME = 2;

/** A window whose every device row says what it shows: a pane content row, or a window row. */
function capture(page: PaneGeometry, scale: number, scrollTop: number): Pixels {
  const [width, height] = [page.width * scale, page.height * scale];
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [cssX, cssY] = [Math.floor(x / scale), Math.floor(y / scale)];
      const inPane =
        cssX >= page.left &&
        cssX < page.left + page.clientWidth &&
        cssY >= page.top &&
        cssY < page.top + page.clientHeight;
      const code = inPane ? cssY - page.top + scrollTop : cssY;
      bitmap.set([code, inPane ? CONTENT : CHROME, 0, 255], (y * width + x) * 4);
    }
  return { width, height, bitmap };
}

const at = (image: Pixels, cssX: number, y: number, scale: number) => {
  const offset = (y * image.width + cssX * scale) * 4;
  return [image.bitmap[offset], image.bitmap[offset + 1]];
};

describe("stitchPane", () => {
  const cases = [1, 2].flatMap((scale) =>
    [6, 7, 8, 11, 12, 13, 14, 19].map((scrollHeight) => ({ scale, scrollHeight })),
  );
  it.each(cases)(
    "draws every pane row exactly once at $scale x with scrollHeight $scrollHeight",
    async ({ scale, scrollHeight }) => {
      const page: PaneGeometry = {
        width: 4,
        height: 10,
        left: 1,
        top: 2,
        clientWidth: 2,
        clientHeight: 6,
        scrollHeight,
      };
      const extra = scrollHeight - page.clientHeight;
      const image = await stitchPane(page, capture(page, scale, 0), async (target) => ({
        scrolled: target,
        strip: capture(page, scale, target),
      }));
      expect(image.height).toBe((page.height + extra) * scale);
      for (let y = 0; y < image.height; y++) {
        const cssY = Math.floor(y / scale);
        const pane =
          cssY < page.top
            ? [cssY, CHROME]
            : cssY < page.top + scrollHeight
              ? [cssY - page.top, CONTENT]
              : [cssY - extra, CHROME];
        expect(at(image, page.left, y, scale), `pane device row ${y}`).toEqual(pane);
        const beside =
          cssY < page.top + page.clientHeight
            ? cssY
            : cssY < page.top + scrollHeight
              ? page.top + page.clientHeight - 1
              : cssY - extra;
        expect(at(image, 0, y, scale), `side device row ${y}`).toEqual([beside, CHROME]);
      }
    },
  );

  it("fails when the pane does not scroll", async () => {
    const page: PaneGeometry = {
      width: 4,
      height: 10,
      left: 1,
      top: 2,
      clientWidth: 2,
      clientHeight: 6,
      scrollHeight: 13,
    };
    await expect(
      stitchPane(page, capture(page, 1, 0), async () => ({
        scrolled: 0,
        strip: capture(page, 1, 0),
      })),
    ).rejects.toThrow("Today's pane did not scroll");
  });
});
