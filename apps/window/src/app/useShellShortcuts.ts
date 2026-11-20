// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import { newThread } from "../threads/start.js";
import { FORKS, goBack, goForward, navigate, parseRoute, type Registry } from "./navigation.js";
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
        if (event.repeat) return;
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
      if (registry.views.thread && matchesShortcut(event, "n")) {
        if (dialogOpen) return;
        event.preventDefault();
        if (event.repeat) return;
        newThread(parseRoute(window.location.hash) ?? registry.fallback);
        return;
      }
      if (!registry.views.today || !matchesShortcut(event, "l")) return;
      event.preventDefault();
      navigate(FORKS);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [registry.views.today, registry.views.thread, registry.fallback, openSettings, dialogOpen]);
}
