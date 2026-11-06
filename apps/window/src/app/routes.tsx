// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { watchStore } from "../store/watch.js";
import Environment from "../views/environment/index.js";
import Inbox from "../views/inbox/index.js";
import Releases from "../views/releases/index.js";
import Setup from "../views/setup/index.js";
import { WatchGate } from "../views/setup/WatchGate.js";

export const LENSES = ["flow", "repositories", "horizon"] as const;
export type Lens = (typeof LENSES)[number];

export type Route =
  | { kind: "inbox" }
  | { kind: "service"; id: string }
  | { kind: "template" }
  | { kind: "environment" }
  | { kind: "releases" }
  | { kind: "release"; month: string }
  | { kind: "lens"; lens: Lens }
  | { kind: "setup" };

export const INBOX: Route = { kind: "inbox" };

const SERVICE_ID = /^[a-z0-9][a-z0-9-]*$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LENS_LABELS: Record<Lens, string> = {
  flow: "Flow",
  repositories: "Repositories",
  horizon: "Horizon",
};

function isLens(value: string): value is Lens {
  return (LENSES as readonly string[]).includes(value);
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Reads a location hash (`#service/legal`, `release/2026-10`); anything unknown is the Inbox. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  const slash = path.indexOf("/");
  const head = slash < 0 ? path : path.slice(0, slash);
  const rest = slash < 0 ? undefined : decode(path.slice(slash + 1));
  switch (head) {
    case "template":
    case "environment":
    case "releases":
    case "setup":
    case "inbox":
      return rest === undefined ? { kind: head } : INBOX;
    case "service":
      return rest !== undefined && SERVICE_ID.test(rest) ? { kind: "service", id: rest } : INBOX;
    case "release":
      return rest !== undefined && MONTH.test(rest) ? { kind: "release", month: rest } : INBOX;
    case "lens":
      return rest !== undefined && isLens(rest) ? { kind: "lens", lens: rest } : INBOX;
    default:
      return INBOX;
  }
}

export function routeHash(route: Route): string {
  switch (route.kind) {
    case "service":
      return `#service/${encodeURIComponent(route.id)}`;
    case "release":
      return `#release/${route.month}`;
    case "lens":
      return `#lens/${route.lens}`;
    default:
      return `#${route.kind}`;
  }
}

/** The place a route names, as the title bar and the page heading show it. */
export function routeLabel(route: Route): string {
  switch (route.kind) {
    case "inbox":
      return "Inbox";
    case "service":
      return route.id;
    case "template":
      return "Template";
    case "environment":
      return "Environment";
    case "releases":
      return "Releases";
    case "release":
      return `Release ${route.month}`;
    case "lens":
      return LENS_LABELS[route.lens];
    case "setup":
      return "Setup";
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  return routeHash(a) === routeHash(b);
}

// The browser fires hashchange after the task that set the hash; the window re-renders at once.
const hashListeners = new Set<() => void>();

function subscribeHash(listener: () => void) {
  hashListeners.add(listener);
  window.addEventListener("hashchange", listener);
  return () => {
    hashListeners.delete(listener);
    window.removeEventListener("hashchange", listener);
  };
}

function readHash() {
  return window.location.hash;
}

export function navigate(route: Route) {
  const hash = routeHash(route);
  if (window.location.hash === hash) return;
  window.location.hash = hash;
  for (const listener of hashListeners) listener();
}

/** The current route, kept in the location hash so a reload returns to the same place. */
export function useHashRoute(): [Route, (route: Route) => void] {
  const hash = useSyncExternalStore(subscribeHash, readHash, readHash);
  const route = useMemo(() => parseRoute(hash), [hash]);
  return [route, useCallback(navigate, [])];
}

/** Opens Setup once when the host's first setup state says Watch is not ready. */
export function useSetupLanding(go: (route: Route) => void) {
  const setup = useStore(watchStore, (state) => state.setup);
  const checked = useRef(false);
  useEffect(() => {
    if (!setup || checked.current) return;
    checked.current = true;
    if (!setup.watchReady) go({ kind: "setup" });
  }, [setup, go]);
}

function Unavailable({ label }: { label: string }) {
  return (
    <>
      <h1>{label}</h1>
      <p>This page is not available yet.</p>
    </>
  );
}

/** The middle frame's content for a route. Watch pages wait behind the Watch gate. */
export function RouteView({ route }: { route: Route }) {
  if (route.kind === "setup") return <Setup />;
  const label = routeLabel(route);
  return (
    <WatchGate label={label}>
      {route.kind === "inbox" ? (
        <Inbox onNavigate={navigate} />
      ) : route.kind === "environment" ? (
        <Environment />
      ) : route.kind === "releases" ? (
        <Releases />
      ) : (
        <Unavailable label={label} />
      )}
    </WatchGate>
  );
}
