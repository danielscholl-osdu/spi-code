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

import { useCallback, useEffect } from "react";
import { Icon } from "../components/icons/Icon.js";
import { SidebarTrigger, useSidebar } from "../components/sidebar/ui-sidebar.js";
import { ariaShortcut, matchesShortcut, shortcutLabel } from "./shortcuts.js";

/** Opening the narrow sidebar closes Detail, and opening Detail closes the narrow sidebar. */
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
  rightPanelOpen,
  onToggleRightPanel,
  onToggleFind,
}: {
  rightPanelOpen: boolean;
  onToggleRightPanel(): void;
  onToggleFind?(): void;
}) {
  const { toggleSidebar, closeDetailForSidebar, toggleDetail } = usePanelToggles(
    rightPanelOpen,
    onToggleRightPanel,
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (matchesShortcut(event, "b")) {
        closeDetailForSidebar();
        toggleSidebar();
      } else if (matchesShortcut(event, "i")) toggleDetail();
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
  }, [toggleSidebar, closeDetailForSidebar, toggleDetail, onToggleFind]);
  return null;
}

/** The one sidebar toggle, just after the window controls whether the sidebar shows or not. */
export function SidebarToggle({
  rightPanelOpen,
  onToggleRightPanel,
}: {
  rightPanelOpen: boolean;
  onToggleRightPanel(): void;
}) {
  const { closeDetailForSidebar } = usePanelToggles(rightPanelOpen, onToggleRightPanel);
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
