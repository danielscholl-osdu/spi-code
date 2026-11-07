// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReactNode, useEffect, useRef } from "react";
import { useStore } from "zustand";
import { Strip } from "../components/strip/Strip.js";
import { watchStore } from "../store/watch.js";
import Environment from "../views/environment/index.js";
import Flow from "../views/flow/index.js";
import Horizon from "../views/horizon/index.js";
import Line from "../views/line/index.js";
import Releases, { ReleaseMonth } from "../views/releases/index.js";
import Repositories from "../views/repositories/index.js";
import Security from "../views/security/index.js";
import ServicePage from "../views/service/index.js";
import Setup from "../views/setup/index.js";
import { WatchGate } from "../views/setup/WatchGate.js";
import Template from "../views/template/index.js";
import Today from "../views/today/index.js";
import {
  type Destination,
  type Registry,
  type Route,
  renderRoute,
  routeLabel,
  useRegistryOr,
} from "./navigation.js";

export * from "./navigation.js";

/** Watch pages wait behind the Watch gate, which names the place while it holds them. */
function gated(route: Route, page: ReactNode) {
  return <WatchGate label={routeLabel(route)}>{page}</WatchGate>;
}

/** The window's views by route. Upstream stays unlisted until its component exists. */
export const DEFAULT_REGISTRY: Registry = {
  views: {
    today: (route) => gated(route, <Today />),
    environment: (route) => gated(route, <Environment />),
    "engineering-system": (route) => gated(route, <Template />),
    releases: (route) => gated(route, <Releases />),
    security: (route) => gated(route, <Security />),
    service: (route) => gated(route, <ServicePage id={route.id} />),
    release: (route) => gated(route, <ReleaseMonth month={route.month} />),
    lens: (route) =>
      gated(
        route,
        route.lens === "flow" ? (
          <Flow />
        ) : route.lens === "repositories" ? (
          <Repositories />
        ) : (
          <Horizon />
        ),
      ),
    setup: () => <Setup />,
  },
  sheet: (_origin, presentation) => <Line presentation={presentation} />,
  strip: () => <Strip />,
  fallback: { kind: "today" },
};

/** The registry the shell provides, or the window's own outside a shell. */
export function useRegistry(): Registry {
  return useRegistryOr(DEFAULT_REGISTRY);
}

/** Opens Setup once when the host's first setup state says Watch is not ready. */
export function useSetupLanding(go: (destination: Destination) => void) {
  const setup = useStore(watchStore, (state) => state.setup);
  const checked = useRef(false);
  useEffect(() => {
    if (!setup || checked.current) return;
    checked.current = true;
    if (!setup.watchReady) go({ kind: "setup" });
  }, [setup, go]);
}

/** The centre's content for a route. */
export function RouteView({ route }: { route: Route }) {
  return renderRoute(route, useRegistry());
}
