// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import { FORKS, navigate, type Registry } from "./navigation.js";
import { isTypingEvent, matchesShortcut } from "./shortcuts.js";

export function useShellShortcuts(registry: Registry, openSettings: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (matchesShortcut(event, ",")) {
        if (isTypingEvent(event)) return;
        event.preventDefault();
        openSettings();
        return;
      }
      if (!registry.views.today || !matchesShortcut(event, "l")) return;
      event.preventDefault();
      navigate(FORKS);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [registry.views.today, openSettings]);
}
