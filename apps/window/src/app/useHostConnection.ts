// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";
import { selectionStore } from "../panels/index.js";
import { changesStore } from "../panels/thread/changes-store.js";
import { watchStore } from "../store/watch.js";
import { threadStore } from "../threads/store.js";
import { type Appearance, createAppearance } from "./appearance.js";
import { openDestination, parseDestination } from "./destination.js";

/** The host's messages, tray destinations and appearance, and the line a bad message leaves. */
export function useHostConnection({
  openReadiness,
  setSettingsOpen,
  setFindOpen,
}: {
  openReadiness: () => void;
  setSettingsOpen: (open: boolean) => void;
  setFindOpen: (open: boolean) => void;
}) {
  const [appearance, setAppearance] = useState<ReturnType<typeof createAppearance>>();
  const [theme, setTheme] = useState<Appearance>();
  const pinTheme = useCallback(
    (value: Appearance) => {
      appearance?.setPin(value);
      setTheme(value);
    },
    [appearance],
  );
  const [error, setError] = useState("");
  /** Kept current so the one navigation subscription sees the current Settings controls. */
  const routeDestination = useRef<(input: unknown) => void>(() => {});
  useEffect(() => {
    routeDestination.current = (input) => {
      const destination = parseDestination(input);
      if (!destination) return;
      // A tray destination lands on top: close what would cover it before opening it.
      // Readiness is a Settings section: the dialog opens over whatever is showing.
      if (destination.to === "readiness") {
        openReadiness();
        return;
      }
      setSettingsOpen(false);
      setFindOpen(false);
      openDestination(destination);
    };
  }, [openReadiness, setSettingsOpen, setFindOpen]);
  useEffect(() => {
    const controller = createAppearance(undefined, undefined, undefined, (theme) => {
      void window.spi.setAppearance?.(theme);
    });
    setAppearance(controller);
    setTheme(controller.pin);
    const unsubscribe = window.spi.onMessage((message) => {
      selectionStore.getState().receive(message);
      threadStore.getState().receive(message);
      changesStore.getState().receive(message);
      try {
        watchStore.getState().receive(message);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    const unroute = window.spi.onNavigate?.((input) => routeDestination.current(input));
    return () => {
      controller.dispose();
      unsubscribe();
      unroute?.();
    };
  }, []);
  return { theme, pinTheme, error };
}
