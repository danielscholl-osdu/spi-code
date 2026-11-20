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
import { todayMembers } from "@spi-code/contracts";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";
import { treeServices } from "../../app/queue.js";
import {
  isReachable,
  lastTodayRoute,
  type Route,
  routeLabel,
  useRegistry,
} from "../../app/routes.js";
import { ariaShortcut, shortcutLabel } from "../../app/shortcuts.js";
import { READINESS_DOT_LABEL, readinessDot } from "../../settings/readiness.js";
import { observePinFeedback, useJustPinned } from "../../store/pin-feedback.js";
import {
  movePin,
  movePinBeside,
  type PinnedPlace,
  pinnedPlace,
  placePin,
  unpin,
  usePins,
} from "../../store/pins.js";
import { selectStrip } from "../../store/strip.js";
import type { createWatchStore } from "../../store/watch.js";
import { newThread } from "../../threads/start.js";
import { useNow } from "../evidence/useNow.js";
import { Icon, type IconName } from "../icons/Icon.js";
import { isContextMenuKey } from "../pin/PinMenu.js";
import { PinNotice } from "../pin/PinNotice.js";
import { useGroupCollapse } from "./collapse.js";
import { ServiceMark, type ServiceMarkView, serviceMark } from "./service-mark.js";
import {
  STATUS_DOT_LABEL,
  type StatusDot,
  type StatusMark,
  type StatusRow,
  statusDot,
  statusRows,
  syncDeadline,
} from "./status-marks.js";
import { OtherThreads, SettledFooter, ThreadRow, useSidebarThreads } from "./ThreadRows.js";
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

type Row = {
  pin: string;
  /** A place's route kind or `service/<id>`. */
  key: string;
  label: string;
  icon: IconName;
  beforeSweep?: boolean;
  mark?: ServiceMarkView | undefined;
  status?: StatusRow | undefined;
  open(): void;
};

const MARK_ICONS: Readonly<Record<Exclude<StatusMark["kind"], "count">, IconName>> = {
  check: "check",
  wrench: "wrench",
  refresh: "refresh",
  clock: "clock",
};

function Mark({ mark }: { mark: StatusMark }) {
  return (
    <span className="sidebar-mark" data-mark={mark.kind} data-tone={mark.tone} aria-hidden>
      {mark.kind === "count" ? (
        mark.count
      ) : (
        <Icon name={MARK_ICONS[mark.kind]} size={15} stroke={2} />
      )}
    </span>
  );
}

/** A dot for a list that is out of sight, in the most urgent tone it holds. */
export function StatusDotMark({ dot, className }: { dot: StatusDot; className: string }) {
  return (
    <span className={className} data-tone={dot} role="img" aria-label={STATUS_DOT_LABEL[dot]} />
  );
}

function openMenuFromKeyboard(event: KeyboardEvent<HTMLElement>): boolean {
  if (!isContextMenuKey(event)) return false;
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
  return true;
}

/** Icon, label and status at the end; nothing on the row hides, moves or swaps. */
function RowContent({ row }: { row: Row }) {
  return (
    <>
      <Icon name={row.icon} className="sidebar-icon" />
      <span className="sidebar-row-label">{row.label}</span>
      <ServiceMark mark={row.mark} />
      {row.status?.mark && <Mark mark={row.status.mark} />}
    </>
  );
}

function rowButtonProps(row: Row, ariaCurrent: "page" | "true" | undefined) {
  return {
    isActive: ariaCurrent !== undefined,
    "data-sidebar-row": row.key,
    "data-before-sweep": row.beforeSweep ? "" : undefined,
    "data-status": row.status?.status,
    "data-classification": row.status?.classification,
    title: row.status?.sentence,
    "aria-description": row.status?.sentence,
    "aria-current": ariaCurrent,
    onClick: row.open,
  };
}

