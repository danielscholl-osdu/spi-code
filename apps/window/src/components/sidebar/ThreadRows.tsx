// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ContextMenu } from "@base-ui/react/context-menu";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { parseRoute, type Route } from "../../app/navigation.js";
import { shiftShortcutLabel } from "../../app/shortcuts.js";
import { scopeLabel } from "../../threads/scopes.js";
import { watchStore } from "../../store/watch.js";
import { requestInSweep } from "../../threads/request-ownership.js";
import { type ThreadSummary, threadStore } from "../../threads/store.js";
import { useNow } from "../evidence/useNow.js";
import { Icon } from "../icons/Icon.js";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui-sidebar.js";

export function age(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

export function nextThread(threads: readonly ThreadSummary[], settledId: string): string | null {
  return (
    threads.find(
      (thread) =>
        thread.id !== settledId && thread.status !== "Settled" && thread.status !== "Can't be read",
    )?.id ?? null
  );
}

export function routeAfterSettle(
  threads: readonly ThreadSummary[],
  settledId: string,
): Route | null {
  const current = parseRoute(window.location.hash);
  if (current?.kind !== "thread" || current.id !== settledId) return null;
  const next = nextThread(threads, settledId);
  return next ? { kind: "thread", id: next } : { kind: "today" };
}

export function useSidebarThreads(): ThreadSummary[] {
  const threads = useStore(threadStore, (state) => state.threads) ?? [];
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

function EndMark({ thread, now }: { thread: ThreadSummary; now: number }) {
  if (thread.status === "Can't be read") return null;
  if (thread.status === "Working")
    return (
      <span className="sidebar-thread-end" data-end="working" title="Working">
        <Icon name="loader" size={13} stroke={2.25} />
      </span>
    );
  if (thread.status === "Waiting on you")
    return (
      <span className="sidebar-thread-end" data-end="waiting" title="Waiting on you">
        <Icon name="alert" size={14} stroke={2} />
      </span>
    );
  if (thread.done)
    return (
      <span className="sidebar-thread-end" data-end="done" title="Done since you last looked">
        <Icon name="check" size={14} stroke={2} />
      </span>
    );
  return (
    <span className="sidebar-thread-end" data-end="age">
      {age(thread.updatedAt, now)}
    </span>
  );
}

export function ThreadRow({
  thread,
  current,
  nested,
  onNavigate,
}: {
  thread: ThreadSummary;
  current: string | null;
  nested?: boolean;
  onNavigate(route: Route): void;
}) {
  const now = useNow(60_000);
  const snapshot = useStore(watchStore, (state) => state.snapshot);
  const request = thread.thread.request;
  const settle = () =>
    threadStore.getState().settle(thread, (threads) => {
      const next = routeAfterSettle(threads, thread.id);
      if (next) onNavigate(next);
    });
  const unreadable = thread.status === "Can't be read";
  const open = () => {
    if (!unreadable) onNavigate({ kind: "thread", id: thread.id });
  };
  const canSettle = thread.status === "Open";
  const content = (
    <>
      <span className="sidebar-thread-text">
        <span className="sidebar-row-label">
          {unreadable ? "Can't be read" : (thread.thread.title ?? "Untitled thread")}
        </span>
        {!unreadable && (
          <span className="sidebar-thread-sub">
            {nested ? "Asking" : scopeLabel(thread.thread.scope)}
          </span>
        )}
      </span>
      <EndMark thread={thread} now={now} />
    </>
  );
  return (
    <SidebarMenuItem
      className="thread-item"
      data-nested={nested || undefined}
      data-state={thread.status}
      title={unreadable ? thread.id : undefined}
    >
      {unreadable ? (
        <SidebarMenuButton className="sidebar-thread" data-status={thread.status} disabled>
          {content}
        </SidebarMenuButton>
      ) : (
        <>
          <ContextMenu.Root>
            <ContextMenu.Trigger
              render={
                <SidebarMenuButton
                  className="sidebar-thread"
                  isActive={thread.id === current}
                  aria-current={thread.id === current ? "page" : undefined}
                  data-thread-row={thread.id}
                  data-status={thread.status}
                  onClick={open}
                />
              }
            >
              {content}
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Positioner>
                <ContextMenu.Popup className="pin-menu" data-thread-menu={thread.id}>
                  <ContextMenu.Item className="pin-menu-item" onClick={open}>
                    Open
                  </ContextMenu.Item>
                  <ContextMenu.Separator className="sidebar-menu-separator" />
                  {thread.status === "Settled" ? (
                    <ContextMenu.Item
                      className="pin-menu-item"
                      onClick={() => threadStore.getState().unsettle(thread.id)}
                    >
                      Un-settle
                    </ContextMenu.Item>
                  ) : (
                    <ContextMenu.Item
                      className="pin-menu-item"
                      disabled={!canSettle}
                      onClick={settle}
                    >
                      {canSettle ? "Settle" : `Settle (not while ${thread.status})`}
                    </ContextMenu.Item>
                  )}
                </ContextMenu.Popup>
              </ContextMenu.Positioner>
            </ContextMenu.Portal>
          </ContextMenu.Root>
          {request && (
            <a
              className="sidebar-thread-request"
              data-state={requestInSweep(snapshot?.body, request.url) ? "owned" : "pending"}
              href={request.url}
              title={request.url}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void window.spi?.openExternal(request.url);
              }}
            >
              {request.forge === "github" ? "PR" : "MR"} {request.forge === "github" ? "#" : "!"}
              {request.requestNumber} ·{" "}
              {requestInSweep(snapshot?.body, request.url) ? "owned" : "pending"}
              <span aria-hidden="true">↗</span>
            </a>
          )}
          {(canSettle || thread.status === "Settled") && (
            <button
              type="button"
              className="sidebar-thread-settle"
              data-settled={thread.status === "Settled" || undefined}
              aria-label={thread.status === "Settled" ? "Un-settle" : "Settle"}
              title={`${thread.status === "Settled" ? "Un-settle" : "Settle"} ${shiftShortcutLabel("s")}`}
              onClick={() =>
                thread.status === "Settled" ? threadStore.getState().unsettle(thread.id) : settle()
              }
            >
              <Icon name={thread.status === "Settled" ? "refresh" : "check"} size={14} stroke={2} />
            </button>
          )}
        </>
      )}
    </SidebarMenuItem>
  );
}

