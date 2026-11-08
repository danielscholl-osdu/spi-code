// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { SweepEvidence } from "../components/evidence/EvidenceTab.js";
import { SweepLine } from "../components/evidence/SweepLine.js";
import { ProgramSidebar } from "../components/sidebar/ProgramSidebar.js";
import { SidebarProvider } from "../components/sidebar/ui-sidebar.js";
import { CommandPalette } from "../palette/CommandPalette.js";
import { selectionStore } from "../panels/index.js";
import { RightPanelFrame } from "../panels/RightPanelFrame.js";
import { routeSelectionIds } from "../panels/selection-rows.js";
import { watchStore } from "../store/watch.js";
import { createAppearance } from "./appearance.js";
import { LineSheet } from "./LineSheet.js";
import { PanelControls } from "./PanelControls.js";
import {
  DEFAULT_REGISTRY,
  LINE,
  type Registry,
  RegistryProvider,
  RouteView,
  routeHash,
  routeLabel,
  useNavigation,
  useSetupLanding,
} from "./routes.js";
import { matchesShortcut } from "./shortcuts.js";
import { windowControls } from "./window-controls.js";

export { watchStore };

export function Shell({ registry = DEFAULT_REGISTRY }: { registry?: Registry }) {
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body);
  const sweep = useStore(watchStore, (state) => state.sweep);
  const { route, sheet, navigate, toggleSheet, closeSheet } = useNavigation(registry);
  useSetupLanding(navigate);
  const rightPanelOpen = useStore(selectionStore, (state) => state.open);
  const toggleRightPanel = useCallback(
    () => selectionStore.getState().setOpen(!selectionStore.getState().open),
    [],
  );
  const openSweepEvidence = useCallback(() => selectionStore.getState().openSweepEvidence(), []);
  const [findOpen, setFindOpen] = useState(false);
  const toggleFind = useCallback(() => setFindOpen((open) => !open), []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !registry.sheet || !matchesShortcut(event, "l")) return;
      event.preventDefault();
      toggleSheet();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [registry.sheet, toggleSheet]);
  const middle = useRef<HTMLElement>(null);
  const titleBar = useRef<HTMLElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const title = titleBar.current;
    const shell = title?.parentElement;
    if (!title || !shell) return;
    const status = registry.strip ? strip.current : null;
    const measure = () => {
      const height =
        title.getBoundingClientRect().height + (status?.getBoundingClientRect().height ?? 0);
      shell.style.setProperty("--topbar-height", `${height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(title, { box: "border-box" });
    if (status) observer.observe(status, { box: "border-box" });
    return () => observer.disconnect();
  }, [registry.strip]);
  const position = useRef({ route: routeHash(route), top: 0 });
  useLayoutEffect(() => {
    const frame = middle.current;
    if (!frame) return;
    const key = routeHash(route);
    const top = selectionStore
      .getState()
      .visit(
        key,
        [
          ...(snapshot ? routeSelectionIds(snapshot, route) : []),
          ...Array.from(frame.querySelectorAll<HTMLElement>("[data-selection-id]")).flatMap(
            (element) => (element.dataset.selectionId ? [element.dataset.selectionId] : []),
          ),
        ],
        position.current.route === key ? frame.scrollTop : position.current.top,
      );
    frame.scrollTop = top;
    position.current = { route: key, top };
  }, [route, snapshot]);
  const [appearance, setAppearance] = useState<ReturnType<typeof createAppearance>>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = createAppearance(undefined, undefined, undefined, (theme) => {
      void window.spi.setAppearance?.(theme);
    });
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
    <RegistryProvider registry={registry}>
      <SidebarProvider
        className="shell"
        data-right-panel={rightPanelOpen ? "open" : "closed"}
        data-window-controls={windowControls()}
        data-line-sheet={sheet}
      >
        <header className="title-bar" ref={titleBar}>
          <div className="title-bar-place">
            <strong>SPI Code</strong>
            <span aria-hidden>·</span>
            <span data-place>{routeLabel(route)}</span>
          </div>
          <div className="title-bar-controls">
            <SweepLine snapshot={snapshot ?? null} onOpen={openSweepEvidence} />
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
            <PanelControls
              rightPanelOpen={rightPanelOpen}
              onToggleRightPanel={toggleRightPanel}
              onToggleFind={toggleFind}
            />
          </div>
        </header>
        {registry.strip && (
          <div className="window-strip" ref={strip}>
            {registry.strip()}
          </div>
        )}
        <ProgramSidebar
          store={watchStore}
          route={route}
          onNavigate={navigate}
          onFind={() => setFindOpen(true)}
          {...(registry.sheet ? { onLine: () => navigate(LINE) } : {})}
        />
        <CommandPalette
          store={watchStore}
          open={findOpen}
          onOpenChange={setFindOpen}
          onNavigate={navigate}
        />
        <main
          className="middle-frame"
          ref={middle}
          inert={sheet === "overlay"}
          onScroll={(event) => {
            position.current.top = event.currentTarget.scrollTop;
          }}
        >
          {error && <p role="alert">{error}</p>}
          <RouteView route={route} />
        </main>
        {sheet !== "closed" && registry.sheet && (
          <LineSheet presentation={sheet} onClose={closeSheet}>
            {registry.sheet(route, sheet)}
          </LineSheet>
        )}
        <RightPanelFrame
          store={selectionStore}
          {...(snapshot ? { snapshot } : {})}
          sweepEvidence={<SweepEvidence snapshot={snapshot ?? null} sweep={sweep} />}
        />
      </SidebarProvider>
    </RegistryProvider>
  );
}
