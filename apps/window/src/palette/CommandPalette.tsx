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
import { type ComponentProps, type ReactNode, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { parseRoute } from "../app/navigation.js";
import {
  type Destination,
  isReachable,
  lastTodayRoute,
  sameRoute,
  setOpenSelection,
  useRegistry,
} from "../app/routes.js";
import { isMacPlatform, matchesShiftShortcut, shiftShortcutLabel } from "../app/shortcuts.js";
import { PinControl } from "../components/pin/PinControl.js";
import { ServiceMark, serviceMark } from "../components/sidebar/service-mark.js";
import { isFixedPin, pin, togglePin, usePins } from "../store/pins.js";
import type { createWatchStore } from "../store/watch.js";
import { scopeOfRoute } from "../threads/scopes.js";
import { askFromFind } from "../threads/start.js";
import { NEW_THREAD, threadStore } from "../threads/store.js";
import { openCause } from "../views/today/CanWait.js";
import { openTodayLine } from "../views/today/Table.js";
import {
  askGroup,
  buildPaletteGroups,
  filterPaletteGroups,
  type PaletteItem,
} from "./palette.logic.js";
import "./palette.css";

type PinState = "unpinned" | "pinned" | "always";

const PIN_STATE_NAME: Readonly<Record<PinState, string>> = {
  unpinned: "not pinned",
  pinned: "pinned",
  always: "always in the sidebar",
};

const TODAY = { kind: "today" } as const;

function pinStateOf(id: string, pins: readonly string[]): PinState {
  if (isFixedPin(id)) return "always";
  return pins.includes(id) ? "pinned" : "unpinned";
}

/**
 * Find (PS-12): Go to, Services, and Today's Blocked, Waiting on you and Can wait rows. The shell
 * opens it from ⌘K or Ctrl+K (through PanelControls' shortcuts) and from the sidebar's field. ⏎
 * opens a result; ⌘↩ (Ctrl+Enter) opens a place or a service and pins it, leaving a pin where it
 * is; the sidebar's fixed block opens unpinned. ⌘⇧P (Ctrl+Shift+P) pins or unpins the highlighted result in place, as its pointer-only
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
  const asked = useRef(false);
  return (
    <PaletteFrame
      open={open}
      onOpenChange={onOpenChange}
      label="Find or ask"
      finalFocus={() => {
        const draft = asked.current;
        asked.current = false;
        return draft
          ? (document.querySelector<HTMLElement>(".thread-view--draft textarea") ?? false)
          : true;
      }}
    >
      <PaletteContent
        store={store}
        onNavigate={onNavigate}
        onSettings={onSettings}
        onAsk={(text) => {
          asked.current = true;
          askFromFind(text);
        }}
        onClose={() => onOpenChange(false)}
      />
    </PaletteFrame>
  );
}

/** Find's modal window over the dimmed page, focus on its first input; the scope picker shares it. */
export function PaletteFrame({
  open,
  onOpenChange,
  label,
  className,
  finalFocus,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  label: string;
  className?: string;
  finalFocus?: ComponentProps<typeof Dialog.Popup>["finalFocus"];
  children: ReactNode;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={className ? `palette-backdrop ${className}` : "palette-backdrop"}
        />
        <Dialog.Popup
          className={className ? `palette ${className}` : "palette"}
          aria-label={label}
          ref={popupRef}
          initialFocus={() => popupRef.current?.querySelector("input") ?? true}
          {...(finalFocus === undefined ? {} : { finalFocus })}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteContent({
  store,
  onNavigate,
  onSettings,
  onAsk,
  onClose,
}: {
  store: ReturnType<typeof createWatchStore>;
  onNavigate(destination: Destination): void;
  onSettings(): void;
  /** Ask Copilot: a draft holding the typed sentence. */
  onAsk(text: string): void;
  onClose(): void;
}) {
  const body = useStore(store, (state) => state.snapshot?.body);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | undefined>(undefined);
  const registry = useRegistry();
  const pins = usePins();
  const threads = useStore(threadStore, (state) => state.threads);
  const groups = useMemo(
    () => buildPaletteGroups(body, registry, threads),
    [body, registry, threads],
  );
  const asks = isReachable({ kind: "thread", id: NEW_THREAD }, registry);
  const shown = useMemo(() => {
    const ask = asks && askGroup(query, scopeOfRoute(parseRoute(window.location.hash)));
    return [...filterPaletteGroups(groups, query), ...(ask ? [ask] : [])];
  }, [groups, query, asks]);
  const highlightedItem = shown
    .flatMap(({ items }) => items)
    .find(({ value }) => value === highlighted);
  const values = useMemo(
    () => shown.flatMap(({ items }) => items.map(({ value }) => value)),
    [shown],
  );
  const run = ({ target }: PaletteItem) => {
    if (target.kind === "route")
      onNavigate(sameRoute(target.route, TODAY) ? lastTodayRoute() : target.route);
    else if (target.kind === "settings") onSettings();
    else if (target.kind === "ask") onAsk(target.text);
    else if (target.kind === "line") openTodayLine(body?.briefing.lines, target.id);
    else if (body?.briefing.today?.causes?.rows.some(({ id }) => id === target.id))
      openCause(target.id);
    else {
      onNavigate(TODAY);
      setOpenSelection(null);
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
      onItemHighlighted={(value) => setHighlighted(value)}
    >
      <Autocomplete.Input
        className="palette-input"
        aria-label="Find"
        placeholder="Find a page, service or Today row"
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
            if (highlightedItem.external) {
              event.preventBaseUIHandler();
              void window.spi?.openExternal(highlightedItem.external);
              onClose();
            } else {
              if (highlightedItem.pin) pin(highlightedItem.pin);
              run(highlightedItem);
            }
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
              const service = route?.kind === "service" && !route.tab ? route : undefined;
              const kind = service ? undefined : item.kind;
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
                  <span className="palette-label">{item.label}</span>
                  {kind && <span className="palette-kind">{kind}</span>}
                  {(item.count === null || !!item.count) && (
                    <span
                      className="palette-kind service-tab-count"
                      title={item.count === null ? "Not read" : undefined}
                    >
                      {item.count === null ? "⌀" : item.count}
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
        <span>
          {isMacPlatform() ? "⌘↩" : "Ctrl+Enter"}{" "}
          {highlightedItem?.external ? "GitHub ↗" : "open and pin"}
        </span>
        <span>{shiftShortcutLabel("p")} pin</span>
        <span>esc close</span>
      </div>
    </Autocomplete.Root>
  );
}
