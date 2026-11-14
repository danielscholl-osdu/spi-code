// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useSyncExternalStore } from "react";

export type PaletteChoice = "warm" | "neutral";

const KEY = "spi-code.palette";
const listeners = new Set<() => void>();
let shown: PaletteChoice = "neutral";

export function readPalette(storage?: Pick<Storage, "getItem">): PaletteChoice {
  try {
    return (storage ?? window.localStorage).getItem(KEY) === "warm" ? "warm" : "neutral";
  } catch {
    return "neutral";
  }
}

export function applyPalette(
  choice: PaletteChoice = readPalette(),
  target: HTMLElement = document.documentElement,
) {
  target.dataset.palette = choice;
  if (choice === shown) return;
  shown = choice;
  for (const listener of listeners) listener();
}

export function setPalette(choice: PaletteChoice) {
  applyPalette(choice);
  try {
    window.localStorage.setItem(KEY, choice);
  } catch {}
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => shown;

export function usePalette(): PaletteChoice {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
