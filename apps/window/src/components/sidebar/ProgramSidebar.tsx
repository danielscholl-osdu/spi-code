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

import { ContextMenu } from "@base-ui/react/context-menu";
import { type DragEvent, type KeyboardEvent, useId, useState } from "react";
import { useStore } from "zustand";
import { treeServices } from "../../app/queue.js";
import { isReachable, type Route, routeLabel, useRegistry } from "../../app/routes.js";
import { ariaShortcut, shortcutLabel } from "../../app/shortcuts.js";
import { READINESS_DOT_LABEL, readinessDot } from "../../settings/readiness.js";
import {
  LINE_PIN,
  movePin,
  type PinnedPlace,
  pinnedPlace,
  unpin,
  usePins,
} from "../../store/pins.js";
import type { createWatchStore } from "../../store/watch.js";
import { countInterrupts } from "../../views/today/selectors.js";
import { Icon, type IconName } from "../icons/Icon.js";
import { isContextMenuKey } from "../pin/PinMenu.js";
import { useGroupCollapse } from "./collapse.js";
import { type PinWord, pinWord } from "./pin-word.js";
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
import "../pin/pin-menu.css";
import "./sidebar.css";

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

const PLACE_ICONS: Readonly<Record<PinnedPlace, IconName>> = {
  upstream: "upstream",
  environment: "server",
  "engineering-system": "layers",
  releases: "tag",
  security: "shield",
};

type PinRow = {
  pin: string;
  /** `line`, a place's route kind, or `service/<id>`. */
  key: string;
  label: string;
  icon: IconName;
  beforeSweep?: boolean;
  word?: PinWord | undefined;
  open(): void;
};

function openMenuFromKeyboard(event: KeyboardEvent<HTMLElement>) {
  if (!isContextMenuKey(event)) return;
  event.preventDefault();
  const box = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: box.left,
      clientY: box.bottom,
    }),
  );
}

function PinItem({
  row,
  ariaCurrent,
  prev,
  next,
  dragging,
  onDrag,
}: {
  row: PinRow;
  ariaCurrent: "page" | "true" | undefined;
  prev: string | undefined;
  next: string | undefined;
  dragging: string | null;
  onDrag(pin: string | null): void;
}) {
  const [over, setOver] = useState(false);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (dragging) movePin(dragging, row.pin);
    onDrag(null);
  };
  return (
    <SidebarMenuItem
      className="pin-item"
      data-pin={row.pin}
      data-drop-over={over || undefined}
      draggable
      onDragStart={(event) => {
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", row.pin);
        }
        onDrag(row.pin);
      }}
      onDragEnd={() => onDrag(null)}
      onDragOver={(event) => {
        if (!dragging || dragging === row.pin) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={
            <SidebarMenuButton
              isActive={ariaCurrent !== undefined}
              data-sidebar-row={row.key}
              data-before-sweep={row.beforeSweep ? "" : undefined}
              aria-current={ariaCurrent}
              onClick={row.open}
              onKeyDown={openMenuFromKeyboard}
            />
          }
        >
          <span className="pin-grip" aria-hidden>
            <Icon name="grip" size={12} stroke={2.5} />
          </span>
          <Icon name={row.icon} className="sidebar-icon" />
          <span className="sidebar-row-label">{row.label}</span>
          {row.word && (
            <span className="sidebar-word" data-tone={row.word.tone}>
              {row.word.text}
            </span>
          )}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner>
            <ContextMenu.Popup className="pin-menu" data-pin-menu={row.pin}>
              <ContextMenu.Item className="pin-menu-item" onClick={row.open}>
                Open
              </ContextMenu.Item>
              <ContextMenu.Item
                className="pin-menu-item"
                disabled={!prev}
                onClick={() => prev && movePin(row.pin, prev)}
              >
                Move up
              </ContextMenu.Item>
              <ContextMenu.Item
                className="pin-menu-item"
                disabled={!next}
                onClick={() => next && movePin(row.pin, next)}
              >
                Move down
              </ContextMenu.Item>
              <ContextMenu.Item className="pin-menu-item" onClick={() => unpin(row.pin)}>
                Unpin
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <button
        type="button"
        className="pin-unpin"
        aria-label={`Unpin ${row.label}`}
        title={`Unpin ${row.label}`}
        onClick={() => unpin(row.pin)}
      >
        <Icon name="pinOff" size={13} />
      </button>
    </SidebarMenuItem>
  );
}

