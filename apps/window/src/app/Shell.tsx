// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type CSSProperties, useCallback, useState } from "react";
import { useStore } from "zustand";
import { SweepEvidence } from "../components/evidence/EvidenceTab.js";
import { SweepLine } from "../components/evidence/SweepLine.js";
import { ProgramSidebar } from "../components/sidebar/ProgramSidebar.js";
import { SidebarProvider } from "../components/sidebar/ui-sidebar.js";
import { openFreshness } from "../components/sweep/reveal.js";
import { CommandPalette } from "../palette/CommandPalette.js";
import { selectionStore } from "../panels/index.js";
import { RightPanelFrame } from "../panels/RightPanelFrame.js";
import { SettingsDialog, type SettingsSection } from "../settings/SettingsDialog.js";
import { watchStore } from "../store/watch.js";
import { LineSheet } from "./LineSheet.js";
import { PaneEdges } from "./PaneEdges.js";
import { PanelShortcuts, RightPanelToggle, SidebarToggle } from "./PanelControls.js";
import {
  DEFAULT_REGISTRY,
  LINE,
  type Registry,
  RegistryProvider,
  RouteView,
  routeLabel,
  useNavigation,
  useSetupLanding,
} from "./routes.js";
import { createTitleStore, TitleProvider, TitleRow } from "./title-row.js";
import { useDocumentTitle } from "./useDocumentTitle.js";
import { useHostConnection } from "./useHostConnection.js";
import { usePaneLayout } from "./usePaneLayout.js";
import { useRouteScroll } from "./useRouteScroll.js";
import { useShellShortcuts } from "./useShellShortcuts.js";
import { windowControls } from "./window-controls.js";

export { watchStore };

export function Shell({ registry = DEFAULT_REGISTRY }: { registry?: Registry }) {
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body);
  const sweep = useStore(watchStore, (state) => state.sweep);
  const progress = useStore(watchStore, (state) => state.progress);
  const completed = useStore(watchStore, (state) => state.completed);
  const { route, sheet, navigate, toggleSheet, closeSheet } = useNavigation(registry);
  const rightPanelOpen = useStore(selectionStore, (state) => state.open);
  const {
    sidebarStore,
    sidebarPresentation,
    budgetWidth,
    preferredSidebar,
    budget,
    settled,
    resizeLive,
    commitWidth,
  } = usePaneLayout(registry, sheet, rightPanelOpen);
  const toggleRightPanel = useCallback(
    () => selectionStore.getState().setOpen(!selectionStore.getState().open),
    [],
  );
  const openSweepLine = useCallback(() => openFreshness(watchStore.getState().snapshot), []);
  const [titles] = useState(createTitleStore);
  const [findOpen, setFindOpen] = useState(false);
  const toggleFind = useCallback(() => setFindOpen((open) => !open), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("readiness");
  /** Without a section Settings reopens on the last one viewed. */
  const openSettings = useCallback((section?: SettingsSection) => {
    setFindOpen(false);
    if (section) setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const openReadiness = useCallback(() => openSettings("readiness"), [openSettings]);
  useSetupLanding(openReadiness);
  useShellShortcuts(registry, toggleSheet, openSettings);
  useDocumentTitle(route);
  const { middle, onScrollCapture } = useRouteScroll(route, snapshot);
  const { theme, pinTheme, error } = useHostConnection({
    sheet,
    closeSheet,
    openReadiness,
    setSettingsOpen,
    setFindOpen,
  });
  return (
    <RegistryProvider registry={registry}>
      <TitleProvider value={titles}>
        <SidebarProvider
          store={sidebarStore}
          presentation={sidebarPresentation}
          className="shell"
          data-right-panel={rightPanelOpen ? "open" : "closed"}
          data-window-controls={windowControls()}
          data-line-sheet={sheet}
          data-sidebar-presentation={budget.sidebar.presentation}
          data-right-presentation={budget.rightPanel.presentation}
          data-line-presentation={budget.lineSheet.presentation}
          style={
            {
              "--sidebar-col":
                budget.sidebar.presentation === "inline" ? `${budget.sidebar.width}px` : "0px",
              "--sidebar-width": `${preferredSidebar}px`,
              "--panel-col":
                budget.rightPanel.presentation === "inline"
                  ? `${budget.rightPanel.width}px`
                  : "0px",
              "--right-panel-width": `${budget.rightPanel.width}px`,
              "--sheet-col":
                budget.lineSheet.presentation === "inline" ? `${budget.lineSheet.width}px` : "0px",
            } as CSSProperties
          }
        >
          <PanelShortcuts
            rightPanelOpen={rightPanelOpen}
            onToggleRightPanel={toggleRightPanel}
            onToggleFind={toggleFind}
          />
          <SidebarToggle rightPanelOpen={rightPanelOpen} onToggleRightPanel={toggleRightPanel} />
          <ProgramSidebar
            store={watchStore}
            route={route}
            onNavigate={navigate}
            onFind={() => setFindOpen(true)}
            onSettings={openReadiness}
            {...(registry.sheet ? { onLine: () => navigate(LINE) } : {})}
          />
          <CommandPalette
            store={watchStore}
            open={findOpen}
            onOpenChange={setFindOpen}
            onNavigate={navigate}
            onSettings={openReadiness}
          />
          <SettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            section={settingsSection}
            onSection={setSettingsSection}
            theme={theme}
            onTheme={pinTheme}
          />
          <main className="middle-frame">
            <header className="centre-bar pane-header">
              <div className="centre-row">
                {budget.sidebar.presentation !== "inline" && (
                  <span className="toggle-room" aria-hidden />
                )}
                <div className="centre-title">
                  <TitleRow store={titles} fallback={routeLabel(route)} />
                </div>
                <div className="window-strip">
                  {registry.strip ? (
                    registry.strip()
                  ) : (
                    <SweepLine
                      snapshot={snapshot ?? null}
                      progress={progress}
                      nextSweepAt={sweep?.nextSweepAt}
                      onOpen={openSweepLine}
                    />
                  )}
                </div>
                <div className="centre-end">
                  {!rightPanelOpen && <RightPanelToggle onToggleRightPanel={toggleRightPanel} />}
                </div>
              </div>
            </header>
            <div
              className="centre-body"
              ref={middle}
              inert={sheet === "overlay"}
              onScrollCapture={onScrollCapture}
            >
              {error && <p role="alert">{error}</p>}
              <RouteView route={route} />
            </div>
          </main>
          {sheet !== "closed" && registry.sheet && (
            <LineSheet
              presentation={budget.lineSheet.presentation === "stacked" ? "stacked" : sheet}
              onClose={closeSheet}
            >
              {registry.sheet(route, sheet)}
            </LineSheet>
          )}
          <RightPanelFrame
            store={selectionStore}
            presentation={budget.rightPanel.presentation}
            {...(snapshot ? { snapshot } : {})}
            sweepEvidence={
              <SweepEvidence
                snapshot={snapshot ?? null}
                sweep={sweep}
                progress={progress}
                completed={completed}
                onOpenSettings={openReadiness}
              />
            }
          />
          <PaneEdges
            budget={budget}
            settled={settled}
            windowWidth={budgetWidth}
            lineSheet={sheet === "pinned" && Boolean(registry.sheet)}
            onResize={resizeLive}
            onResizeEnd={commitWidth}
          />
        </SidebarProvider>
      </TitleProvider>
    </RegistryProvider>
  );
}
