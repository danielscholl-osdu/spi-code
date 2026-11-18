// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { widthBudget } from "./width-budget.js";

const allOpen = { sidebar: true, rightPanel: true } as const;

describe("width budget", () => {
  it.each([
    [1600, 1008, "inline", 360, "inline"],
    [1112, 520, "inline", 360, "inline"],
    [1111, 520, "inline", 359, "inline"],
    [1100, 520, "inline", 348, "inline"],
    [1032, 520, "inline", 280, "inline"],
    [1031, 799, "inline", 360, "sheet"],
    [752, 520, "inline", 360, "sheet"],
    [751, 751, "off-canvas", 360, "sheet"],
    [740, 740, "off-canvas", 360, "sheet"],
  ] as const)(
    "fits the sidebar and Detail at %i px",
    (windowWidth, centre, sidebar, detail, presentation) => {
      expect(widthBudget({ context: "thread", windowWidth, open: allOpen })).toEqual({
        centre: { width: centre },
        sidebar: { width: 232, presentation: sidebar },
        rightPanel: { width: detail, presentation },
      });
    },
  );

  it.each([1031, 1032, 1033])("folds Detail at %i px", (windowWidth) => {
    const budget = widthBudget({
      context: "thread",
      windowWidth,
      open: allOpen,
    });
    expect(budget.rightPanel).toEqual(
      windowWidth < 1032
        ? { width: 360, presentation: "sheet" }
        : { width: windowWidth - 752, presentation: "inline" },
    );
    expect(budget.centre.width).toBe(windowWidth < 1032 ? windowWidth - 232 : 520);
  });

  it.each([1472, 1392, 1032, 1112, 1072, 752])(
    "moves the %i px threshold by the sidebar's preferred-width increase",
    (threshold) => {
      for (const offset of [-1, 0, 1]) {
        const original = widthBudget({
          context: "thread",
          windowWidth: threshold + offset,
          open: allOpen,
        });
        const wider = widthBudget({
          context: "thread",
          windowWidth: threshold + offset + 64,
          preferred: { sidebar: 296 },
          open: allOpen,
        });
        const offCanvas = original.sidebar.presentation === "off-canvas";
        expect(wider).toEqual({
          ...original,
          sidebar: { ...original.sidebar, width: 296 },
          centre: { ...original.centre, width: original.centre.width + (offCanvas ? 64 : 0) },
        });
      }
    },
  );

  it("moves the first narrowing threshold by a wider preferred Detail width", () => {
    for (const offset of [-1, 0, 1]) {
      const budget = widthBudget({
        context: "thread",
        windowWidth: 1176 + offset,
        preferred: { rightPanel: 424 },
        open: allOpen,
      });
      expect(budget.rightPanel).toEqual({
        width: 424 + Math.min(offset, 0),
        presentation: "inline",
      });
      expect(budget.centre.width).toBe(520 + Math.max(offset, 0));
    }
  });

  it("restores preferred inline widths after Detail folds, without changing preferences", () => {
    const preferred = Object.freeze({ sidebar: 232, rightPanel: 424 });
    const atMinimum = widthBudget({
      context: "thread",
      windowWidth: 1032,
      preferred,
      open: allOpen,
    });
    expect(atMinimum.rightPanel).toEqual({ width: 280, presentation: "inline" });
    const folded = widthBudget({ context: "thread", windowWidth: 1031, preferred, open: allOpen });
    expect(folded.rightPanel).toEqual({ width: 424, presentation: "sheet" });
    const expanded = widthBudget({
      context: "thread",
      windowWidth: 1600,
      preferred,
      open: allOpen,
    });
    expect(expanded.rightPanel.width).toBe(424);
  });

  it("caps a Detail sheet at the window width less 48, not the saved preference", () => {
    const preferred = Object.freeze({ rightPanel: 900 });
    expect(
      widthBudget({ context: "thread", windowWidth: 740, preferred, open: allOpen }).rightPanel,
    ).toEqual({
      width: 692,
      presentation: "sheet",
    });
    expect(
      widthBudget({ context: "thread", windowWidth: 2200, preferred, open: allOpen }).rightPanel,
    ).toEqual({
      width: 900,
      presentation: "inline",
    });
  });

  it.each([
    [false, false, "closed", "closed"],
    [false, true, "closed", "sheet"],
    [true, false, "off-canvas", "closed"],
    [true, true, "off-canvas", "sheet"],
  ] as const)(
    "omits closed panes (sidebar=%s, Detail=%s)",
    (sidebar, rightPanel, sidebarPresentation, rightPresentation) => {
      expect(
        widthBudget({ context: "thread", windowWidth: 740, open: { sidebar, rightPanel } }),
      ).toEqual({
        centre: { width: 740 },
        sidebar: { width: sidebar ? 232 : 0, presentation: sidebarPresentation },
        rightPanel: { width: rightPanel ? 360 : 0, presentation: rightPresentation },
      });
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 739])(
    "rejects invalid window width %s",
    (windowWidth) => {
      expect(() => widthBudget({ context: "thread", windowWidth, open: allOpen })).toThrow(
        RangeError,
      );
    },
  );

  it.each([{ sidebar: 199 }, { sidebar: 321 }, { rightPanel: 279 }, { rightPanel: Number.NaN }])(
    "rejects invalid preferred widths %j",
    (preferred) => {
      expect(() =>
        widthBudget({ context: "thread", windowWidth: 1600, preferred, open: allOpen }),
      ).toThrow(RangeError);
    },
  );
});

it.each([1600, 1440, 1280, 1100, 980, 900, 752, 740])(
  "reserves no panel outside a thread at %i px",
  (windowWidth) => {
    const budget = widthBudget({ windowWidth, open: allOpen });
    expect(budget).toEqual(
      widthBudget({ windowWidth, context: "thread", open: { ...allOpen, rightPanel: false } }),
    );
    expect(budget.rightPanel).toEqual({ width: 0, presentation: "closed" });
    expect(budget.centre.width).toBeGreaterThanOrEqual(520);
  },
);