/**
 * The sidebar (PS-08): Find or ask, Today with its count, one Pinned list in the operator's order,
 * and a footer gear that opens Settings, with a dot only when Readiness needs the operator. The
 * Settled shelf waits for threads (M3).
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
  /** Opens the Line sheet; without it the Line pin has no row. */
  onLine?(): void;
  /** Opens Settings on Readiness; without it the sidebar has no footer. */
  onSettings?(): void;
}) {
  const body = useStore(store, (state) => state.snapshot?.body);
  const dot = readinessDot(useStore(store, (state) => state.setup));
  const { tree, briefing } = body ?? {};
  const interrupts = briefing ? countInterrupts(briefing) : 0;
  const { isMobile, setOpenMobile } = useSidebar();
  const { collapsed, toggle } = useGroupCollapse();
  const pinnedId = useId();
  const active = rowFor(route);
  const registry = useRegistry();
  const services = treeServices(tree);
  const [dragging, setDragging] = useState<string | null>(null);
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const go = (target: Route) => () => {
    onNavigate(target);
    closeMobile();
  };
  const rows = usePins().flatMap((pin): PinRow[] => {
    if (pin === LINE_PIN)
      return onLine
        ? [
            {
              pin,
              key: "line",
              label: "Line",
              icon: "rows",
              open: () => {
                onLine();
                closeMobile();
              },
            },
          ]
        : [];
    const place = pinnedPlace(pin);
    if (place) {
      const target: Route = { kind: place };
      if (!isReachable(target, registry)) return [];
      return [
        {
          pin,
          key: place,
          label: routeLabel(target),
          icon: PLACE_ICONS[place],
          beforeSweep: !body,
          open: go(target),
        },
      ];
    }
    const target: Route = { kind: "service", id: pin };
    if (!services.includes(pin) || !isReachable(target, registry)) return [];
    return [
      {
        pin,
        key: `service/${pin}`,
        label: pin,
        icon: "box",
        word: pinWord(body, pin),
        open: go(target),
      },
    ];
  });

  return (
    <Sidebar id="app-sidebar" aria-label="Sidebar" className="app-sidebar">
      <div className="sidebar-top">
        <span className="toggle-room" aria-hidden />
      </div>
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
          <Icon name="search" size={15} />
          <span className="find-or-ask-label">Find or ask</span>
          <kbd>{shortcutLabel("k")}</kbd>
        </button>
        {isReachable({ kind: "today" }, registry) && (
          <SidebarMenu aria-label="Today">
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={active === "today"}
                data-sidebar-row="today"
                aria-current={active === "today" ? "page" : undefined}
                onClick={go({ kind: "today" })}
              >
                <Icon name="sun" className="sidebar-icon" />
                <span className="sidebar-row-label">Today</span>
                {interrupts > 0 && (
                  <span
                    className="sidebar-pip"
                    title={`${interrupts} interruption${interrupts === 1 ? "" : "s"}`}
                  >
                    {interrupts}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarHeader>
      <SidebarContent>
        {rows.length > 0 && (
          <SidebarGroup data-group="pinned">
            <CollapsibleSectionHeader
              expanded={!collapsed("pinned")}
              aria-controls={pinnedId}
              onClick={() => toggle("pinned")}
            >
              Pinned
            </CollapsibleSectionHeader>
            {!collapsed("pinned") && (
              <SidebarMenu id={pinnedId} aria-label="Pinned">
                {rows.map((row, index) => (
                  <PinItem
                    key={row.pin}
                    row={row}
                    ariaCurrent={
                      active === row.key ? (route.kind === "release" ? "true" : "page") : undefined
                    }
                    prev={rows[index - 1]?.pin}
                    next={rows[index + 1]?.pin}
                    dragging={dragging}
                    onDrag={setDragging}
                  />
                ))}
              </SidebarMenu>
            )}
          </SidebarGroup>
        )}
      </SidebarContent>
      {onSettings && (
        <SidebarFooter>
          <button
            type="button"
            className="sidebar-settings"
            data-sidebar-row="settings"
            aria-label="Settings"
            aria-haspopup="dialog"
            aria-keyshortcuts={ariaShortcut(",")}
            title={`Settings ${shortcutLabel(",")}${dot ? ` · ${READINESS_DOT_LABEL[dot]}` : ""}`}
            onClick={() => {
              closeMobile();
              onSettings();
            }}
          >
            <Icon name="gear" />
            {dot && (
              <span
                className="sidebar-readiness-dot"
                data-readiness={dot}
                role="img"
                aria-label={READINESS_DOT_LABEL[dot]}
              />
            )}
          </button>
        </SidebarFooter>
      )}
    </Sidebar>
  );
}
