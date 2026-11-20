// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { treeServices } from "../app/queue.js";
import { Icon, type IconName } from "../components/icons/Icon.js";
import {
  ServiceMark,
  type ServiceMarkView,
  serviceMark,
} from "../components/sidebar/service-mark.js";
import { PaletteFrame } from "../palette/CommandPalette.js";
import { usePins } from "../store/pins.js";
import { watchStore } from "../store/watch.js";
import { closeScopePicker, scopePickerStore } from "./picker.js";
import { askIn } from "./start.js";
import { threadStore } from "./store.js";
import "./threads.css";

export interface ScopeRow {
  id: string;
  label: string;
  icon: IconName;
  mark?: ServiceMarkView | undefined;
  /** A thin rule above it, where the sidebar's blocks change. */
  divider?: boolean;
}

/** The scopes a thread can start in today, in sidebar order: the pinned services, then the others. */
export function useScopeRows(): ScopeRow[] {
  const body = useStore(watchStore, (watch) => watch.snapshot?.body);
  const services = treeServices(body?.tree);
  const pinned = usePins().filter((pin) => services.includes(pin));
  const others = services.filter((id) => !pinned.includes(id));
  const row = (id: string): ScopeRow => ({
    id,
    label: id,
    icon: "box",
    mark: serviceMark(body, id),
  });
  return [
    ...pinned.map(row),
    ...others.map((id, index) => ({ ...row(id), divider: index === 0 && pinned.length > 0 })),
  ];
}

const draftInput = () =>
  document.querySelector<HTMLTextAreaElement>(".thread-view--draft textarea");

/**
 * Where a new thread asks, in Find's window over the page. ⌘N and the compose icon open it, and so
 * does a draft's scope control; a pick opens or moves the draft with the cursor in its text box.
 * It and Find close each other.
 */
export function ScopePicker({ findOpen, closeFind }: { findOpen: boolean; closeFind(): void }) {
  const picking = useStore(scopePickerStore, (state) => state.picking);
  const picked = useRef(false);
  useEffect(() => {
    if (picking) closeFind();
  }, [picking, closeFind]);
  useEffect(() => {
    if (findOpen) closeScopePicker();
  }, [findOpen]);
  useEffect(() => {
    if (picking) picked.current = false;
  }, [picking]);
  const pick = (id: string) => {
    picked.current = true;
    if (picking?.mode === "change") threadStore.getState().setDraftScope(id);
    else askIn(id);
    closeScopePicker();
  };
  return (
    <PaletteFrame
      open={picking !== null}
      onOpenChange={(open) => {
        if (!open) closeScopePicker();
      }}
      label="Choose where to ask"
      className="scope-picker"
      finalFocus={() => (picked.current ? (draftInput() ?? false) : true)}
    >
      {picking && (
        <ScopeList
          current={picking.mode === "change" ? picking.current : undefined}
          onPick={pick}
        />
      )}
    </PaletteFrame>
  );
}

function ScopeList({
  current,
  onPick,
}: {
  current?: string | undefined;
  onPick(id: string): void;
}) {
  const scopes = useScopeRows();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(() =>
    Math.max(
      scopes.findIndex((scope) => scope.id === current),
      0,
    ),
  );
  const list = useRef<HTMLUListElement>(null);
  const shown = scopes.filter((scope) => scope.label.toLowerCase().includes(query.toLowerCase()));
  const on = shown[Math.min(highlight, shown.length - 1)];
  useEffect(() => {
    list.current?.querySelector("[data-highlighted]")?.scrollIntoView?.({ block: "nearest" });
  });
  return (
    <>
      <input
        className="palette-input"
        aria-label="Find a service"
        placeholder="Find a service"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setHighlight((h) => (h + step + shown.length) % Math.max(shown.length, 1));
          } else if (event.key === "Enter") {
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (on) onPick(on.id);
          }
        }}
      />
      <ul ref={list} className="palette-results scope-picker-list" aria-label="Scopes">
        {shown.map((scope, index) => (
          <li key={scope.id} data-divider={(index > 0 && scope.divider) || undefined}>
            <button
              type="button"
              className="palette-row"
              tabIndex={-1}
              data-highlighted={scope === on || undefined}
              aria-current={scope.id === current || undefined}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(scope.id)}
            >
              <Icon name={scope.icon} className="sidebar-icon" />
              <span className="palette-label scope-picker-label">{scope.label}</span>
              <ServiceMark mark={scope.mark} />
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="palette-empty">No service matches.</li>}
      </ul>
      <div className="palette-hint">
        <span>↑↓ move</span>
        <span>⏎ ask here</span>
        <span>esc close</span>
      </div>
    </>
  );
}
