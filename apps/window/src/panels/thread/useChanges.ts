// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { threadStore } from "../../threads/store.js";
import { changesStore } from "./changes-store.js";

/** The thread's worktree as last read. */
export function useChanges(id: string) {
  return useStore(changesStore, (state) => state.changes[id]);
}

/** Reads the worktree when the tab is shown, and again when a turn ends, since it may have changed it. */
export function useReadWhileShown(id: string) {
  const status = useStore(threadStore, (state) => state.threads?.find((t) => t.id === id)?.status);
  const last = useRef({ id, status });
  useEffect(() => {
    changesStore.getState().refresh(id);
  }, [id]);
  useEffect(() => {
    const was = last.current;
    last.current = { id, status };
    if (
      was.id === id &&
      was.status !== status &&
      ["Working", "Waiting on you"].includes(was.status ?? "")
    )
      changesStore.getState().refresh(id);
  }, [id, status]);
}
