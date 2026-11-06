// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useCallback, useSyncExternalStore } from "react";

export const SIDEBAR_GROUPS = ["program", "services", "lenses", "settled"] as const;
export type SidebarGroupId = (typeof SIDEBAR_GROUPS)[number];
type CollapseChoices = Partial<Record<SidebarGroupId, boolean>>;

export const COLLAPSE_STORAGE_KEY = "spi-code.sidebar.collapsed";
/** Below these window heights a group folds unless the operator has opened or folded it. */
export const FOLD_HEIGHTS: Partial<Record<SidebarGroupId, number>> = { lenses: 760, program: 640 };
const DEFAULT_COLLAPSED: Record<SidebarGroupId, boolean> = {
  program: false,
  services: false,
  lenses: false,
  settled: true,
};

const listeners = new Set<() => void>();
let cached: { raw: string | null; choices: CollapseChoices } | undefined;

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function readCollapseChoices(): CollapseChoices {
  const raw = readRaw();
  if (cached?.raw === raw) return cached.choices;
  const choices: CollapseChoices = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed === "object" && parsed !== null) {
      for (const group of SIDEBAR_GROUPS) {
        const value = (parsed as Record<string, unknown>)[group];
        if (typeof value === "boolean") choices[group] = value;
      }
    }
  } catch {
    // An unreadable entry is no choice at all.
  }
  cached = { raw, choices };
  return choices;
}

function writeCollapseChoice(group: SidebarGroupId, collapsed: boolean) {
  const next = { ...readCollapseChoices(), [group]: collapsed };
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage refused: the choice holds for this window only.
    cached = { raw: readRaw(), choices: next };
  }
  for (const listener of listeners) listener();
}

/** Whether a group is folded: the operator's choice, else the height fold, else its default. */
export function isCollapsed(group: SidebarGroupId, choices: CollapseChoices, height: number) {
  const choice = choices[group];
  if (choice !== undefined) return choice;
  const fold = FOLD_HEIGHTS[group];
  if (fold !== undefined && height < fold) return true;
  return DEFAULT_COLLAPSED[group];
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === COLLAPSE_STORAGE_KEY) listener();
  };
  window.addEventListener("resize", listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("resize", listener);
    window.removeEventListener("storage", onStorage);
  };
}

const readHeight = () => window.innerHeight;

export function useGroupCollapse() {
  const choices = useSyncExternalStore(subscribe, readCollapseChoices, readCollapseChoices);
  const height = useSyncExternalStore(subscribe, readHeight, readHeight);
  const collapsed = useCallback(
    (group: SidebarGroupId) => isCollapsed(group, choices, height),
    [choices, height],
  );
  const toggle = useCallback(
    (group: SidebarGroupId) => writeCollapseChoice(group, !isCollapsed(group, choices, height)),
    [choices, height],
  );
  return { collapsed, toggle };
}
