// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";
import { useStore } from "zustand";
import { watchStore } from "../../store/watch.js";

export function WatchGate({ label, children }: { label: string; children: ReactNode }) {
  const setup = useStore(watchStore, (state) => state.setup);
  if (!setup || setup.watchReady) return children;
  return (
    <>
      <h1>{label}</h1>
      <p role="status">Watch unavailable: {setup.disabledReason}. Open Setup to continue.</p>
    </>
  );
}
