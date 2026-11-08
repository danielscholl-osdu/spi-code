// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useRef } from "react";
import { PaneSeparator } from "../components/resize/PaneSeparator.js";
import { PANE_BOUNDS, paneMaximum, paneStop, type ResizablePane } from "./pane-layout.js";
import type { WidthBudget } from "./width-budget.js";
import "./pane-edges.css";

const EDGES: ReadonlyArray<{
  pane: ResizablePane;
  slot: string;
  label: string;
  controls: string;
  edge: "left" | "right";
}> = [
  {
    pane: "sidebar",
    slot: "sidebar",
    label: "Resize sidebar",
    controls: "app-sidebar",
    edge: "right",
  },
  {
    pane: "lineSheet",
    slot: "line-sheet",
    label: "Resize Line sheet",
    controls: "app-line-sheet",
    edge: "left",
  },
  {
    pane: "rightPanel",
    slot: "right-panel",
    label: "Resize right panel",
    controls: "app-right-panel",
    edge: "left",
  },
];

/** The panes that have a drag edge: those shown inline. */
export function edgePanes(settled: WidthBudget, lineSheet: boolean): ResizablePane[] {
  return EDGES.flatMap(({ pane }) =>
    settled[pane].presentation === "inline" && (pane !== "lineSheet" || lineSheet) ? [pane] : [],
  );
}

/**
 * The drag edges of the panes shown inline. Each sits on its pane's divider as a
 * zero-width grid item, so the panes themselves stay as they are.
 */
export function PaneEdges({
  budget,
  settled,
  windowWidth,
  lineSheet,
  onResize,
  onResizeEnd,
}: {
  /** The displayed widths, a drag in progress included. */
  budget: WidthBudget;
  /** The displayed widths at the committed preferred widths, which set where a drag stops. */
  settled: WidthBudget;
  windowWidth: number;
  /** Whether a pinned Line sheet is rendered. */
  lineSheet: boolean;
  /** A live drag width, or undefined once a drag ends without one. */
  onResize: (pane: ResizablePane, width: number | undefined) => void;
  /** A width the user chose; a drag held at the displayed width is not one. */
  onResizeEnd: (pane: ResizablePane, width: number) => void;
}) {
  const shown = edgePanes(settled, lineSheet);
  const dragging = useRef(new Set<ResizablePane>());
  /**
   * A drag that ends where its pane already sits, because the stop or the maximum
   * held it there or the window moved under an unmoved press, is not a resize: it
   * leaves the preferred width alone. Arrow steps and double-clicks always count.
   */
  const finish = (pane: ResizablePane, width: number) => {
    if (dragging.current.has(pane) && width === settled[pane].width) onResize(pane, undefined);
    else onResizeEnd(pane, width);
  };
  return EDGES.filter(({ pane }) => shown.includes(pane)).map(
    ({ pane, slot, label, controls, edge }) => (
      <div key={pane} className="pane-edge" data-pane={slot}>
        <PaneSeparator
          label={label}
          controls={controls}
          edge={edge}
          width={budget[pane].width}
          min={PANE_BOUNDS[pane].min}
          max={paneMaximum(pane, windowWidth)}
          defaultWidth={PANE_BOUNDS[pane].defaultWidth}
          stop={paneStop(pane, settled, windowWidth)}
          onResize={(width) => onResize(pane, width)}
          onResizeEnd={(width) => finish(pane, width)}
          onDraggingChange={(active) => {
            if (active) dragging.current.add(pane);
            else {
              dragging.current.delete(pane);
              onResize(pane, undefined);
            }
          }}
        />
      </div>
    ),
  );
}
