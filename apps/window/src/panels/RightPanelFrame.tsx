// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { type ReactNode, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { NARROW_LAYOUT_MEDIA_QUERY, useMediaQuery } from "../components/sidebar/ui-sidebar.js";
import { RightPanel } from "./RightPanel.js";
import type { SelectionStore } from "./selection.js";

export function RightPanelFrame({
  store,
  snapshot,
  sweepEvidence,
}: {
  store: SelectionStore;
  snapshot?: ViewSnapshot;
  sweepEvidence?: ReactNode;
}) {
  const narrow = useMediaQuery(NARROW_LAYOUT_MEDIA_QUERY);
  const open = useStore(store, (state) => state.open);
  const frame = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (window.matchMedia(NARROW_LAYOUT_MEDIA_QUERY).matches && store.getState().selected === null)
      store.getState().setOpen(false);
  }, [store]);
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (
          state.selected !== previous.selected &&
          state.selected !== null &&
          document.activeElement instanceof HTMLElement &&
          !frame.current?.contains(document.activeElement)
        )
          opener.current = document.activeElement;
      }),
    [store],
  );
  useEffect(() => {
    if (!open) return;
    if (
      document.activeElement instanceof HTMLElement &&
      !frame.current?.contains(document.activeElement)
    )
      opener.current = document.activeElement;
    if (window.matchMedia(NARROW_LAYOUT_MEDIA_QUERY).matches)
      frame.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
    const close = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !frame.current?.contains(document.activeElement)
      )
        return;
      event.preventDefault();
      store.getState().setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      const target = opener.current?.isConnected
        ? opener.current
        : document.querySelector<HTMLElement>('[aria-controls="app-right-panel"]');
      target?.focus({ preventScroll: true });
    };
  }, [open, store]);
  if (!open) return null;
  return (
    <>
      {narrow && (
        <div
          className="detail-backdrop"
          aria-hidden
          onClick={() => store.getState().setOpen(false)}
        />
      )}
      <div
        id="app-right-panel"
        className="right-panel-frame"
        data-sheet={narrow || undefined}
        ref={frame}
      >
        <RightPanel
          store={store}
          {...(snapshot ? { snapshot } : {})}
          sweepEvidence={sweepEvidence}
          onClose={() => store.getState().setOpen(false)}
        />
      </div>
    </>
  );
}
