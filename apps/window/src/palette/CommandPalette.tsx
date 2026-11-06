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

import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { INBOX, type Route } from "../app/routes.js";
import { matchesShortcut } from "../app/shortcuts.js";
import type { createWatchStore } from "../store/watch.js";
import {
  buildPaletteGroups,
  DISABLED_ROWS,
  filterPaletteGroups,
  type PaletteItem,
} from "./palette.logic.js";
import "./palette.css";

/**
 * Find (PS-12): Go to, Services, Lenses and Queue. ⌘K or Ctrl+K toggles it from anywhere; the
 * sidebar's field opens it through `onOpenChange`. Esc closes it and focus returns to the opener.
 */
export function CommandPalette({
  store,
  open,
  onOpenChange,
  onNavigate,
}: {
  store: ReturnType<typeof createWatchStore>;
  open: boolean;
  onOpenChange(open: boolean): void;
  onNavigate(route: Route): void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesShortcut(event, "k")) return;
      event.preventDefault();
      onOpenChange(!openRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="palette-backdrop" />
        <Dialog.Popup
          className="palette"
          aria-label="Find or ask"
          ref={popupRef}
          initialFocus={() => popupRef.current?.querySelector("input") ?? true}
        >
          <PaletteContent
            store={store}
            onNavigate={onNavigate}
            onClose={() => onOpenChange(false)}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteContent({
  store,
  onNavigate,
  onClose,
}: {
  store: ReturnType<typeof createWatchStore>;
  onNavigate(route: Route): void;
  onClose(): void;
}) {
  const body = useStore(store, (state) => state.snapshot?.body);
  const select = useStore(store, (state) => state.select);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => buildPaletteGroups(body), [body]);
  const shown = useMemo(() => filterPaletteGroups(groups, query), [groups, query]);
  const values = useMemo(
    () => shown.flatMap(({ items }) => items.map(({ value }) => value)),
    [shown],
  );
  const run = (item: PaletteItem) => {
    if (item.target.kind === "route") onNavigate(item.target.route);
    else {
      select(item.target.id);
      onNavigate(INBOX);
    }
    onClose();
  };
  return (
    <Autocomplete.Root
      items={values}
      value={query}
      onValueChange={(value) => setQuery(value)}
      inline
      open
      mode="none"
      autoHighlight="always"
      keepHighlight
    >
      <Autocomplete.Input
        className="palette-input"
        aria-label="Find"
        placeholder="Find a page, service or queue item"
      />
      <Autocomplete.List className="palette-results">
        {shown.length === 0 && <div className="palette-empty">Nothing matches.</div>}
        {shown.map((group) => (
          <Autocomplete.Group key={group.value} items={group.items} data-group={group.value}>
            <Autocomplete.GroupLabel className="palette-group">
              {group.label}
            </Autocomplete.GroupLabel>
            {group.items.map((item) => (
              <Autocomplete.Item
                key={item.value}
                value={item.value}
                className="palette-row"
                onClick={() => run(item)}
              >
                {item.priority !== undefined && (
                  <span className="palette-priority" data-rung={item.priority}>
                    P{item.priority}
                  </span>
                )}
                <span className="palette-label">{item.label}</span>
                <span className="palette-kind">{item.kind}</span>
              </Autocomplete.Item>
            ))}
          </Autocomplete.Group>
        ))}
        {DISABLED_ROWS.map((row) => (
          <Autocomplete.Group key={row.value} data-group={row.value}>
            <Autocomplete.GroupLabel className="palette-group">{row.label}</Autocomplete.GroupLabel>
            <div className="palette-row" data-disabled="" aria-disabled="true">
              <span className="palette-label">{row.reason}</span>
            </div>
          </Autocomplete.Group>
        ))}
      </Autocomplete.List>
      <div className="palette-hint">
        <span>↑↓ move</span>
        <span>⏎ open</span>
        <span>esc close</span>
      </div>
    </Autocomplete.Root>
  );
}
