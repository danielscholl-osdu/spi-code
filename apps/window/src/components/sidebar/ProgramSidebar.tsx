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

import { type ReactNode, useId } from "react";
import { useStore } from "zustand";
import { treeServices } from "../../app/queue.js";
import { isReachable, PLACES, type Route, routeLabel, useRegistry } from "../../app/routes.js";
import { ariaShortcut, shortcutLabel } from "../../app/shortcuts.js";
import { READINESS_LIGHT_LABEL, readinessLight } from "../../settings/readiness.js";
import { usePins } from "../../store/pins.js";
import { PIPS, selectStrip } from "../../store/strip.js";
import type { createWatchStore } from "../../store/watch.js";
import { selectTodayItems } from "../../views/today/selectors.js";
import { AttentionDot } from "../AttentionDot.js";
import { useSidebarAttention } from "./attention.js";
import { type SidebarGroupId, useGroupCollapse } from "./collapse.js";
import {
  CollapsibleSectionHeader,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "./ui-sidebar.js";
import "./sidebar.css";

const SERVICE_PREFIX = "service:";
/** Sidebar rows whose attention comes from a sweep tree node of another name. */
const TREE_IDS: Record<string, string> = { "engineering-system": "template" };

/** The route whose sidebar row stays lit: a month lights Releases. */
function rowFor(route: Route): string {
  switch (route.kind) {
    case "release":
      return "releases";
    case "service":
      return `service/${route.id}`;
    default:
      return route.kind;
  }
}

/**
 * The sidebar (PS-08): Find or ask, Today, Line, the places, the operator's pins, and a footer row
 * that opens Settings with a readiness dot. The Settled shelf waits for threads (M3). A service has a row only while pinned, and a pin the sweep no longer names has none.
 */
export function ProgramSidebar({
  store,
  route,
  onNavigate,
  onFind,
  onLine,
  onSettings,
}: {
  store: ReturnType<typeof createWatchStore>;
  route: Route;
  onNavigate(route: Route): void;
  onFind?(): void;
  /** Opens the Line sheet; without it the sidebar has no Line row. */
  onLine?(): void;
  /** Opens Settings on Readiness; without it the sidebar has no footer row. */
  onSettings?(): void;
}) {
  const body = useStore(store, (state) => state.snapshot?.body);
  const light = readinessLight(useStore(store, (state) => state.setup));
  const { tree, briefing } = body ?? {};
  const attention = useSidebarAttention(body);
  const interrupts = briefing ? selectTodayItems(briefing).interrupts : 0;
  const { isMobile, setOpenMobile } = useSidebar();
  const { collapsed, toggle } = useGroupCollapse();
  const ids = { places: useId(), pinned: useId() };
  const active = rowFor(route);
  const registry = useRegistry();
  const reachable = (target: Route) => isReachable(target, registry);
  const places = PLACES.filter(reachable);
  const services = treeServices(tree);
  const pins = usePins().filter((id) => services.includes(id));
  const pips = new Map(
    body ? selectStrip(body).pips.map(({ service, state }) => [service, state]) : [],
  );
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  const row = (
    key: string,
    target: Route,
    label = routeLabel(target),
    pip?: ReactNode,
    mark = attention.get(TREE_IDS[key] ?? key.replace("service/", SERVICE_PREFIX)),
    beforeSweep = false,
  ) => (
    <SidebarMenuItem key={key}>
      <SidebarMenuButton
        isActive={active === key}
        data-sidebar-row={key}
        data-before-sweep={beforeSweep ? "" : undefined}
        aria-current={active === key ? (route.kind === "release" ? "true" : "page") : undefined}
        onClick={() => {
          onNavigate(target);
          closeMobile();
        }}
      >
        <AttentionDot dot={mark?.dot} />
        <span className="sidebar-row-label">{label}</span>
        {mark?.word && (
          <span className="sidebar-row-note" title={mark.word}>
            {mark.word}
          </span>
        )}
        {pip}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );

  const group = (id: Exclude<SidebarGroupId, "settled">, label: string, rows: ReactNode) => (
    <SidebarGroup data-group={id}>
      <CollapsibleSectionHeader
        expanded={!collapsed(id)}
        aria-controls={ids[id]}
        onClick={() => toggle(id)}
      >
        {label}
      </CollapsibleSectionHeader>
      {!collapsed(id) && (
        <SidebarMenu id={ids[id]} aria-label={label}>
          {rows}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );

  return (
    <Sidebar id="app-sidebar" aria-label="Sidebar" className="app-sidebar">
      <SidebarHeader>
        <button
          type="button"
          className="find-or-ask"
          aria-haspopup="dialog"
          aria-keyshortcuts={ariaShortcut("k")}
          onClick={() => {
            closeMobile();
            onFind?.();
          }}
        >
          <span aria-hidden className="find-glyph" />
          <span>Find or ask</span>
          <kbd>{shortcutLabel("k")}</kbd>
        </button>
        {reachable({ kind: "today" }) && (
          <SidebarMenu aria-label="Today">
            {row(
              "today",
              { kind: "today" },
              undefined,
              interrupts > 0 && (
                <span
                  className="sidebar-pip"
                  title={`${interrupts} interruption${interrupts === 1 ? "" : "s"}`}
                >
                  {interrupts}
                </span>
              ),
            )}
          </SidebarMenu>
        )}
        {onLine && (
          <SidebarMenu aria-label="Line">
            <SidebarMenuItem>
              <SidebarMenuButton
                data-sidebar-row="line"
                aria-keyshortcuts={ariaShortcut("l")}
                onClick={() => {
                  onLine();
                  closeMobile();
                }}
              >
                <span className="sidebar-row-label">Line</span>
                <kbd className="sidebar-row-note">{shortcutLabel("l")}</kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarHeader>
      <SidebarContent>
        {places.length > 0 &&
          group(
            "places",
            "Places",
            places.map((place) => row(place.kind, place, undefined, undefined, undefined, !body)),
          )}
        {pins.length > 0 &&
          group(
            "pinned",
            "Pinned",
            pins.map((id) => {
              const pip = pips.get(id);
              return row(
                `service/${id}`,
                { kind: "service", id },
                undefined,
                pip && pip !== "nothing-due" && (
                  <span
                    className="sidebar-pin-glyph"
                    data-pip={pip}
                    role="img"
                    aria-label={PIPS[pip].words}
                    title={PIPS[pip].words}
                  >
                    {PIPS[pip].mark}
                  </span>
                ),
              );
            }),
          )}
      </SidebarContent>
      {onSettings && (
        <SidebarFooter>
          <SidebarMenu aria-label="Settings">
            <SidebarMenuItem>
              <SidebarMenuButton
                data-sidebar-row="settings"
                aria-haspopup="dialog"
                aria-keyshortcuts={ariaShortcut(",")}
                onClick={() => {
                  closeMobile();
                  onSettings();
                }}
              >
                <span className="sidebar-row-label">Settings</span>
                {light && (
                  <span
                    className="sidebar-readiness-dot"
                    data-readiness={light}
                    role="img"
                    aria-label={READINESS_LIGHT_LABEL[light]}
                    title={READINESS_LIGHT_LABEL[light]}
                  />
                )}
                <kbd className="sidebar-row-note">{shortcutLabel(",")}</kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      )}
    </Sidebar>
  );
}
