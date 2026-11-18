// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export interface PaneWidths {
  readonly sidebar: number;
  readonly rightPanel: number;
}

export interface WidthBudgetInput {
  readonly windowWidth: number;
  readonly context?: "thread";
  readonly preferred?: Partial<PaneWidths>;
  readonly open: {
    readonly sidebar: boolean;
    readonly rightPanel: boolean;
  };
}

export interface WidthBudget {
  readonly centre: { readonly width: number };
  readonly sidebar: {
    readonly width: number;
    readonly presentation: "inline" | "off-canvas" | "closed";
  };
  readonly rightPanel: {
    readonly width: number;
    readonly presentation: "inline" | "sheet" | "closed";
  };
}

function validateWidth(name: string, width: number, minimum: number, maximum = Infinity) {
  if (!Number.isFinite(width) || width < minimum || width > maximum) {
    throw new RangeError(`${name} width must be finite and between ${minimum} and ${maximum} px`);
  }
}

export function widthBudget({
  windowWidth,
  preferred,
  open: requested,
  context,
}: WidthBudgetInput): WidthBudget {
  const open = { ...requested, rightPanel: context === "thread" && requested.rightPanel };
  validateWidth("Window", windowWidth, 740);
  const sidebar = preferred?.sidebar ?? 232;
  const rightPanel = preferred?.rightPanel ?? 360;
  validateWidth("Preferred sidebar", sidebar, 200, 320);
  validateWidth("Preferred right panel", rightPanel, 280);

  const sidebarWidth = open.sidebar ? sidebar : 0;
  let sidebarPresentation: WidthBudget["sidebar"]["presentation"] = open.sidebar
    ? "inline"
    : "closed";
  let rightPresentation: WidthBudget["rightPanel"]["presentation"] = open.rightPanel
    ? "inline"
    : "closed";
  const available = windowWidth - sidebarWidth;
  let centreWidth = available;
  let rightWidth = 0;
  if (open.rightPanel) {
    if (available >= 800) {
      rightWidth = Math.min(rightPanel, available - 520);
      centreWidth -= rightWidth;
    } else {
      rightPresentation = "sheet";
      rightWidth = Math.min(rightPanel, windowWidth - 48);
    }
  }
  if (centreWidth < 520 && open.sidebar) {
    sidebarPresentation = "off-canvas";
    centreWidth = windowWidth;
  }
  return {
    centre: { width: centreWidth },
    sidebar: { width: sidebarWidth, presentation: sidebarPresentation },
    rightPanel: { width: rightWidth, presentation: rightPresentation },
  };
}
