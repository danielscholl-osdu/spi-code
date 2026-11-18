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
import { useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { type Destination, LINE, useRegistry } from "../app/routes.js";
import { isMacPlatform, matchesShiftShortcut, shiftShortcutLabel } from "../app/shortcuts.js";
import { PinControl } from "../components/pin/PinControl.js";
import { useSidebarAttention } from "../components/sidebar/attention.js";
import { ServiceMark, serviceMark } from "../components/sidebar/service-mark.js";
import { isFixedPin, pin, togglePin, usePins } from "../store/pins.js";
import type { createWatchStore } from "../store/watch.js";
import { openTodayRow } from "../views/today/Table.js";
import { buildPaletteGroups, filterPaletteGroups, type PaletteItem } from "./palette.logic.js";
import "./palette.css";

type PinState = "unpinned" | "pinned" | "always";

const PIN_STATE_NAME: Readonly<Record<PinState, string>> = {
  unpinned: "not pinned",
  pinned: "pinned",
  always: "always in the sidebar",
};

function pinStateOf(id: string, pins: readonly string[]): PinState {
  if (isFixedPin(id)) return "always";
  return pins.includes(id) ? "pinned" : "unpinned";
}

/**
 * Find (PS-12): Go to, Services and Queue. The shell opens it from ⌘K or Ctrl+K (through
 * PanelControls' shortcuts) and from the sidebar's field. ⏎ opens a result; ⌘↩ (Ctrl+Enter) opens
 * a place or a service and pins it, leaving a pin where it is; the sidebar's fixed block opens
 * unpinned. ⌘⇧P (Ctrl+Shift+P) pins or unpins the highlighted result in place, as its pointer-only
 * pin control does. Esc closes it and focus returns to the opener.
 */
export function CommandPalette({
  store,
  open,
  onOpenChange,
  onNavigate,
  onSettings,
}: {
  store: ReturnType<typeof createWatchStore>;
  open: boolean;
  onOpenChange(open: boolean): void;
  onNavigate(destination: Destination): void;
  /** Opens Settings on Readiness. */
  onSettings(): void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const body = useStore(store, (state) => state.snapshot?.body);
  const attention = useSidebarAttention(body);
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
            attention={attention}
            onNavigate={onNavigate}
            onSettings={onSettings}
            onClose={() => onOpenChange(false)}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteContent({
  store,
  attention,
  onNavigate,
  onSettings,
  onClose,
}: {
  store: ReturnType<typeof createWatchStore>;
  attention: ReturnType<typeof useSidebarAttention>;
  onNavigate(destination: Destination): void;
  onSettings(): void;
  onClose(): void;
}) {
  const body = useStore(store, (state) => state.snapshot?.body);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined);
  const registry = useRegistry();
  const pins = usePins();
  const groups = useMemo(() => buildPaletteGroups(body, registry), [body, registry]);
  const shown = useMemo(() => filterPaletteGroups(groups, query), [groups, query]);
  const highlightedItem = shown
    .flatMap(({ items }) => items)
    .find(({ value }) => value === highlighted);
  const values = useMemo(
    () => shown.flatMap(({ items }) => items.map(({ value }) => value)),
    [shown],
  );
  const run = (item: PaletteItem) => {
    if (item.target.kind === "route") onNavigate(item.target.route);
    else if (item.target.kind === "line") onNavigate(LINE);
    else if (item.target.kind === "settings") onSettings();
    else openTodayRow(body?.briefing.lines, item.target.id);
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
      onItemHighlighted={(value) => setHighlighted(value)}
    >
      <Autocomplete.Input
        className="palette-input"
        aria-label="Find"
        placeholder="Find a page, service or queue item"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
            // Confirming an IME candidate must not select a row.
            (
              event as typeof event & { preventBaseUIHandler?: () => void }
            ).preventBaseUIHandler?.();
            return;
          }
          if (
            event.key === "Enter" &&
            (isMacPlatform() ? event.metaKey : event.ctrlKey) &&
            highlightedItem
          ) {
            event.preventDefault();
            if (highlightedItem.pin) pin(highlightedItem.pin);
            run(highlightedItem);
            return;
          }
          if (matchesShiftShortcut(event, "p")) {
            event.preventDefault();
            const id = highlightedItem?.pin;
            if (id && !isFixedPin(id)) togglePin(id);
          }
        }}
      />
      <Autocomplete.List className="palette-results">
        {shown.length === 0 && <div className="palette-empty">Nothing matches.</div>}
        {shown.map((group) => (
          <Autocomplete.Group key={group.value} items={group.items} data-group={group.value}>
            <Autocomplete.GroupLabel className="palette-group">
              {group.label}
            </Autocomplete.GroupLabel>
            {group.items.map((item) => {
              const route = item.target.kind === "route" ? item.target.route : undefined;
              const service = route?.kind === "service" ? route : undefined;
              const mark = service ? attention.get(`service:${service.id}`) : undefined;
              const kind = service ? mark?.word : item.kind;
              const home = service ? serviceMark(body, service.id) : undefined;
              const pinState = item.pin === undefined ? undefined : pinStateOf(item.pin, pins);
              return (
                <Autocomplete.Item
                  key={item.value}
                  value={item.value}
                  className="palette-row"
                  data-pin-state={pinState}
                  aria-label={
                    pinState
                      ? [item.label, home?.label, kind, PIN_STATE_NAME[pinState]]
                          .filter(Boolean)
                          .join(", ")
                      : undefined
                  }
                  onClick={() => run(item)}
                >
                  <ServiceMark mark={home} />
                  {item.priority !== undefined && (
                    <span className="palette-priority" data-rung={item.priority}>
                      P{item.priority}
                    </span>
                  )}
                  <span className="palette-label">{item.label}</span>
                  {kind && (
                    <span className="palette-kind" title={service ? kind : undefined}>
                      {kind}
                    </span>
                  )}
                  {item.pin !== undefined && (
                    <PinControl pin={item.pin} name={item.label} size="row" inList />
                  )}
                </Autocomplete.Item>
              );
            })}
          </Autocomplete.Group>
        ))}
      </Autocomplete.List>
      <div className="palette-hint">
        <span>↑↓ move</span>
        <span>⏎ open</span>
        <span>{isMacPlatform() ? "⌘↩" : "Ctrl+Enter"} open and pin</span>
        <span>{shiftShortcutLabel("p")} pin</span>
        <span>esc close</span>
      </div>
    </Autocomplete.Root>
  );
}
