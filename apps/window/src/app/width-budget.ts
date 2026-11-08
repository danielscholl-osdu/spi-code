// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export interface PaneWidths {
  readonly sidebar: number;
  readonly rightPanel: number;
  readonly lineSheet: number;
}

export interface WidthBudgetInput {
  readonly windowWidth: number;
  readonly preferred?: Partial<PaneWidths>;
  readonly open: {
    readonly sidebar: boolean;
    readonly rightPanel: boolean;
    readonly lineSheet: boolean;
  };
}

export interface WidthBudget {
  readonly centre: { readonly width: number; readonly heightFraction: 1 | 0.5 };
  readonly sidebar: {
    readonly width: number;
    readonly presentation: "inline" | "off-canvas" | "closed";
  };
  readonly rightPanel: {
    readonly width: number;
    readonly presentation: "inline" | "sheet" | "closed";
  };
  readonly lineSheet: {
    readonly width: number;
    readonly presentation: "inline" | "stacked" | "closed";
    readonly heightFraction: 0 | 0.5 | 1;
  };
}

function validateWidth(name: string, width: number, minimum: number, maximum = Infinity) {
  if (!Number.isFinite(width) || width < minimum || width > maximum) {
    throw new RangeError(`${name} width must be finite and between ${minimum} and ${maximum} px`);
  }
}

function narrow(windowWidth: number, sidebar: number, rightPanel: number, lineSheet: number) {
  let deficit = Math.max(0, 520 + sidebar + rightPanel + lineSheet - windowWidth);
  const rightReduction = Math.min(deficit, Math.max(0, rightPanel - 280));
  rightPanel -= rightReduction;
  deficit -= rightReduction;
  lineSheet -= Math.min(deficit, Math.max(0, lineSheet - 320));
  return { centre: windowWidth - sidebar - rightPanel - lineSheet, rightPanel, lineSheet };
}

export function widthBudget({ windowWidth, preferred, open }: WidthBudgetInput): WidthBudget {
  validateWidth("Window", windowWidth, 740);
  const sidebar = preferred?.sidebar ?? 232;
  const rightPanel = preferred?.rightPanel ?? 360;
  const lineSheet = preferred?.lineSheet ?? 360;
  validateWidth("Preferred sidebar", sidebar, 200, 320);
  validateWidth("Preferred right panel", rightPanel, 280);
  validateWidth("Preferred Line sheet", lineSheet, 320);

  const sidebarWidth = open.sidebar ? sidebar : 0;
  let sidebarPresentation: WidthBudget["sidebar"]["presentation"] = open.sidebar
    ? "inline"
    : "closed";
  let rightPresentation: WidthBudget["rightPanel"]["presentation"] = open.rightPanel
    ? "inline"
    : "closed";
  let linePresentation: WidthBudget["lineSheet"]["presentation"] = open.lineSheet
    ? "inline"
    : "closed";
  let budget = narrow(
    windowWidth,
    sidebarWidth,
    open.rightPanel ? rightPanel : 0,
    open.lineSheet ? lineSheet : 0,
  );
  let rightWidth = budget.rightPanel;

  if (budget.centre < 520 && open.rightPanel) {
    rightPresentation = "sheet";
    rightWidth = Math.min(rightPanel, windowWidth - 48);
    budget = narrow(windowWidth, sidebarWidth, 0, open.lineSheet ? lineSheet : 0);
  }
  if (budget.centre < 520 && open.lineSheet) {
    linePresentation = "stacked";
    budget.centre = windowWidth - sidebarWidth;
  }
  if (budget.centre < 520 && open.sidebar) {
    sidebarPresentation = "off-canvas";
    budget.centre = windowWidth;
  }

  const stacked = linePresentation === "stacked";
  return {
    centre: { width: budget.centre, heightFraction: stacked ? 0.5 : 1 },
    sidebar: { width: sidebarWidth, presentation: sidebarPresentation },
    rightPanel: { width: rightWidth, presentation: rightPresentation },
    lineSheet: {
      width: stacked ? budget.centre : budget.lineSheet,
      presentation: linePresentation,
      heightFraction: stacked ? 0.5 : open.lineSheet ? 1 : 0,
    },
  };
}
