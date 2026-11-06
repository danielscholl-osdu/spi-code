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
import { LENSES, type Route, routeLabel } from "../../app/routes.js";
import { ariaShortcut, shortcutLabel } from "../../app/shortcuts.js";
import type { createWatchStore } from "../../store/watch.js";
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
}: {
  store: ReturnType<typeof createWatchStore>;
  route: Route;
  onNavigate(route: Route): void;
}) {
  const tree = useStore(store, (state) => state.snapshot?.body.tree);
  const sweptAt = useStore(store, (state) => state.snapshot?.body.sweptAt);
  const { isMobile, setOpenMobile } = useSidebar();
  const { collapsed, toggle } = useGroupCollapse();
  const findReason = useId();
  const ids = { program: useId(), services: useId(), lenses: useId(), settled: useId() };
  const active = rowFor(route);
  const services = (tree ?? [])
    .filter((node) => node.id.startsWith(SERVICE_PREFIX))
    .map((node) => node.id.slice(SERVICE_PREFIX.length));

  const row = (key: string, target: Route, label = routeLabel(target)) => (
    <SidebarMenuItem key={key}>
      <SidebarMenuButton
        isActive={active === key}
        aria-current={active === key ? (route.kind === "release" ? "true" : "page") : undefined}
        onClick={() => {
          onNavigate(target);
          if (isMobile) setOpenMobile(false);
        }}
      >
        <span>{label}</span>
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
          aria-disabled="true"
          aria-describedby={findReason}
          aria-keyshortcuts={ariaShortcut("k")}
        >
          <span aria-hidden className="find-glyph" />
          <span>Find or ask</span>
          <kbd>{shortcutLabel("k")}</kbd>
        </button>
        <span id={findReason} className="visually-hidden">
          Find or ask is not available yet
        </span>
        <SidebarMenu aria-label="Inbox">{row("inbox", { kind: "inbox" })}</SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {group(
          "program",
          "Program",
          <>
            {row("template", { kind: "template" })}
            {row("environment", { kind: "environment" })}
            {row("releases", { kind: "releases" })}
          </>,
        )}
        {group(
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
        {group(
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
        <SidebarMenu aria-label="Setup">{row("setup", { kind: "setup" })}</SidebarMenu>
        <time className="sweep-stamp" dateTime={sweptAt}>
          {formatSweep(sweptAt)}
        </time>
      </SidebarFooter>
    </Sidebar>
  );
}
