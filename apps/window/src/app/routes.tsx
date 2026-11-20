// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReactNode, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { SidebarSweep } from "../components/capsule/SweepSegment.js";
import { EvidencePage } from "../components/evidence/EvidencePage.js";
import { BeforeFirstSweep } from "../components/sweep/BeforeFirstSweep.js";
import { OPEN_READINESS_EVENT, openReadiness } from "../settings/readiness.js";
import { watchStore } from "../store/watch.js";
import { ThreadPage } from "../threads/ThreadPage.js";
import Environment from "../views/environment/index.js";
import Releases, { ReleaseMonth } from "../views/releases/index.js";
import Security from "../views/security/index.js";
import ServicePage from "../views/service/index.js";
import { WatchGate } from "../views/setup/WatchGate.js";
import Template from "../views/template/index.js";
import Today from "../views/today/index.js";
import Upstream from "../views/upstream/index.js";
import {
  type EvidenceRoute,
  type Registry,
  type Route,
  renderRoute,
  routeLabel,
  type ThreadRoute,
  useRegistryOr,
} from "./navigation.js";

export * from "./navigation.js";

/**
 * Watch pages wait behind the Watch gate, which names the place while it holds them; a place
 * other than Today opens one line until the first snapshot.
 */
function gated(route: Exclude<Route, EvidenceRoute | ThreadRoute>, page: ReactNode) {
  return (
    <WatchGate label={routeLabel(route)}>
      {route.kind === "today" ? page : <BeforeFirstSweep route={route}>{page}</BeforeFirstSweep>}
    </WatchGate>
  );
}

function Evidence({ route }: { route: EvidenceRoute }) {
  const { snapshot, sweep, progress, completed } = useStore(watchStore);
  return (
    <EvidencePage
      route={route}
      snapshot={snapshot?.body ?? null}
      sweep={sweep}
      progress={progress}
      completed={completed}
      onOpenSettings={openReadiness}
    />
  );
}

/** The window's views by route. */
export const DEFAULT_REGISTRY: Registry = {
  views: {
    today: (route) => gated(route, <Today tab={route.tab} station={route.station} />),
    upstream: (route) => gated(route, <Upstream />),
    environment: (route) => gated(route, <Environment range={route.range} />),
    "engineering-system": (route) => gated(route, <Template />),
    releases: (route) => gated(route, <Releases section={route.section} />),
    security: (route) => gated(route, <Security />),
    service: (route) => gated(route, <ServicePage id={route.id} tab={route.tab} row={route.row} />),
    release: (route) => gated(route, <ReleaseMonth month={route.month} />),
    evidence: (route) => <Evidence route={route} />,
    thread: (route) => <ThreadPage key={route.id} id={route.id} />,
  },
  strip: () => <SidebarSweep />,
  fallback: { kind: "today" },
};

/** The registry the shell provides, or the window's own outside a shell. */
export function useRegistry(): Registry {
  return useRegistryOr(DEFAULT_REGISTRY);
}

/**
 * Opens Settings on Readiness once when the host's first setup state says Watch is not ready; a
 * tool that needs attention later opens nothing.
 */
export function useSetupLanding(openReadiness: () => void) {
  const setup = useStore(watchStore, (state) => state.setup);
  const checked = useRef(false);
  useEffect(() => {
    window.addEventListener(OPEN_READINESS_EVENT, openReadiness);
    return () => window.removeEventListener(OPEN_READINESS_EVENT, openReadiness);
  }, [openReadiness]);
  useEffect(() => {
    if (!setup || checked.current) return;
    checked.current = true;
    if (!setup.watchReady) openReadiness();
  }, [setup, openReadiness]);
}

/** The centre's content for a route. */
export function RouteView({ route }: { route: Route }) {
  return renderRoute(route, useRegistry());
}
