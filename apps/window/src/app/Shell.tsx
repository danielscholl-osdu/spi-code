// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useStore } from "zustand";
import { SweepEvidence } from "../components/evidence/EvidenceTab.js";
import { SweepLine } from "../components/evidence/SweepLine.js";
import { ProgramSidebar } from "../components/sidebar/ProgramSidebar.js";
import { createSidebarOpenStore, SidebarProvider } from "../components/sidebar/ui-sidebar.js";
import { CommandPalette } from "../palette/CommandPalette.js";
import { selectionStore } from "../panels/index.js";
import { RightPanelFrame } from "../panels/RightPanelFrame.js";
import { routeSelectionIds } from "../panels/selection-rows.js";
import { SettingsDialog, type SettingsSection } from "../settings/SettingsDialog.js";
import { watchStore } from "../store/watch.js";
import { type Appearance, createAppearance } from "./appearance.js";
import { LineSheet } from "./LineSheet.js";
import { edgePanes, PaneEdges } from "./PaneEdges.js";
import { PanelControls } from "./PanelControls.js";
import { budgetPreferred, loadPanes, type ResizablePane, savePanes } from "./pane-layout.js";
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
import { isTypingEvent, matchesShortcut } from "./shortcuts.js";
import { type PaneWidths, widthBudget } from "./width-budget.js";
import { windowControls } from "./window-controls.js";

export { watchStore };

export function Shell({ registry = DEFAULT_REGISTRY }: { registry?: Registry }) {
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body);
  const sweep = useStore(watchStore, (state) => state.sweep);
  const { route, sheet, navigate, toggleSheet, closeSheet } = useNavigation(registry);
  const rightPanelOpen = useStore(selectionStore, (state) => state.open);
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
    open: { sidebar: sidebarOpen, rightPanel: rightPanelOpen, lineSheet: sheet === "pinned" },
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
  useEffect(
    () =>
      selectionStore.subscribe((state, previous) => {
        if (state.open !== previous.open) savePanes({ open: { rightPanel: state.open } });
      }),
    [],
  );
  const edges = edgePanes(settled, sheet === "pinned" && Boolean(registry.sheet)).join();
  useEffect(() => {
    // A drag ends without a width when its pane folds mid-drag.
    for (const pane of Object.keys(live) as ResizablePane[]) {
      if (!edges.split(",").includes(pane)) resizeLive(pane, undefined);
    }
  }, [live, edges, resizeLive]);
  const launch = useRef(budgetInput);
  useLayoutEffect(() => {
    const input = launch.current;
    if (!saved.open.rightPanel || selectionStore.getState().open) return;
    const restored = widthBudget({ ...input, open: { ...input.open, rightPanel: true } });
    if (restored.rightPanel.presentation === "inline") selectionStore.getState().setOpen(true);
  }, [saved]);
  const sidebarPresentation = sidebarOpen
    ? budget.sidebar.presentation
    : widthBudget({ ...budgetInput, open: { ...budgetInput.open, sidebar: true } }).sidebar
        .presentation;
  const toggleRightPanel = useCallback(
    () => selectionStore.getState().setOpen(!selectionStore.getState().open),
    [],
  );
  const openSweepEvidence = useCallback(() => selectionStore.getState().openSweepEvidence(), []);
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (matchesShortcut(event, ",")) {
        if (isTypingEvent(event)) return;
        event.preventDefault();
        openSettings();
        return;
      }
      if (!registry.sheet || !matchesShortcut(event, "l")) return;
      event.preventDefault();
      toggleSheet();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [registry.sheet, toggleSheet, openSettings]);
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
  const [theme, setTheme] = useState<Appearance>();
  const pinTheme = useCallback(
    (value: Appearance) => {
      appearance?.setPin(value);
      setTheme(value);
    },
    [appearance],
  );
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = createAppearance(undefined, undefined, undefined, (theme) => {
      void window.spi.setAppearance?.(theme);
    });
    setAppearance(controller);
    setTheme(controller.pin);
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
            "--sidebar-width": `${budgetInput.preferred.sidebar}px`,
            "--panel-col":
              budget.rightPanel.presentation === "inline" ? `${budget.rightPanel.width}px` : "0px",
            "--right-panel-width": `${budget.rightPanel.width}px`,
            "--sheet-col":
              budget.lineSheet.presentation === "inline" ? `${budget.lineSheet.width}px` : "0px",
          } as CSSProperties
        }
      >
        <header className="title-bar" ref={titleBar}>
          <div className="title-bar-place">
            <strong>SPI Code</strong>
            <span aria-hidden>·</span>
            <span data-place>{routeLabel(route)}</span>
          </div>
          <div className="title-bar-controls">
            <SweepLine snapshot={snapshot ?? null} onOpen={openSweepEvidence} />
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
          sweepEvidence={<SweepEvidence snapshot={snapshot ?? null} sweep={sweep} />}
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
    </RegistryProvider>
  );
}
