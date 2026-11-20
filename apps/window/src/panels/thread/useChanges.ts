// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import { useStore } from "zustand";
import { changesStore } from "./changes-store.js";

/** The thread's worktree as last read; the first tab that shows it asks the host to read it. */
export function useChanges(id: string) {
  const changes = useStore(changesStore, (state) => state.changes[id]);
  useEffect(() => {
    if (!changesStore.getState().changes[id]) changesStore.getState().refresh(id);
  }, [id]);
  return changes;
}