/** A row of the fixed block: no grip, no pin control and no menu. */
function FixedItem({
  row,
  ariaCurrent,
  buttonRef,
}: {
  row: Row;
  ariaCurrent: "page" | "true" | undefined;
  buttonRef: Ref<HTMLButtonElement> | undefined;
}) {
  return (
    <SidebarMenuItem data-fixed={row.pin}>
      <SidebarMenuButton ref={buttonRef} {...rowButtonProps(row, ariaCurrent)}>
        <RowContent row={row} />
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function PinItem({
  row,
  ariaCurrent,
  prev,
  next,
  dragging,
  buttonRef,
  onDrag,
  onMoved,
  onUnpinned,
}: {
  row: Row;
  ariaCurrent: "page" | "true" | undefined;
  prev: string | undefined;
  next: string | undefined;
  dragging: string | null;
  buttonRef: Ref<HTMLButtonElement>;
  onDrag(pin: string | null): void;
  onMoved(): void;
  onUnpinned(): void;
}) {
  const justPinned = useJustPinned();
  const [over, setOver] = useState<"before" | "after" | null>(null);
  const move = (target: string | undefined) => {
    if (!target) return;
    movePin(row.pin, target);
    onMoved();
  };
  return (
    <SidebarMenuItem
      className="pin-item"
      data-pin={row.pin}
      data-just-pinned={justPinned === row.pin || undefined}
      data-drop={over ?? undefined}
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
        const box = event.currentTarget.getBoundingClientRect();
        setOver(event.clientY < box.top + box.height / 2 ? "before" : "after");
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(event) => {
        event.preventDefault();
        if (dragging && over) movePinBeside(dragging, row.pin, over);
        setOver(null);
        onDrag(null);
      }}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger
          render={
            <SidebarMenuButton
              ref={buttonRef}
              {...rowButtonProps(row, ariaCurrent)}
              onKeyDown={(event) => {
                if (openMenuFromKeyboard(event)) return;
                if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                move(event.key === "ArrowUp" ? prev : next);
              }}
            />
          }
        >
          <span className="pin-grip" aria-hidden>
            <Icon name="grip" size={12} stroke={2.5} />
          </span>
          <RowContent row={row} />
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
                onClick={() => move(prev)}
              >
                Move up
              </ContextMenu.Item>
              <ContextMenu.Item
                className="pin-menu-item"
                disabled={!next}
                onClick={() => move(next)}
              >
                Move down
              </ContextMenu.Item>
              <ContextMenu.Separator className="sidebar-menu-separator" />
              <ContextMenu.Item
                className="pin-menu-item"
                onClick={() => {
                  unpin(row.pin);
                  onUnpinned();
                }}
              >
                Unpin from sidebar
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </SidebarMenuItem>
  );
}

/**
 * The sidebar (PS-08): Find or ask; Today with its count, Environment and Template
 * as one fixed block; one Pinned list in the operator's order; and a footer gear that opens Settings, with a dot only when Readiness needs the operator. The
 * Settled shelf waits for threads (M3).
 */
export function ProgramSidebar({
  store,
  route,
  onNavigate,
  onFind,
  onSettings,
  sweep,
}: {
  store: ReturnType<typeof createWatchStore>;
  route: Route;
  onNavigate(route: Route): void;
  onFind?(): void;
  /** Opens Settings on Readiness; without it the sidebar has no footer. */
  onSettings?(): void;
  sweep?: ReactNode;
}) {
  const body = useStore(store, (state) => state.snapshot?.body);
  const dot = readinessDot(useStore(store, (state) => state.setup));
  const { tree, briefing } = body ?? {};
  const strip = body ? selectStrip(body) : undefined;
  const now = useNow(30_000, syncDeadline(strip?.nextSync, Date.now()));
  const status = statusRows(body, now);
  const todayCount = briefing ? todayMembers(briefing).length : 0;
  const { isMobile, setOpenMobile, visible } = useSidebar();
  const { collapsed, toggle } = useGroupCollapse();
  const presentation = useRef({ visible, expanded: !collapsed("pinned") });
  useLayoutEffect(() => {
    presentation.current = { visible, expanded: !collapsed("pinned") };
  });
  useLayoutEffect(
    () => observePinFeedback(() => presentation.current.visible && presentation.current.expanded),
    [],
  );
  const pinnedId = useId();
  const active = rowFor(route);
  const registry = useRegistry();
  const services = treeServices(tree);
  const [dragging, setDragging] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pinnedHeader = useRef<HTMLButtonElement>(null);
  const fixedEnd = useRef<HTMLButtonElement>(null);
  /** The Pinned row to focus after the list changes; the header, then the fixed block, if it is gone. */
  const [focusPin, setFocusPin] = useState<{ pin: string | undefined } | null>(null);
  useEffect(() => {
    if (!focusPin) return;
    setFocusPin(null);
    const row = focusPin.pin === undefined ? undefined : rowRefs.current.get(focusPin.pin);
    (row ?? pinnedHeader.current ?? fixedEnd.current)?.focus();
  }, [focusPin]);
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const go = (target: Route) => () => {
    onNavigate(target);
    closeMobile();
  };
  const ariaCurrent = (row: Row) =>
    active === row.key ? (route.kind === "release" ? "true" : "page") : undefined;
  const placeRow = (pin: string): Row[] => {
    const place = pinnedPlace(pin);
    if (!place) return [];
    const target: Route = { kind: place };
    if (!isReachable(target, registry)) return [];
    return [
      {
        pin,
        key: place,
        label: routeLabel(target),
        icon: PLACE_ICONS[place],
        beforeSweep: !body,
        status: (status as Readonly<Partial<Record<string, StatusRow>>>)[pin],
        open: go(target),
      },
    ];
  };
  const fixed: Row[] = [
    ...placeRow(placePin("environment")),
    ...placeRow(placePin("engineering-system")),
  ];
  const rows = usePins().flatMap((pin): Row[] => {
    if (pinnedPlace(pin)) return placeRow(pin);
    const target: Route = { kind: "service", id: pin };
    if (!services.includes(pin) || !isReachable(target, registry)) return [];
    return [
      {
        pin,
        key: `service/${pin}`,
        label: pin,
        icon: "box",
        mark: serviceMark(body, pin),
        open: go(target),
      },
    ];
  });

  const pinnedDot = statusDot(
    0,
    rows.flatMap((row) => [row.status?.mark, row.mark?.kind === "count" ? row.mark : undefined]),
  );
  const todayReachable = isReachable({ kind: "today" }, registry);
  const threadsOn = isReachable({ kind: "thread", id: "new" }, registry);
  const threadRows = useSidebarThreads();

  return (
    <Sidebar id="app-sidebar" aria-label="Sidebar" className="app-sidebar">
      <div className="sidebar-top">
        <span className="toggle-room" aria-hidden />
      </div>
      <SidebarHeader>
        <div className="find-or-ask-row">
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
          {threadsOn && (
            <button
              type="button"
              className="sidebar-compose"
              aria-label="New thread"
              aria-haspopup="dialog"
              aria-keyshortcuts={ariaShortcut("n")}
              title={`New thread ${shortcutLabel("n")}`}
              onClick={() => {
                closeMobile();
                newThread();
              }}
            >
              <Icon name="squarePen" size={15} />
            </button>
          )}
        </div>
        <SidebarMenu aria-label="Program" data-group="fixed">
          {todayReachable && (
            <SidebarMenuItem>
              <SidebarMenuButton
                ref={fixed.length === 0 ? fixedEnd : undefined}
                isActive={active === "today"}
                data-sidebar-row="today"
                aria-current={active === "today" ? "page" : undefined}
                onClick={() => go(lastTodayRoute())()}
              >
                <Icon name="sun" className="sidebar-icon" />
                <span className="sidebar-row-label">Today</span>
                {todayCount > 0 && (
                  <span className="sidebar-pip" title={`${todayCount} yours on Today`}>
                    {todayCount}
                  </span>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {fixed.map((row, index) => (
            <FixedItem
              key={row.pin}
              row={row}
              ariaCurrent={ariaCurrent(row)}
              buttonRef={index === fixed.length - 1 ? fixedEnd : undefined}
            />
          ))}
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {rows.length > 0 && (
          <SidebarGroup data-group="pinned">
            <CollapsibleSectionHeader
              ref={pinnedHeader}
              expanded={!collapsed("pinned")}
              aria-controls={pinnedId}
              onClick={() => toggle("pinned")}
              dot={
                collapsed("pinned") && pinnedDot ? (
                  <StatusDotMark dot={pinnedDot} className="sidebar-status-dot" />
                ) : undefined
              }
            >
              Pinned
            </CollapsibleSectionHeader>
            {!collapsed("pinned") && (
              <SidebarMenu id={pinnedId} aria-label="Pinned">
                {rows.map((row, index) => (
                  <Fragment key={row.pin}>
                    <PinItem
                      row={row}
                      ariaCurrent={ariaCurrent(row)}
                      prev={rows[index - 1]?.pin}
                      next={rows[index + 1]?.pin}
                      dragging={dragging}
                      buttonRef={(button) => {
                        if (button) rowRefs.current.set(row.pin, button);
                        else rowRefs.current.delete(row.pin);
                      }}
                      onDrag={setDragging}
                      onMoved={() => setFocusPin({ pin: row.pin })}
                      onUnpinned={() =>
                        setFocusPin({ pin: rows[index + 1]?.pin ?? rows[index - 1]?.pin })
                      }
                    />
                    {row.key.startsWith("service/") &&
                      threadRows
                        .filter(
                          (thread) =>
                            thread.status !== "Settled" && thread.thread.scope === row.pin,
                        )
                        .map((thread) => (
                          <ThreadRow
                            key={thread.id}
                            thread={thread}
                            nested
                            current={route.kind === "thread" ? route.id : null}
                            onNavigate={(target) => go(target)()}
                          />
                        ))}
                  </Fragment>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroup>
        )}
        {threadsOn && (
          <OtherThreads
            threads={threadRows}
            nestedScopes={
              collapsed("pinned")
                ? []
                : rows.filter((row) => row.key.startsWith("service/")).map((row) => row.pin)
            }
            route={route}
            onNavigate={(target) => go(target)()}
          />
        )}
      </SidebarContent>
      {threadsOn && (
        <SettledFooter threads={threadRows} route={route} onNavigate={(target) => go(target)()} />
      )}
      <PinNotice placement="sidebar" />
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
          {sweep}
        </SidebarFooter>
      )}
    </Sidebar>
  );
}
