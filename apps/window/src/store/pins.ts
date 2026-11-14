// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useSyncExternalStore } from "react";
import type { Destination } from "../app/navigation.js";

/**
 * Pins (PS-08): the one Pinned list in the sidebar, in the operator's order. A pin is the Line
 * sheet, a place, or a service by its id. A service pin stays in storage when the snapshot stops
 * naming that service; the sidebar draws only the pins it can open.
 */
export const PINS_STORAGE_KEY = "spi-code.sidebar.pins.v2";
/** Services only; read until the first write under PINS_STORAGE_KEY, after the seed. */
export const LEGACY_PINS_STORAGE_KEY = "spi-code.sidebar.pins";

export const LINE_PIN = "sheet:line";
const PLACE_KINDS = [
  "upstream",
  "environment",
  "engineering-system",
  "releases",
  "security",
] as const;
export type PinnedPlace = (typeof PLACE_KINDS)[number];
export const placePin = (kind: PinnedPlace) => `place:${kind}`;
export const SEED_PINS: readonly string[] = [LINE_PIN, ...PLACE_KINDS.map(placePin)];

/** The pin a destination is kept under; Today and a release month have none. */
export function pinOf(destination: Destination): string | undefined {
  switch (destination.kind) {
    case "line":
      return LINE_PIN;
    case "service":
      return destination.id;
    case "today":
    case "release":
      return undefined;
    default:
      return placePin(destination.kind);
  }
}

/** The place a pin opens, if it names one. */
export function pinnedPlace(id: string): PinnedPlace | undefined {
  return PLACE_KINDS.find((kind) => placePin(kind) === id);
}

/** `undefined` when storage refuses the read. */
function read(key: string): string | null | undefined {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

/** A list of non-empty strings, without repeats; anything else is corrupt. */
function parse(raw: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string" && id !== ""))
      return [...new Set<string>(parsed)];
  } catch {}
  return undefined;
}

function resolve(current: string | null | undefined, legacy: string | null | undefined) {
  if (current === undefined) return SEED_PINS;
  if (current !== null) return parse(current) ?? SEED_PINS;
  const kept = typeof legacy === "string" ? (parse(legacy) ?? []) : [];
  return [...new Set([...SEED_PINS, ...kept])];
}

const listeners = new Set<() => void>();
let cached:
  | {
      current: string | null | undefined;
      legacy: string | null | undefined;
      pins: readonly string[];
    }
  | undefined;

export function readPins(): readonly string[] {
  const current = read(PINS_STORAGE_KEY);
  const legacy = current === null ? read(LEGACY_PINS_STORAGE_KEY) : null;
  if (cached && cached.current === current && cached.legacy === legacy) return cached.pins;
  const pins = resolve(current, legacy);
  cached = { current, legacy, pins };
  return pins;
}

function writePins(pins: readonly string[]) {
  try {
    window.localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(pins));
  } catch {
    // Storage refused: the pins hold for this window only.
    const current = read(PINS_STORAGE_KEY);
    cached = { current, legacy: current === null ? read(LEGACY_PINS_STORAGE_KEY) : null, pins };
  }
  for (const listener of listeners) listener();
}

export function isPinned(id: string, pins: readonly string[] = readPins()) {
  return pins.includes(id);
}

export function pin(id: string) {
  const pins = readPins();
  if (!pins.includes(id)) writePins([...pins, id]);
}

export function unpin(id: string) {
  const pins = readPins();
  if (pins.includes(id)) writePins(pins.filter((pinned) => pinned !== id));
}

export function togglePin(id: string) {
  if (isPinned(id)) unpin(id);
  else pin(id);
}

/** Moves a pin into the place `target` holds, pushing `target` the way the pin came from. */
export function movePin(id: string, target: string) {
  const pins = [...readPins()];
  const from = pins.indexOf(id);
  const to = pins.indexOf(target);
  if (from < 0 || to < 0 || from === to) return;
  pins.splice(from, 1);
  pins.splice(to, 0, id);
  writePins(pins);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === PINS_STORAGE_KEY ||
      event.key === LEGACY_PINS_STORAGE_KEY ||
      event.key === null
    )
      listener();
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
