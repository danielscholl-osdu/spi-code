// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useSyncExternalStore } from "react";

/**
 * Pins (PS-08): the services the operator keeps in the sidebar, in the order pinned. A pin names a
 * service by id and stays in storage when the snapshot stops naming that service; the sidebar
 * draws only the pins the snapshot names.
 */
export const PINS_STORAGE_KEY = "spi-code.sidebar.pins";

const EMPTY: readonly string[] = [];
const listeners = new Set<() => void>();
let cached: { raw: string | null; pins: readonly string[] } | undefined;

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(PINS_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function readPins(): readonly string[] {
  const raw = readRaw();
  if (cached?.raw === raw) return cached.pins;
  let pins = EMPTY;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      pins = [...new Set(parsed.filter((id): id is string => typeof id === "string" && !!id))];
    }
  } catch {
    // An unreadable entry pins nothing.
  }
  cached = { raw, pins };
  return pins;
}

function writePins(pins: readonly string[]) {
  try {
    window.localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Storage refused: the pins hold for this window only.
    cached = { raw: readRaw(), pins };
  }
  for (const listener of listeners) listener();
}

export function isPinned(service: string, pins: readonly string[] = readPins()) {
  return pins.includes(service);
}

export function pin(service: string) {
  const pins = readPins();
  if (!pins.includes(service)) writePins([...pins, service]);
}

export function unpin(service: string) {
  const pins = readPins();
  if (pins.includes(service)) writePins(pins.filter((id) => id !== service));
}

export function togglePin(service: string) {
  if (isPinned(service)) unpin(service);
  else pin(service);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === PINS_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePins(): readonly string[] {
  return useSyncExternalStore(subscribe, readPins, readPins);
}
