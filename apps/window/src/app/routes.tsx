// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ComponentType, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { watchStore } from "../store/watch.js";
import Environment from "../views/environment/index.js";
import Flow from "../views/flow/index.js";
import Horizon from "../views/horizon/index.js";
import Releases from "../views/releases/index.js";
import Repositories from "../views/repositories/index.js";
import Setup from "../views/setup/index.js";
import { WatchGate } from "../views/setup/WatchGate.js";
import Today from "../views/today/index.js";

function guarded(label: string, View: ComponentType) {
  return () => (
    <WatchGate label={label}>
      <View />
    </WatchGate>
  );
}

export const routes = [
  { id: "today", label: "Today", View: guarded("Today", Today) },
  { id: "repositories", label: "Repositories", View: guarded("Repositories", Repositories) },
  { id: "releases", label: "Releases", View: guarded("Releases", Releases) },
  { id: "environment", label: "Environment", View: guarded("Environment", Environment) },
  { id: "flow", label: "Flow", View: guarded("Flow", Flow) },
  { id: "horizon", label: "Horizon", View: guarded("Horizon", Horizon) },
  { id: "setup", label: "Setup", View: Setup },
] as const;

export function useSetupLanding(navigate: (route: (typeof routes)[number]) => void) {
  const setup = useStore(watchStore, (state) => state.setup);
  const checked = useRef(false);
  useEffect(() => {
    if (!setup || checked.current) return;
    checked.current = true;
    if (!setup.watchReady) navigate(routes[6]);
  }, [setup, navigate]);
}
