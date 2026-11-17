// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { todayMembers } from "@spi-code/contracts";
import { useCallback, useEffect } from "react";
import { useStore } from "zustand";
import { sweepSegment } from "../components/capsule/sweep.js";
import { Icon } from "../components/icons/Icon.js";
import { StatusDotMark } from "../components/sidebar/ProgramSidebar.js";
import { statusDot, statusRows } from "../components/sidebar/status-marks.js";
import { SidebarTrigger, useSidebar } from "../components/sidebar/ui-sidebar.js";
import { selectStrip } from "../store/strip.js";
import { watchStore } from "../store/watch.js";
import { ariaShortcut, matchesShortcut, shortcutLabel } from "./shortcuts.js";

/** Opening the narrow sidebar closes the context pane, and opening the context pane closes the narrow sidebar. */
function usePanelToggles(rightPanelOpen: boolean, onToggleRightPanel: () => void) {
  const { toggleSidebar, isMobile, openMobile, setOpenMobile } = useSidebar();
  const closeDetailForSidebar = useCallback(() => {
    if (isMobile && !openMobile && rightPanelOpen) onToggleRightPanel();
  }, [isMobile, openMobile, rightPanelOpen, onToggleRightPanel]);
  const toggleDetail = useCallback(() => {
    if (isMobile && openMobile) setOpenMobile(false);
    onToggleRightPanel();
  }, [isMobile, openMobile, setOpenMobile, onToggleRightPanel]);
  return { toggleSidebar, closeDetailForSidebar, toggleDetail };
}

/** The shell's panel shortcuts: sidebar (B), right panel (I) and Find (K). */
export function PanelShortcuts({
  rightPanelOpen = false,
  onToggleRightPanel,
  onToggleFind,
}: {
  rightPanelOpen?: boolean;
  onToggleRightPanel?(): void;
  onToggleFind?(): void;
}) {
  const { toggleSidebar, closeDetailForSidebar, toggleDetail } = usePanelToggles(
    rightPanelOpen,
    onToggleRightPanel ?? (() => {}),
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (matchesShortcut(event, "b")) {
        closeDetailForSidebar();
        toggleSidebar();
      } else if (onToggleRightPanel && matchesShortcut(event, "i")) toggleDetail();
      else if (
        onToggleFind &&
        matchesShortcut(event, "k") &&
        !event.isComposing &&
        event.keyCode !== 229
      )
        onToggleFind();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar, closeDetailForSidebar, toggleDetail, onToggleFind, onToggleRightPanel]);
  return null;
}

/** Today's count, marks and sweep tone while the sidebar is out of sight. */
function useHiddenSidebarDot() {
  const body = useStore(watchStore, (state) => state.snapshot?.body ?? null);
  const progress = useStore(watchStore, (state) => state.progress);
  const tone = sweepSegment(body, progress, undefined, Date.now()).tone;
  const sweep = tone === "bad" ? "error" : tone === "warn" ? "warning" : undefined;
  const marks = body
    ? Object.values(statusRows(selectStrip(body), Date.now())).map(({ mark }) => mark)
    : [];
  return statusDot(body ? todayMembers(body.briefing).length : 0, [
    ...marks,
    sweep && { tone: sweep },
  ]);
}

/**
 * The one sidebar toggle, just after the window controls whether the sidebar shows or not. While
 * the sidebar is out of sight it carries the dot.
 */
export function SidebarToggle({
  rightPanelOpen = false,
  onToggleRightPanel,
}: {
  rightPanelOpen?: boolean;
  onToggleRightPanel?(): void;
} = {}) {
  const { closeDetailForSidebar } = usePanelToggles(
    rightPanelOpen,
    onToggleRightPanel ?? (() => {}),
  );
  const { visible } = useSidebar();
  const dot = useHiddenSidebarDot();
  return (
    <SidebarTrigger
      onClick={closeDetailForSidebar}
      className="panel-toggle sidebar-toggle"
      aria-label="Toggle sidebar"
      aria-controls="app-sidebar"
      aria-keyshortcuts={ariaShortcut("b")}
      title={`Toggle sidebar (${shortcutLabel("b")})`}
    >
      <Icon name="panelLeft" />
      {!visible && dot && <StatusDotMark dot={dot} className="sidebar-toggle-dot" />}
    </SidebarTrigger>
  );
}

/** The right panel's toggle at the end of the centre's header, drawn while the panel is closed. */
export function RightPanelToggle({ onToggleRightPanel }: { onToggleRightPanel(): void }) {
  const { toggleDetail } = usePanelToggles(false, onToggleRightPanel);
  return (
    <button
      type="button"
      className="panel-toggle"
      aria-label="Toggle right panel"
      aria-pressed={false}
      aria-controls="app-right-panel"
      aria-keyshortcuts={ariaShortcut("i")}
      title={`Show right panel (${shortcutLabel("i")})`}
      onClick={toggleDetail}
    >
      <Icon name="panelRight" />
    </button>
  );
}
