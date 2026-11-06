// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { WorstEnvelope } from "../components/evidence/WorstEnvelope.js";
import { ProgramSidebar } from "../components/sidebar/ProgramSidebar.js";
import { SidebarProvider } from "../components/sidebar/ui-sidebar.js";
import { RightPanel, selectionStore } from "../panels/index.js";
import { selectEnvelopes, watchStore } from "../store/watch.js";
import { createAppearance } from "./appearance.js";
import { PanelControls } from "./PanelControls.js";
import { RouteView, routeLabel, useHashRoute, useSetupLanding } from "./routes.js";
import { windowControls } from "./window-controls.js";

export { watchStore };

export function Shell({ children }: { children?: ReactNode }) {
  const envelopes = useStore(watchStore, useShallow(selectEnvelopes));
  const [route, navigate] = useHashRoute();
  useSetupLanding(navigate);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const toggleRightPanel = useCallback(() => setRightPanelOpen((open) => !open), []);
  const [appearance, setAppearance] = useState<ReturnType<typeof createAppearance>>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = createAppearance();
    setAppearance(controller);
    const unsubscribe = window.spi.onMessage((message) => {
      selectionStore.getState().receive(message);
      try {
        watchStore.getState().receive(message);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => {
      controller.dispose();
      unsubscribe();
    };
  }, []);
  return (
    <SidebarProvider
      className="shell"
      data-right-panel={rightPanelOpen ? "open" : "closed"}
      data-window-controls={windowControls()}
    >
      <header className="title-bar">
        <div className="title-bar-place">
          <strong>SPI Code</strong>
          <span aria-hidden>·</span>
          <span data-place>{routeLabel(route)}</span>
        </div>
        <div className="title-bar-controls">
          <WorstEnvelope envelopes={envelopes} />
          <label>
            Appearance{" "}
            <select
              aria-label="Appearance"
              key={appearance?.pin}
              defaultValue={appearance?.pin ?? "system"}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "system" || value === "light" || value === "dark")
                  appearance?.setPin(value);
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <PanelControls rightPanelOpen={rightPanelOpen} onToggleRightPanel={toggleRightPanel} />
        </div>
      </header>
      <ProgramSidebar store={watchStore} route={route} onNavigate={navigate} />
      <main className="middle-frame">
        {error && <p role="alert">{error}</p>}
        <RouteView route={route} />
        <details>
          <summary>Copilot turn</summary>
          {children}
        </details>
      </main>
      {rightPanelOpen && (
        <div id="app-right-panel" className="right-panel-frame">
          <RightPanel store={selectionStore} />
        </div>
      )}
    </SidebarProvider>
  );
}
