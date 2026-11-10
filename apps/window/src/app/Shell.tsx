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
import { openFreshness } from "../components/sweep/reveal.js";
import { CommandPalette } from "../palette/CommandPalette.js";
import { selectionStore } from "../panels/index.js";
import { RightPanelFrame } from "../panels/RightPanelFrame.js";
import { routeSelectionIds } from "../panels/selection-rows.js";
import { SettingsDialog, type SettingsSection } from "../settings/SettingsDialog.js";
import { watchStore } from "../store/watch.js";
import { type Appearance, createAppearance } from "./appearance.js";
import { openDestination, parseDestination } from "./destination.js";
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
  const progress = useStore(watchStore, (state) => state.progress);
  const completed = useStore(watchStore, (state) => state.completed);
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
  const openSweepLine = useCallback(() => openFreshness(watchStore.getState().snapshot), []);
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
  useEffect(() => {
    document.title = `SPI Code · ${routeLabel(route)}`;
  }, [route]);
  useLayoutEffect(() => {
    const title = titleBar.current;
    const shell = title?.parentElement;
    if (!title || !shell) return;
    const measure = () => {
      shell.style.setProperty("--topbar-height", `${title.getBoundingClientRect().height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(title, { box: "border-box" });
    return () => observer.disconnect();
  }, []);
  const position = useRef({ route: routeHash(route), top: 0 });
  useLayoutEffect(() => {
    const frame = middle.current?.querySelector<HTMLElement>(
      ':scope > :not([role="alert"], .place-header, [role="status"], button)',
    );
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
  /** Kept current so the one navigation subscription sees the live sheet. */
  const routeDestination = useRef<(input: unknown) => void>(() => {});
  useEffect(() => {
    routeDestination.current = (input) => {
      const destination = parseDestination(input);
      if (!destination) return;
      // A tray destination lands on top: close what would cover it before opening it.
      // Readiness is a Settings section: the dialog opens over whatever is showing.
      if (destination.to === "readiness") {
        openReadiness();
        return;
      }
      setSettingsOpen(false);
      setFindOpen(false);
      if (sheet === "overlay") closeSheet();
      openDestination(destination);
    };
  }, [sheet, closeSheet, openReadiness]);
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
    const unroute = window.spi.onNavigate?.((input) => routeDestination.current(input));
    return () => {
      controller.dispose();
      unsubscribe();
      unroute?.();
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
          <div className="title-bar-controls">
            <PanelControls
              rightPanelOpen={rightPanelOpen}
              onToggleRightPanel={toggleRightPanel}
              onToggleFind={toggleFind}
            />
          </div>
        </header>
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
          onScrollCapture={(event) => {
            if (
              event.target instanceof HTMLElement &&
              event.target.parentElement === event.currentTarget
            )
              position.current.top = event.target.scrollTop;
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
    </RegistryProvider>
  );
}
