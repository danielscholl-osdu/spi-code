// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReactNode, useEffect, useRef } from "react";
import "./line-sheet.css";

/**
 * The Line sheet's frame over the centre. The surface beneath stays mounted, so closing returns to
 * it as it was. Escape closes it unless the right panel or a dialog has focus.
 */
export function LineSheet({ onClose, children }: { onClose(): void; children: ReactNode }) {
  const sheet = useRef<HTMLElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheet.current?.focus({ preventScroll: true });
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focus = document.activeElement;
      if (focus?.closest("#app-right-panel, [role='dialog']")) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      if (opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
    };
  }, [onClose]);
  return (
    <section ref={sheet} className="line-sheet" aria-label="Line" tabIndex={-1}>
      {children}
    </section>
  );
}
