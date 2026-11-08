// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { type ReactNode, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { RightPanel } from "./RightPanel.js";
import type { SelectionStore } from "./selection.js";

export function RightPanelFrame({
  store,
  snapshot,
  sweepEvidence,
  presentation = "inline",
}: {
  store: SelectionStore;
  snapshot?: ViewSnapshot;
  sweepEvidence?: ReactNode;
  presentation?: "inline" | "sheet" | "closed";
}) {
  const open = useStore(store, (state) => state.open);
  const frame = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const currentPresentation = useRef(presentation);
  currentPresentation.current = presentation;
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (
          state.selected !== previous.selected &&
          state.selected !== null &&
          document.activeElement instanceof HTMLElement &&
          !frame.current?.contains(document.activeElement)
        ) {
          opener.current = document.activeElement;
          if (currentPresentation.current === "sheet")
            frame.current
              ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
              ?.focus({ preventScroll: true });
        }
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
    if (currentPresentation.current === "sheet")
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
      {presentation === "sheet" && (
        <div
          className="detail-backdrop"
          aria-hidden
          onClick={() => store.getState().setOpen(false)}
        />
      )}
      <div
        id="app-right-panel"
        className="right-panel-frame"
        data-sheet={presentation === "sheet" || undefined}
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
