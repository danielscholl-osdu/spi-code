// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import { useStore } from "zustand";
import { threadStore } from "./store.js";

const SHOWN_MS = 6000;

export function SettleToast() {
  const undo = useStore(threadStore, (state) => state.undo);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => threadStore.getState().dismissUndo(), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [undo]);
  return (
    <div className="pin-notice settle-toast" data-placement="window" role="status">
      {undo && (
        <span className="pin-notice-body">
          <span className="pin-notice-text">Settled {undo.title}</span>
          <span className="pin-notice-dot" aria-hidden>
            ·
          </span>
          <button
            type="button"
            className="pin-notice-undo"
            onClick={() => threadStore.getState().unsettle(undo.id, { restore: true })}
          >
            Undo
          </button>
        </span>
      )}
    </div>
  );
}
