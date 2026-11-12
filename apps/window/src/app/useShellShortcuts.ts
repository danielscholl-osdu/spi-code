// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import type { Registry } from "./routes.js";
import { isTypingEvent, matchesShortcut } from "./shortcuts.js";

export function useShellShortcuts(
  registry: Registry,
  toggleSheet: () => void,
  openSettings: () => void,
) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (matchesShortcut(event, ",")) {
        if (isTypingEvent(event)) return;
        event.preventDefault();
        openSettings();
        return;
      }
      if (!registry.sheet || !matchesShortcut(event, "l")) return;
      event.preventDefault();
      toggleSheet();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [registry.sheet, toggleSheet, openSettings]);
}
