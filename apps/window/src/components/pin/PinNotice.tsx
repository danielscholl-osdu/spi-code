// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import { ariaShortcut, listenPinUndo, shortcutLabel } from "../../app/shortcuts.js";
import { pausePinNotice, undoPinChange, usePinNotice } from "../../store/pin-feedback.js";
import { useSidebar } from "../sidebar/ui-sidebar.js";
import "./pin-notice.css";

/** Both status regions remain mounted empty before the change they announce. */
export function PinNotice({ placement }: { placement: "sidebar" | "window" }) {
  const { visible } = useSidebar();
  const current = usePinNotice();
  const notice = (placement === "sidebar") === visible ? current : null;
  const hover = `${placement}:hover`;
  const focus = `${placement}:focus`;
  const active = notice !== null;
  useEffect(() => {
    if (active)
      return () => {
        pausePinNotice(hover, false);
        pausePinNotice(focus, false);
      };
    return undefined;
  }, [hover, focus, active]);
  return (
    <div
      className="pin-notice"
      data-placement={placement}
      role="status"
      aria-atomic="true"
      onMouseEnter={() => {
        if (notice) pausePinNotice(hover, true);
      }}
      onMouseLeave={() => pausePinNotice(hover, false)}
      onFocus={() => {
        if (notice) pausePinNotice(focus, true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) pausePinNotice(focus, false);
      }}
    >
      {notice && (
        <span className="pin-notice-body">
          <span className="pin-notice-text">
            {notice.kind === "pinned" ? "Pinned" : "Unpinned"} {notice.label}
          </span>
          <span className="pin-notice-dot" aria-hidden>
            ·
          </span>
          <button
            type="button"
            className="pin-notice-undo"
            title={`Undo (${shortcutLabel("z")})`}
            aria-keyshortcuts={ariaShortcut("z")}
            onClick={undoPinChange}
          >
            Undo
          </button>
        </span>
      )}
    </div>
  );
}

export function WindowPinNotice() {
  useEffect(listenPinUndo, []);
  return <PinNotice placement="window" />;
}
