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
import {
  isReachable,
  LENSES,
  PLACES,
  type Route,
  routeLabel,
  useRegistry,
} from "../../app/routes.js";
import { ariaShortcut, shortcutLabel } from "../../app/shortcuts.js";
import type { createWatchStore } from "../../store/watch.js";
import { inboxCount } from "../../views/inbox/queue.js";
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

function formatSweep(sweptAt: string | undefined): string {
  if (!sweptAt) return "not swept yet";
  const date = new Date(sweptAt);
  if (Number.isNaN(date.getTime())) return "not swept yet";
  return `swept ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/** The route whose sidebar row stays lit: a month lights Releases. */
function rowFor(route: Route): string {
  switch (route.kind) {
    case "release":
      return "releases";
    case "service":
      return `service/${route.id}`;
    case "lens":
      return `lens/${route.lens}`;
    default:
      return route.kind;
  }
}

export function ProgramSidebar({
  store,
  route,
  onNavigate,
  onFind,
}: {
  store: ReturnType<typeof createWatchStore>;
  route: Route;
  onNavigate(route: Route): void;
  onFind?(): void;
}) {
  const body = useStore(store, (state) => state.snapshot?.body);
  const { tree, sweptAt, briefing } = body ?? {};
  const attention = useSidebarAttention(body);
  const inbox = briefing ? inboxCount(briefing) : 0;
  const { isMobile, setOpenMobile } = useSidebar();
  const { collapsed, toggle } = useGroupCollapse();
  const ids = { program: useId(), services: useId(), lenses: useId(), settled: useId() };
  const active = rowFor(route);
  const registry = useRegistry();
  const reachable = (target: Route) => isReachable(target, registry);
  const places = PLACES.filter(reachable);
  const services = (tree ?? [])
    .filter((node) => node.id.startsWith(SERVICE_PREFIX))
    .map((node) => node.id.slice(SERVICE_PREFIX.length));

  const row = (
    key: string,
    target: Route,
    label = routeLabel(target),
    pip?: ReactNode,
    mark = attention.get(TREE_IDS[key] ?? key.replace("service/", SERVICE_PREFIX)),
  ) => (
    <SidebarMenuItem key={key}>
      <SidebarMenuButton
        isActive={active === key}
        data-sidebar-row={key}
        aria-current={active === key ? (route.kind === "release" ? "true" : "page") : undefined}
        onClick={() => {
          onNavigate(target);
          if (isMobile) setOpenMobile(false);
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

  const group = (
    id: Exclude<SidebarGroupId, "settled">,
    label: string,
    rows: ReactNode,
    count?: number,
  ) => (
    <SidebarGroup data-group={id}>
      <CollapsibleSectionHeader
        expanded={!collapsed(id)}
        aria-controls={ids[id]}
        accessory={count}
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
            if (isMobile) setOpenMobile(false);
            onFind?.();
          }}
        >
          <span aria-hidden className="find-glyph" />
          <span>Find or ask</span>
          <kbd>{shortcutLabel("k")}</kbd>
        </button>
        {reachable({ kind: "today" }) && (
          <SidebarMenu aria-label="Today">{row("today", { kind: "today" })}</SidebarMenu>
        )}
        {reachable({ kind: "inbox" }) && (
          <SidebarMenu aria-label="Inbox">
            {row(
              "inbox",
              { kind: "inbox" },
              undefined,
              inbox > 0 && (
                <span className="sidebar-pip" title={`${inbox} at P0 or P1`}>
                  {inbox}
                </span>
              ),
            )}
          </SidebarMenu>
        )}
      </SidebarHeader>
      <SidebarContent>
        {places.length > 0 &&
          group(
            "program",
            "Program",
            places.map((place) => row(place.kind, place)),
          )}
        {reachable({ kind: "service", id: "" }) &&
          group(
            "services",
            "Services",
            services.length === 0 ? (
              <li className="sidebar-empty">
                {tree ? "No services in this sweep" : "No services read yet"}
              </li>
            ) : (
              services.map((id) => row(`service/${id}`, { kind: "service", id }))
            ),
            services.length,
          )}
        {reachable({ kind: "lens", lens: "flow" }) &&
          group(
            "lenses",
            "Lenses",
            LENSES.map((lens) => row(`lens/${lens}`, { kind: "lens", lens })),
          )}
      </SidebarContent>
      <SidebarGroup data-group="settled" className="settled-shelf">
        <CollapsibleSectionHeader
          expanded={!collapsed("settled")}
          aria-controls={ids.settled}
          accessory={0}
          onClick={() => toggle("settled")}
        >
          Settled
        </CollapsibleSectionHeader>
        {!collapsed("settled") && (
          <p id={ids.settled} className="sidebar-empty">
            No settled threads yet
          </p>
        )}
      </SidebarGroup>
      <SidebarFooter>
        {reachable({ kind: "setup" }) && (
          <SidebarMenu aria-label="Setup">{row("setup", { kind: "setup" })}</SidebarMenu>
        )}
        <time className="sweep-stamp" dateTime={sweptAt}>
          {formatSweep(sweptAt)}
        </time>
      </SidebarFooter>
    </Sidebar>
  );
}