export function OtherThreads({
  threads,
  nestedScopes,
  route,
  onNavigate,
}: {
  threads: readonly ThreadSummary[];
  nestedScopes: readonly string[];
  route: Route;
  onNavigate(route: Route): void;
}) {
  const current = route.kind === "thread" ? route.id : null;
  const rows = threads.filter(
    (thread) => thread.status !== "Settled" && !nestedScopes.includes(thread.thread.scope),
  );
  if (rows.length === 0) return null;
  return (
    <SidebarGroup data-group="threads">
      <p className="section-header">Other threads</p>
      <SidebarMenu aria-label="Other threads">
        {rows.map((thread) => (
          <ThreadRow key={thread.id} thread={thread} current={current} onNavigate={onNavigate} />
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

export function SettledFooter({
  threads,
  route,
  onNavigate,
}: {
  threads: readonly ThreadSummary[];
  route: Route;
  onNavigate(route: Route): void;
}) {
  const [open, setOpen] = useState(false);
  const current = route.kind === "thread" ? route.id : null;
  const settled = threads.filter((thread) => thread.status === "Settled");
  useEffect(() => {
    if (settled.length === 0) setOpen(false);
  }, [settled.length]);
  return (
    <div className="sidebar-settled" data-open={open || undefined}>
      {open && (
        <SidebarMenu aria-label="Settled" className="sidebar-settled-list">
          {settled.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} current={current} onNavigate={onNavigate} />
          ))}
        </SidebarMenu>
      )}
      <div className="sidebar-settled-row">
        <button
          type="button"
          className="sidebar-settled-toggle"
          aria-expanded={open}
          disabled={settled.length === 0}
          onClick={() => setOpen((value) => !value)}
        >
          Settled <span className="sidebar-thread-count">{settled.length}</span>
          <Icon name="chevR" size={13} stroke={2} className="sidebar-settled-chevron" />
        </button>
      </div>
    </div>
  );
}
