// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { threadStore } from "../../threads/store.js";
import { changesStore } from "./changes-store.js";

/** The thread's worktree as last read; the first tab that shows it asks the host to read it. */
export function useChanges(id: string) {
  const changes = useStore(changesStore, (state) => state.changes[id]);
  useEffect(() => {
    if (!changesStore.getState().changes[id]) changesStore.getState().refresh(id);
  }, [id]);
  return changes;
}

/** Reads the worktree again when a turn ends, since the turn may have changed it. */
export function useRereadAfterTurn(id: string) {
  const status = useStore(threadStore, (state) => state.threads?.find((t) => t.id === id)?.status);
  const last = useRef(status);
  useEffect(() => {
    const was = last.current;
    last.current = status;
    if (was !== status && (was === "Working" || was === "Waiting on you"))
      changesStore.getState().refresh(id);
  }, [id, status]);
}
