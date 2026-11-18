// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createSidebarOpenStore } from "../components/sidebar/ui-sidebar.js";
import { edgePanes } from "./PaneEdges.js";
import { budgetPreferred, loadPanes, type ResizablePane, savePanes } from "./pane-layout.js";
import { type PaneWidths, widthBudget } from "./width-budget.js";

export function usePaneLayout(rightPanelOpen: boolean) {
  const [saved] = useState(loadPanes);
  const [sidebarStore] = useState(() => createSidebarOpenStore(saved.open.sidebar));
  const sidebarOpen = useSyncExternalStore(
    sidebarStore.subscribe,
    sidebarStore.getSnapshot,
    sidebarStore.getSnapshot,
  ).open;
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [widths, setWidths] = useState<PaneWidths>(saved.widths);
  const [live, setLive] = useState<Partial<PaneWidths>>({});
  const budgetWidth = Math.max(740, windowWidth);
  const budgetInput = {
    windowWidth: budgetWidth,
    preferred: budgetPreferred({ ...widths, ...live }, budgetWidth),
    open: { sidebar: sidebarOpen, rightPanel: rightPanelOpen },
  };
  const budget = widthBudget(budgetInput);
  /** Stops come from the committed widths, so a drag never squeezes the other panes. */
  const settled = widthBudget({
    ...budgetInput,
    preferred: budgetPreferred(widths, budgetWidth),
  });
  const resizeLive = useCallback(
    (pane: ResizablePane, width: number | undefined) =>
      setLive((current) => {
        if (current[pane] === width) return current;
        const { [pane]: _, ...rest } = current;
        return width === undefined ? rest : { ...rest, [pane]: width };
      }),
    [],
  );
  const commitWidth = useCallback(
    (pane: ResizablePane, width: number) => {
      setWidths((current) => ({ ...current, [pane]: width }));
      resizeLive(pane, undefined);
      savePanes({ widths: { [pane]: width } });
    },
    [resizeLive],
  );
  useEffect(() => {
    let open = sidebarStore.getSnapshot().open;
    return sidebarStore.subscribe(() => {
      if (sidebarStore.getSnapshot().open === open) return;
      open = sidebarStore.getSnapshot().open;
      savePanes({ open: { sidebar: open } });
    });
  }, [sidebarStore]);
  const edges = edgePanes(settled).join();
  useEffect(() => {
    // A drag ends without a width when its pane folds mid-drag.
    for (const pane of Object.keys(live) as ResizablePane[]) {
      if (!edges.split(",").includes(pane)) resizeLive(pane, undefined);
    }
  }, [live, edges, resizeLive]);
  const sidebarPresentation = sidebarOpen
    ? budget.sidebar.presentation
    : widthBudget({ ...budgetInput, open: { ...budgetInput.open, sidebar: true } }).sidebar
        .presentation;
  return {
    sidebarStore,
    sidebarPresentation,
    budgetWidth,
    preferredSidebar: budgetInput.preferred.sidebar,
    budget,
    settled,
    resizeLive,
    commitWidth,
  };
}
