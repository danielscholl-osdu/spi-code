// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useSyncExternalStore } from "react";
import type { Destination } from "../app/navigation.js";

/**
 * Pins (PS-08): the sidebar's Pinned list, in the operator's order. A pin is a place or a service by
 * its id. Line, Environment and Engineering system sit in the sidebar's fixed block and are never in
 * the list. A service pin stays in storage when the snapshot stops naming that service; the sidebar
 * draws only the pins it can open.
 */
export const PINS_STORAGE_KEY = "spi-code.sidebar.pins.v3";
/** The list before the fixed block, migrated once into PINS_STORAGE_KEY. */
export const V2_PINS_STORAGE_KEY = "spi-code.sidebar.pins.v2";
/** Services only, from before V2_PINS_STORAGE_KEY. */
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
export const SEED_PINS: readonly string[] = [
  placePin("upstream"),
  placePin("releases"),
  placePin("security"),
];
/** The sidebar's fixed block below Today: never pinned, unpinned or stored. */
export const FIXED_PINS: readonly string[] = [
  LINE_PIN,
  placePin("environment"),
  placePin("engineering-system"),
];

export function isFixedPin(id: string) {
  return FIXED_PINS.includes(id);
}

/** The pin a destination is kept under; Today and a release month have none. */
export function pinOf(destination: Destination): string | undefined {
  switch (destination.kind) {
    case "line":
      return LINE_PIN;
    case "service":
      return destination.id;
    case "today":
    case "release":
    case "evidence":
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

function withoutFixed(pins: readonly string[]): readonly string[] {
  return pins.some(isFixedPin) ? pins.filter((id) => !isFixedPin(id)) : pins;
}

/** What each key held at a read; `undefined` when storage refused it, `null` when absent. */
type Raw = { current: Read; v2: Read; legacy: Read };
type Read = string | null | undefined;

function resolve({ current, v2, legacy }: Raw): readonly string[] {
  if (typeof current === "string") return withoutFixed(parse(current) ?? SEED_PINS);
  if (typeof v2 === "string") return withoutFixed(parse(v2) ?? SEED_PINS);
  if (typeof legacy !== "string") return SEED_PINS;
  const services = parse(legacy);
  return services ? withoutFixed([...new Set([...SEED_PINS, ...services])]) : SEED_PINS;
}

function readRaw(): Raw {
  const current = read(PINS_STORAGE_KEY);
  const v2 = current === null ? read(V2_PINS_STORAGE_KEY) : null;
  const legacy = current === null && v2 === null ? read(LEGACY_PINS_STORAGE_KEY) : null;
  return { current, v2, legacy };
}

const sameRaw = (a: Raw, b: Raw) =>
  a.current === b.current && a.v2 === b.v2 && a.legacy === b.legacy;

const listeners = new Set<() => void>();
/** The list last read or written, with the storage it came from; a refused write holds it here. */
let cached: { raw: Raw; pins: readonly string[] } | undefined;

/** The window's list once storage refuses a read; nothing is written for the rest of the session. */
let held: readonly string[] | undefined;

/** `false` when storage refused the write. */
function store(pins: readonly string[]): boolean {
  if (held) {
    held = pins;
    return false;
  }
  const value = JSON.stringify(pins);
  try {
    window.localStorage.setItem(PINS_STORAGE_KEY, value);
  } catch {
    cached = { raw: readRaw(), pins };
    return false;
  }
  cached = { raw: { current: value, v2: null, legacy: null }, pins };
  return true;
}

export function readPins(): readonly string[] {
  if (held) return held;
  const raw = readRaw();
  if (raw.current === undefined || raw.v2 === undefined || raw.legacy === undefined) {
    held = cached?.pins ?? resolve(raw);
    return held;
  }
  if (cached && sameRaw(cached.raw, raw)) return cached.pins;
  const pins = resolve(raw);
  cached = { raw, pins };
  // Migration: an older key is read once into the new one and left as it was.
  if (raw.current === null && (typeof raw.v2 === "string" || typeof raw.legacy === "string"))
    store(pins);
  return pins;
}

function writePins(pins: readonly string[]) {
  store(pins);
  for (const listener of listeners) listener();
}

export function isPinned(id: string, pins: readonly string[] = readPins()) {
  return pins.includes(id);
}

/** Appends a pin; the fixed block's ids are refused. */
export function pin(id: string) {
  if (isFixedPin(id)) return;
  const pins = readPins();
  if (pins.includes(id)) return;
  writePins([...pins, id]);
  changed({ kind: "pinned", pin: id, index: pins.length });
}

export function unpin(id: string) {
  if (isFixedPin(id)) return;
  const pins = readPins();
  const index = pins.indexOf(id);
  if (index < 0) return;
  writePins(pins.filter((pinned) => pinned !== id));
  changed({ kind: "unpinned", pin: id, index });
}

/** The window's change, independent of whether storage accepted its write. */
export type PinChange = { kind: "pinned" | "unpinned"; pin: string; index: number };
const changeListeners = new Set<(change: PinChange) => void>();
function changed(change: PinChange) {
  for (const listener of changeListeners) listener(change);
}
export function subscribePinChanges(listener: (change: PinChange) => void) {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

/** Restores a removed pin at its old index, bounded by the current list. */
export function restorePin(id: string, index: number) {
  if (isFixedPin(id) || isPinned(id)) return;
  const pins = [...readPins()];
  pins.splice(Math.max(0, Math.min(index, pins.length)), 0, id);
  writePins(pins);
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

/** Moves a pin to sit just before or just after `target`. */
export function movePinBeside(id: string, target: string, side: "before" | "after") {
  const all = readPins();
  if (id === target || !all.includes(id) || !all.includes(target)) return;
  const pins = all.filter((pinned) => pinned !== id);
  const at = pins.indexOf(target);
  pins.splice(side === "before" ? at : at + 1, 0, id);
  if (pins.some((pinned, index) => pinned !== all[index])) writePins(pins);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === PINS_STORAGE_KEY ||
      event.key === V2_PINS_STORAGE_KEY ||
      event.key === LEGACY_PINS_STORAGE_KEY
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
