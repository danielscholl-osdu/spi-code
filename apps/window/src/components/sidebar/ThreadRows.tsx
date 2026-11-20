// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useState } from "react";
import { useStore } from "zustand";
import type { Route } from "../../app/navigation.js";
import { ariaShortcut, shortcutLabel } from "../../app/shortcuts.js";
import { newThread } from "../../threads/start.js";
import { type ThreadSummary, threadStore } from "../../threads/store.js";
import {
  CollapsibleSectionHeader,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui-sidebar.js";

const OPEN_GROUPS = ["Waiting on you", "Working"] as const;

/** Threads by status under Pinned (PS-08): Waiting on you, Working, then the Settled shelf. */
export function ThreadRows({
  route,
  onNavigate,
}: {
  route: Route;
  onNavigate(route: Route): void;
}) {
  const threads = useStore(threadStore, (state) => state.threads) ?? [];
  const [shelf, setShelf] = useState(false);
  const current = route.kind === "thread" ? route.id : null;
  const row = (thread: ThreadSummary) => (
    <SidebarMenuItem key={thread.id}>
      <SidebarMenuButton
        className="sidebar-thread"
        isActive={thread.id === current}
        aria-current={thread.id === current ? "page" : undefined}
        data-thread-row={thread.id}
        data-status={thread.status}
        onClick={() => onNavigate({ kind: "thread", id: thread.id })}
      >
        <span className="sidebar-thread-dot" data-status={thread.status} aria-hidden />
        <span className="sidebar-row-label">{thread.thread.title ?? "Untitled thread"}</span>
        <span className="sidebar-thread-scope">
          {thread.thread.scope === "program" ? "Program" : thread.thread.scope}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
  const settled = threads.filter(({ status }) => status === "Settled");
  return (
    <SidebarGroup data-group="threads">
      <SidebarMenu aria-label="Threads">
        <SidebarMenuItem>
          <SidebarMenuButton
            data-thread-row="new"
            aria-keyshortcuts={ariaShortcut("n")}
            onClick={() => newThread(route)}
          >
            <span className="sidebar-row-label">New thread</span>
            <kbd className="sidebar-thread-key">{shortcutLabel("n")}</kbd>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {OPEN_GROUPS.map((status) => {
        const rows = threads.filter((thread) => thread.status === status);
        return rows.length === 0 ? null : (
          <div key={status} className="sidebar-thread-group">
            <p className="section-header">{status}</p>
            <SidebarMenu aria-label={status}>{rows.map(row)}</SidebarMenu>
          </div>
        );
      })}
      {settled.length > 0 && (
        <>
          <CollapsibleSectionHeader expanded={shelf} onClick={() => setShelf((open) => !open)}>
            Settled <span className="sidebar-thread-count">{settled.length}</span>
          </CollapsibleSectionHeader>
          {shelf && <SidebarMenu aria-label="Settled">{settled.map(row)}</SidebarMenu>}
        </>
      )}
    </SidebarGroup>
  );
}
