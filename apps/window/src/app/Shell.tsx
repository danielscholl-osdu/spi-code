// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type CSSProperties, useCallback, useState } from "react";
import { useStore } from "zustand";
import { SweepProgressLine } from "../components/capsule/SweepSegment.js";
import { SweepLine } from "../components/evidence/SweepLine.js";
import { WindowPinNotice } from "../components/pin/PinNotice.js";
import { ProgramSidebar } from "../components/sidebar/ProgramSidebar.js";
import { SidebarProvider } from "../components/sidebar/ui-sidebar.js";
import { openFreshness } from "../components/sweep/reveal.js";
import { CommandPalette } from "../palette/CommandPalette.js";
import { ThreadPanel } from "../panels/thread/ThreadPanel.js";
import { SettingsDialog, type SettingsSection } from "../settings/SettingsDialog.js";
import { watchStore } from "../store/watch.js";
import { scopePickerStore } from "../threads/picker.js";
import { ScopePicker } from "../threads/ScopePicker.js";
import { SettleToast } from "../threads/SettleToast.js";
import { NEW_THREAD } from "../threads/store.js";
import { PaneEdges } from "./PaneEdges.js";
import { PanelShortcuts, RightPanelToggle, SidebarToggle } from "./PanelControls.js";
import {
  DEFAULT_REGISTRY,
  type Registry,
  RegistryProvider,
  RouteView,
  routeLabel,
  useNavigation,
  useSetupLanding,
} from "./routes.js";
import { createTitleStore, TitleEnd, TitleProvider, TitleRow } from "./title-row.js";
import { useDocumentTitle } from "./useDocumentTitle.js";
import { useHostConnection } from "./useHostConnection.js";
import { usePaneLayout } from "./usePaneLayout.js";
import { usePinShortcut } from "./usePinShortcut.js";
import { useRouteScroll } from "./useRouteScroll.js";
import { useShellShortcuts } from "./useShellShortcuts.js";
import { windowControls } from "./window-controls.js";

export { watchStore };

export function Shell({ registry = DEFAULT_REGISTRY }: { registry?: Registry }) {
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body);
  const sweep = useStore(watchStore, (state) => state.sweep);
  const progress = useStore(watchStore, (state) => state.progress);
  const { route, navigate } = useNavigation(registry);
  const thread = route.kind === "thread" && route.id !== NEW_THREAD ? route.id : undefined;
  const {
    sidebarStore,
    sidebarPresentation,
    budgetWidth,
    preferredSidebar,
    budget,
    settled,
    resizeLive,
    commitWidth,
    rightPanelOpen,
    setRightPanelOpen,
  } = usePaneLayout(thread !== undefined);
  const toggleRightPanel = useCallback(
    () => setRightPanelOpen(!rightPanelOpen),
    [rightPanelOpen, setRightPanelOpen],
  );
  const panelControls = thread
    ? { rightPanelOpen, onToggleRightPanel: toggleRightPanel }
    : { rightPanelOpen };
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
  const picking = useStore(scopePickerStore, (state) => state.picking !== null);
  const closeFind = useCallback(() => setFindOpen(false), []);
  useShellShortcuts(registry, openSettings, settingsOpen || findOpen || picking, settingsOpen);
  usePinShortcut(route, settingsOpen || findOpen || picking);
  useDocumentTitle(route);
  const { middle, onScrollCapture } = useRouteScroll(route, snapshot);
  const { theme, pinTheme, error } = useHostConnection({
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
          data-sidebar-presentation={budget.sidebar.presentation}
          data-right-presentation={budget.rightPanel.presentation}
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
            } as CSSProperties
          }
        >
          <PanelShortcuts {...panelControls} onToggleFind={toggleFind} />
          <WindowPinNotice />
          <SettleToast />
          <SidebarToggle {...panelControls} />
          <ProgramSidebar
            store={watchStore}
            route={route}
            onNavigate={navigate}
            onFind={() => setFindOpen(true)}
            onSettings={openReadiness}
            sweep={
              registry.strip ? (
                registry.strip()
              ) : (
                <SweepLine
                  snapshot={snapshot ?? null}
                  progress={progress}
                  nextSweepAt={sweep?.nextSweepAt}
                  onOpen={openSweepLine}
                />
              )
            }
          />
          <SweepProgressLine />
          <CommandPalette
            store={watchStore}
            open={findOpen}
            onOpenChange={setFindOpen}
            onNavigate={navigate}
            onSettings={openReadiness}
          />
          {registry.views.thread && <ScopePicker findOpen={findOpen} closeFind={closeFind} />}
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
                <div className="centre-end">
                  <TitleEnd store={titles} />
                  {thread && !rightPanelOpen && (
                    <RightPanelToggle open={false} onToggleRightPanel={toggleRightPanel} />
                  )}
                </div>
              </div>
            </header>
            <div className="centre-body" ref={middle} onScrollCapture={onScrollCapture}>
              {error && <p role="alert">{error}</p>}
              <RouteView route={route} />
            </div>
          </main>
          {thread && (
            <ThreadPanel
              id={thread}
              open={rightPanelOpen}
              presentation={budget.rightPanel.presentation}
              onToggle={toggleRightPanel}
            />
          )}
          <PaneEdges
            budget={budget}
            settled={settled}
            windowWidth={budgetWidth}
            onResize={resizeLive}
            onResizeEnd={commitWidth}
          />
        </SidebarProvider>
      </TitleProvider>
    </RegistryProvider>
  );
}
