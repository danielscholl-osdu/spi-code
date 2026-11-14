// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";
import { useStore } from "zustand";
import { PaneTitle } from "../../app/title-row.js";
import { openReadiness } from "../../settings/readiness.js";
import { watchStore } from "../../store/watch.js";

export function WatchGate({ label, children }: { label: string; children: ReactNode }) {
  const setup = useStore(watchStore, (state) => state.setup);
  if (!setup || setup.watchReady) return children;
  return (
    <>
      <PaneTitle>
        <h1 data-place>{label}</h1>
      </PaneTitle>
      <p role="status">Watch unavailable: {setup.disabledReason}. Open Settings to continue.</p>
      <button type="button" onClick={openReadiness}>
        Open Settings
      </button>
    </>
  );
}
