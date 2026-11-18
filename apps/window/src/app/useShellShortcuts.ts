// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import { FORKS, goBack, goForward, navigate, type Registry } from "./navigation.js";
import { historyShortcut, isTypingEvent, matchesShortcut } from "./shortcuts.js";

/** `dialogOpen`: Find or Settings is open, so back and forward wait for it to close. */
export function useShellShortcuts(
  registry: Registry,
  openSettings: () => void,
  dialogOpen: boolean,
) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const step = historyShortcut(event);
      if (step) {
        if (dialogOpen || isTypingEvent(event)) return;
        event.preventDefault();
        if (step === "back") goBack();
        else goForward();
        return;
      }
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
  }, [registry.views.today, openSettings, dialogOpen]);
}
