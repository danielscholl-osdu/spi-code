// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { widthBudget } from "./width-budget.js";

const allOpen = { sidebar: true, rightPanel: true, lineSheet: true } as const;

describe("width budget", () => {
  it.each([
    [1600, false, 1008, "inline", 0, "closed", 360, "inline", 1, 0],
    [1440, true, 520, "inline", 360, "inline", 328, "inline", 1, 1],
    [1280, true, 688, "inline", 360, "inline", 360, "sheet", 1, 1],
    [1100, false, 520, "inline", 0, "closed", 348, "inline", 1, 0],
    [1100, true, 520, "inline", 348, "inline", 360, "sheet", 1, 1],
    [980, false, 748, "inline", 0, "closed", 360, "sheet", 1, 0],
    [900, true, 668, "inline", 668, "stacked", 360, "sheet", 0.5, 0.5],
    [740, false, 740, "off-canvas", 0, "closed", 360, "sheet", 1, 0],
  ] as const)(
    "matches the drawn %i px case with Line pinned=%s",
    (windowWidth, lineSheet, centreWidth, sidebarPresentation, lineWidth, linePresentation, rightWidth, rightPresentation, centreHeight, lineHeight) => {
      expect(widthBudget({ windowWidth, open: { ...allOpen, lineSheet } })).toEqual({
        centre: { width: centreWidth, heightFraction: centreHeight },
        sidebar: { width: 232, presentation: sidebarPresentation },
        rightPanel: { width: rightWidth, presentation: rightPresentation },
        lineSheet: {
          width: lineWidth,
          presentation: linePresentation,
          heightFraction: lineHeight,
        },
      });
    },
  );

  it.each([
    [1472, "rightPanel", { width: 360, presentation: "inline" }, { width: 359 }],
    [1392, "lineSheet", { width: 360, presentation: "inline" }, { width: 359 }],
    [
      1352,
      "rightPanel",
      { width: 280, presentation: "inline" },
      { width: 360, presentation: "sheet" },
    ],
    [1112, "lineSheet", { width: 360, presentation: "inline" }, { width: 359 }],
    [1072, "lineSheet", { presentation: "inline" }, { width: 839, presentation: "stacked" }],
    [752, "sidebar", { width: 232, presentation: "inline" }, { presentation: "off-canvas" }],
  ] as const)(
    "uses the first fitting step at %i px and either side",
    (threshold, pane, at, below) => {
      const aboveBudget = widthBudget({ windowWidth: threshold + 1, open: allOpen });
      const atBudget = widthBudget({ windowWidth: threshold, open: allOpen });
      const belowBudget = widthBudget({ windowWidth: threshold - 1, open: allOpen });
      expect(aboveBudget[pane]).toMatchObject(at);
      expect(atBudget[pane]).toMatchObject(at);
      expect(belowBudget[pane]).toMatchObject(below);
      if (threshold === 1072) {
        expect(aboveBudget.lineSheet.width).toBe(321);
        expect(atBudget.lineSheet.width).toBe(320);
      }
      for (const budget of [aboveBudget, atBudget, belowBudget]) {
        expect(budget.centre.width).toBeGreaterThanOrEqual(520);
      }
    },
  );

  it.each([1031, 1032, 1033])("folds Detail without a pinned Line at %i px", (windowWidth) => {
    const budget = widthBudget({ windowWidth, open: { ...allOpen, lineSheet: false } });
    expect(budget.rightPanel).toEqual(
      windowWidth < 1032
        ? { width: 360, presentation: "sheet" }
        : { width: windowWidth - 752, presentation: "inline" },
    );
    expect(budget.centre.width).toBe(windowWidth < 1032 ? windowWidth - 232 : 520);
  });

  it.each([1472, 1392, 1352, 1112, 1072, 752])(
    "moves the %i px threshold by the sidebar's preferred-width increase",
    (threshold) => {
      for (const offset of [-1, 0, 1]) {
        const original = widthBudget({ windowWidth: threshold + offset, open: allOpen });
        const wider = widthBudget({
          windowWidth: threshold + offset + 64,
          preferred: { sidebar: 296 },
          open: allOpen,
        });
        const offCanvas = original.sidebar.presentation === "off-canvas";
        expect(wider).toEqual({
          ...original,
          sidebar: { ...original.sidebar, width: 296 },
          centre: { ...original.centre, width: original.centre.width + (offCanvas ? 64 : 0) },
          lineSheet: {
            ...original.lineSheet,
            width: original.lineSheet.width + (offCanvas ? 64 : 0),
          },
        });
      }
    },
  );

  it.each(["rightPanel", "lineSheet"] as const)(
    "moves the first narrowing threshold by a wider preferred %s",
    (pane) => {
      for (const offset of [-1, 0, 1]) {
        const budget = widthBudget({
          windowWidth: 1472 + 64 + offset,
          preferred: { [pane]: 424 },
          open: allOpen,
        });
        expect(budget.rightPanel).toEqual({
          width: (pane === "rightPanel" ? 424 : 360) + Math.min(offset, 0),
          presentation: "inline",
        });
        expect(budget.lineSheet.width).toBe(pane === "lineSheet" ? 424 : 360);
        expect(budget.centre.width).toBe(520 + Math.max(offset, 0));
      }
    },
  );

  it("restores preferred inline widths after Detail folds, without changing preferences", () => {
    const preferred = Object.freeze({ sidebar: 232, rightPanel: 424, lineSheet: 424 });
    const atMinimum = widthBudget({ windowWidth: 1352, preferred, open: allOpen });
    expect(atMinimum.rightPanel).toEqual({ width: 280, presentation: "inline" });
    expect(atMinimum.lineSheet.width).toBe(320);
    const folded = widthBudget({ windowWidth: 1351, preferred, open: allOpen });
    expect(folded.rightPanel).toEqual({ width: 424, presentation: "sheet" });
    expect(folded.lineSheet.width).toBe(424);
    const expanded = widthBudget({ windowWidth: 1600, preferred, open: allOpen });
    expect(expanded.rightPanel.width).toBe(424);
    expect(expanded.lineSheet.width).toBe(424);
  });

  it("caps a Detail sheet at the window width less 48, not the saved preference", () => {
    const preferred = Object.freeze({ rightPanel: 900 });
    expect(widthBudget({ windowWidth: 740, preferred, open: allOpen }).rightPanel).toEqual({
      width: 692,
      presentation: "sheet",
    });
    expect(widthBudget({ windowWidth: 2200, preferred, open: allOpen }).rightPanel).toEqual({
      width: 900,
      presentation: "inline",
    });
  });

  it.each([
    [false, false, false, 740, "closed", 0, "closed", 0, "closed", 1, 0],
    [false, true, false, 740, "closed", 0, "closed", 0, "sheet", 1, 0],
    [false, false, true, 740, "closed", 0, "stacked", 740, "closed", 0.5, 0.5],
    [false, true, true, 740, "closed", 0, "stacked", 740, "sheet", 0.5, 0.5],
    [true, false, false, 740, "off-canvas", 232, "closed", 0, "closed", 1, 0],
    [true, false, true, 740, "off-canvas", 232, "stacked", 740, "closed", 0.5, 0.5],
  ] as const)(
    "omits closed panes (sidebar=%s, Detail=%s, Line=%s)",
    (sidebar, rightPanel, lineSheet, centreWidth, sidebarPresentation, sidebarWidth, linePresentation, lineWidth, rightPresentation, centreHeight, lineHeight) => {
      const budget = widthBudget({ windowWidth: 740, open: { sidebar, rightPanel, lineSheet } });
      expect(budget).toEqual({
        centre: { width: centreWidth, heightFraction: centreHeight },
        sidebar: { width: sidebarWidth, presentation: sidebarPresentation },
        rightPanel: { width: rightPanel ? 360 : 0, presentation: rightPresentation },
        lineSheet: { width: lineWidth, presentation: linePresentation, heightFraction: lineHeight },
      });
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 739])(
    "rejects invalid window width %s",
    (windowWidth) => {
      expect(() => widthBudget({ windowWidth, open: allOpen })).toThrow(RangeError);
    },
  );

  it.each([
    { sidebar: 199 },
    { sidebar: 321 },
    { rightPanel: 279 },
    { lineSheet: 319 },
    { rightPanel: Number.NaN },
    { lineSheet: Number.POSITIVE_INFINITY },
  ])("rejects invalid preferred widths %j", (preferred) => {
    expect(() => widthBudget({ windowWidth: 1600, preferred, open: allOpen })).toThrow(RangeError);
  });
});
