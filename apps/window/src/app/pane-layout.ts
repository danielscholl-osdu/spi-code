// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PaneWidths, WidthBudget } from "./width-budget.js";

export type ResizablePane = keyof PaneWidths;
export type PaneStorage = Pick<Storage, "getItem" | "setItem">;

export const PANES_STORAGE_KEY = "spi-code.panes";
export const CENTRE_MINIMUM = 520;
const MAX_WINDOW_FRACTION = 0.55;

export const PANE_BOUNDS: Record<
  ResizablePane,
  { readonly min: number; readonly max?: number; readonly defaultWidth: number }
> = {
  sidebar: { min: 200, max: 320, defaultWidth: 232 },
  rightPanel: { min: 280, defaultWidth: 360 },
  lineSheet: { min: 320, defaultWidth: 360 },
};

/** What a machine remembers of its panes. The pinned Line sheet's open state is the navigation's. */
export interface SavedPanes {
  readonly widths: PaneWidths;
  readonly open: { readonly sidebar: boolean; readonly rightPanel: boolean };
}

const DEFAULTS: SavedPanes = {
  widths: { sidebar: 232, rightPanel: 360, lineSheet: 360 },
  open: { sidebar: true, rightPanel: false },
};

function localStore(): PaneStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function savedWidth(value: unknown, pane: ResizablePane): number {
  const { min, max = Infinity, defaultWidth } = PANE_BOUNDS[pane];
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value)
    : defaultWidth;
}

function savedFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function loadPanes(storage: PaneStorage | undefined = localStore()): SavedPanes {
  let saved: unknown;
  try {
    const text = storage?.getItem(PANES_STORAGE_KEY);
    saved = text ? JSON.parse(text) : undefined;
  } catch {
    saved = undefined;
  }
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const widths = record(record(saved).widths);
  const open = record(record(saved).open);
  return {
    widths: {
      sidebar: savedWidth(widths.sidebar, "sidebar"),
      rightPanel: savedWidth(widths.rightPanel, "rightPanel"),
      lineSheet: savedWidth(widths.lineSheet, "lineSheet"),
    },
    open: {
      sidebar: savedFlag(open.sidebar, DEFAULTS.open.sidebar),
      rightPanel: savedFlag(open.rightPanel, DEFAULTS.open.rightPanel),
    },
  };
}

export function savePanes(
  change: { widths?: Partial<PaneWidths>; open?: Partial<SavedPanes["open"]> },
  storage: PaneStorage | undefined = localStore(),
): void {
  const current = loadPanes(storage);
  const next: SavedPanes = {
    widths: { ...current.widths, ...change.widths },
    open: { ...current.open, ...change.open },
  };
  try {
    storage?.setItem(PANES_STORAGE_KEY, JSON.stringify(next));
  } catch {}
}

/** The widest preferred width a pane may take: the sidebar's own maximum, or 55% of the window. */
export function paneMaximum(pane: ResizablePane, windowWidth: number): number {
  const { min, max } = PANE_BOUNDS[pane];
  return Math.max(min, max ?? Math.floor(windowWidth * MAX_WINDOW_FRACTION));
}

/** Saved widths held within the current window's maxima, for the width budget. The saved ones stay. */
export function budgetPreferred(widths: PaneWidths, windowWidth: number): PaneWidths {
  const hold = (pane: ResizablePane) =>
    Math.max(PANE_BOUNDS[pane].min, Math.min(widths[pane], paneMaximum(pane, windowWidth)));
  return { sidebar: hold("sidebar"), rightPanel: hold("rightPanel"), lineSheet: hold("lineSheet") };
}

/** The widest a pane may be dragged to while the centre keeps 520 px beside the other inline panes. */
export function paneStop(pane: ResizablePane, budget: WidthBudget, windowWidth: number): number {
  const inline = (other: ResizablePane) =>
    other !== pane && budget[other].presentation === "inline" ? budget[other].width : 0;
  return (
    windowWidth - CENTRE_MINIMUM - inline("sidebar") - inline("rightPanel") - inline("lineSheet")
  );
}
