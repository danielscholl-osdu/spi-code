// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import { isFixedPin, pinOf, togglePin } from "../store/pins.js";
import type { Route } from "./navigation.js";
import { matchesShiftShortcut } from "./shortcuts.js";

/**
 * ⌘⇧P (Ctrl+Shift+P) pins or unpins what the centre holds. `blocked` while a dialog is open or the
 * Line sheet covers the centre; Find handles the shortcut itself.
 */
export function usePinShortcut(route: Route, blocked: boolean) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesShiftShortcut(event, "p")) return;
      if (blocked) return;
      event.preventDefault();
      const id = pinOf(route);
      if (id && !isFixedPin(id)) togglePin(id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [route, blocked]);
}
