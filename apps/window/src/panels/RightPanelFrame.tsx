// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReactNode, useEffect, useRef } from "react";
import "./panels.css";

/** Frame for a thread's context, including its narrow-window sheet and return focus. */
export function RightPanelFrame({
  open,
  onClose,
  children,
  presentation = "inline",
}: {
  open: boolean;
  onClose(): void;
  children: ReactNode;
  presentation?: "inline" | "sheet" | "closed";
}) {
  const frame = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const currentPresentation = useRef(presentation);
  currentPresentation.current = presentation;
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !frame.current?.contains(active))
      opener.current = active === document.body ? null : active;
    if (currentPresentation.current === "sheet")
      frame.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
    const onEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !frame.current?.contains(document.activeElement)
      )
        return;
      event.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("keydown", onEscape);
      const target = opener.current?.isConnected
        ? opener.current
        : document.querySelector<HTMLElement>('[aria-controls="app-right-panel"]');
      target?.focus({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  return (
    <>
      {presentation === "sheet" && (
        <div className="context-backdrop" aria-hidden onClick={onClose} />
      )}
      <div
        id="app-right-panel"
        className="right-panel-frame"
        data-sheet={presentation === "sheet" || undefined}
        ref={frame}
      >
        {children}
      </div>
    </>
  );
}
