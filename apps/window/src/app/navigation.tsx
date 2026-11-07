// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useStore } from "zustand";
import { watchStore } from "../store/watch.js";

export const LENSES = ["flow", "repositories", "horizon"] as const;
export type Lens = (typeof LENSES)[number];

/** Places in the order the sidebar and Find list them; a service and a release month are reached from elsewhere. */
export const PLACES = [
  { kind: "upstream" },
  { kind: "environment" },
  { kind: "engineering-system" },
  { kind: "releases" },
  { kind: "security" },
] as const satisfies readonly Route[];

export type PlaceRoute =
  | { kind: "upstream" }
  | { kind: "environment" }
  | { kind: "engineering-system" }
  | { kind: "releases" }
  | { kind: "security" }
  | { kind: "service"; id: string }
  | { kind: "release"; month: string };

/** What the centre can hold. The lenses and Setup are the older surfaces still on main. */
export type Route =
  | { kind: "today" }
  | PlaceRoute
  | { kind: "lens"; lens: Lens }
  | { kind: "setup" };

export type RouteKind = Route["kind"];
export type RouteOf<K extends RouteKind> = Extract<Route, { kind: K }>;

/** The Line sheet is not a route: it opens over the centre and closes back to it. */
export const LINE = { kind: "line" } as const;
export type Destination = Route | typeof LINE;
/** Over the centre, which is inert beneath it, or pinned beside a centre that stays live. */
export type SheetPresentation = "closed" | "overlay" | "pinned";

/**
 * The components the window can show. A route whose kind has no view is not listed in the
 * sidebar or Find, and its hash falls back like any unknown hash.
 */
export type Registry = {
  readonly views: { readonly [K in RouteKind]?: (route: RouteOf<K>) => ReactNode };
  readonly sheet?:
    | ((origin: Route, presentation: Exclude<SheetPresentation, "closed">) => ReactNode)
    | undefined;
  /** Drawn under the title bar on every route and beside either sheet; nothing when absent. */
  readonly strip?: (() => ReactNode) | undefined;
  /** Where an unknown or unregistered hash lands; it must be registered. */
  readonly fallback: Route;
};

const SERVICE_ID = /^[a-z0-9][a-z0-9-]*$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LENS_LABELS: Record<Lens, string> = {
  flow: "Flow",
  repositories: "Repositories",
  horizon: "Horizon",
};
const PLAIN = new Set<string>([
  "today",
  "upstream",
  "environment",
  "engineering-system",
  "releases",
  "security",
  "setup",
]);
/** Hashes from before the places, still parsed so saved locations keep working. */
const ALIASES: Record<string, Route> = { template: { kind: "engineering-system" } };

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

/** Reads a location hash (`#service/legal`, `release/2026-10`); undefined when it names no route. */
export function parseRoute(hash: string): Route | undefined {
  const path = hash.replace(/^#\/?/, "");
  const slash = path.indexOf("/");
  const head = slash < 0 ? path : path.slice(0, slash);
  const rest = slash < 0 ? undefined : decode(path.slice(slash + 1));
  if (Object.hasOwn(ALIASES, head)) return rest === undefined ? ALIASES[head] : undefined;
  if (PLAIN.has(head)) return rest === undefined ? ({ kind: head } as Route) : undefined;
  switch (head) {
    case "service":
      return rest !== undefined && SERVICE_ID.test(rest)
        ? { kind: "service", id: rest }
        : undefined;
    case "release":
      return rest !== undefined && MONTH.test(rest) ? { kind: "release", month: rest } : undefined;
    case "lens":
      return rest !== undefined && isLens(rest) ? { kind: "lens", lens: rest } : undefined;
    default:
      return undefined;
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

/** The place a route names, as the title bar, the sidebar and Find show it. */
export function routeLabel(route: Route): string {
  switch (route.kind) {
    case "today":
      return "Today";
    case "upstream":
      return "Upstream";
    case "environment":
      return "Environment";
    case "engineering-system":
      return "Engineering system";
    case "releases":
      return "Releases";
    case "security":
      return "Security";
    case "service":
      return route.id;
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

export function isReachable(route: Route, registry: Registry): boolean {
  return registry.views[route.kind] !== undefined;
}

/** The route a hash shows: unknown and unregistered hashes land on the registry's fallback. */
export function resolveRoute(hash: string, registry: Registry): Route {
  const route = parseRoute(hash);
  return route && isReachable(route, registry) ? route : registry.fallback;
}

export function renderRoute(route: Route, registry: Registry): ReactNode {
  const view = registry.views[route.kind] as ((route: Route) => ReactNode) | undefined;
  return view?.(route);
}

// The browser fires hashchange after the task that set the hash; the window re-renders at once.
const listeners = new Set<() => void>();
/** The hash beneath the open Line sheet; the sheet is open only while the hash still matches. */
let sheetOrigin: string | null = null;
const PINNED_KEY = "spi-code.line-sheet.pinned";
/** A pinned sheet survives navigation and, through local storage, a reload. */
let pinned = false;

function loadPinned() {
  try {
    pinned = window.localStorage.getItem(PINNED_KEY) === "1";
  } catch {}
}

function savePinned(value: boolean) {
  pinned = value;
  try {
    if (value) window.localStorage.setItem(PINNED_KEY, "1");
    else window.localStorage.removeItem(PINNED_KEY);
  } catch {}
}

function emit() {
  for (const listener of listeners) listener();
}

function onHashChange() {
  if (sheetOrigin !== null && sheetOrigin !== window.location.hash) sheetOrigin = null;
  emit();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    loadPinned();
    window.addEventListener("hashchange", onHashChange);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("hashchange", onHashChange);
  };
}

function readHash() {
  return window.location.hash;
}

function readPresentation(): SheetPresentation {
  if (pinned) return "pinned";
  return sheetOrigin !== null && sheetOrigin === window.location.hash ? "overlay" : "closed";
}

/** Opens the sheet over the centre; a pinned sheet stays pinned. */
export function openSheet() {
  if (readPresentation() !== "closed") return;
  sheetOrigin = window.location.hash;
  emit();
}

/** Pins the sheet beside the centre, which becomes live again. */
export function pinSheet() {
  if (pinned) return;
  sheetOrigin = null;
  savePinned(true);
  emit();
}

/** Unpinning closes the sheet. */
export function unpinSheet() {
  if (!pinned) return;
  savePinned(false);
  emit();
}

export function closeSheet() {
  if (sheetOrigin === null && !pinned) return;
  sheetOrigin = null;
  if (pinned) savePinned(false);
  emit();
}

/** Goes to a route, closing an overlaid Line sheet, or opens the sheet over the current route. */
export function navigate(destination: Destination) {
  if (destination.kind === "line") return openSheet();
  const hash = routeHash(destination);
  const wasOpen = sheetOrigin !== null;
  sheetOrigin = null;
  if (window.location.hash !== hash) window.location.hash = hash;
  else if (!wasOpen) return;
  emit();
}

const RegistryContext = createContext<Registry | undefined>(undefined);

export function RegistryProvider({
  registry,
  children,
}: {
  registry: Registry;
  children: ReactNode;
}) {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

export function useRegistryOr(fallback: Registry): Registry {
  return useContext(RegistryContext) ?? fallback;
}

export type Navigation = {
  route: Route;
  /** `route` stays mounted under an overlay and beside a pinned sheet. */
  sheet: SheetPresentation;
  navigate(destination: Destination): void;
  /** ⌘L: opens the overlay, or closes the sheet in either presentation. */
  toggleSheet(): void;
  pinSheet(): void;
  unpinSheet(): void;
  closeSheet(): void;
};

const LAST_PLACE_KEY = "spi-code.last-place";
/** The hash the window launched on, and whether the first snapshot has decided the landing. */
let launch: { hash: string; decided: boolean } | null = null;
/** The newest cursor this window acknowledged, so one cursor is sent once. */
let acknowledged = 0;

/** A new launch: the next mount restores the last place and decides the landing again. */
export function relaunch() {
  launch = null;
  acknowledged = 0;
}

/** A launch with no hash opens on the last place; a reload keeps its hash. */
function restoreLastPlace(registry: Registry) {
  if (launch) return;
  let hash = window.location.hash;
  if (hash === "") {
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(LAST_PLACE_KEY);
    } catch {}
    const route = saved === null ? undefined : parseRoute(saved);
    if (route && route.kind !== "setup" && isReachable(route, registry)) {
      hash = routeHash(route);
      window.history.replaceState(window.history.state, "", hash);
    }
  }
  launch = { hash, decided: false };
}

function saveLastPlace(route: Route) {
  if (route.kind === "setup") return;
  try {
    window.localStorage.setItem(LAST_PLACE_KEY, routeHash(route));
  } catch {}
}

function sendAcknowledge(cursor: number) {
  const parsed = parseMessage({
    version: PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    kind: "request",
    type: "view.acknowledge",
    payload: { cursor },
  });
  if (!parsed.ok) throw new Error("Invalid view.acknowledge");
  window.spi?.postMessage(parsed.message);
}

/**
 * Opens on Today when an Interrupt item arrived since the last acknowledgement, otherwise
 * on the last place, and acknowledges each snapshot Today shows in the foreground.
 */
function useLanding(route: Route, sheet: SheetPresentation, registry: Registry) {
  const snapshot = useStore(watchStore, (state) => state.snapshot);
  // The Watch gate holds Today's items while Watch is not ready, so nothing was seen.
  const watchShown = useStore(watchStore, (state) => !state.setup || state.setup.watchReady);

  useEffect(() => saveLastPlace(route), [route]);

  useEffect(() => {
    if (!snapshot || !launch || launch.decided) return;
    launch.decided = true;
    // A place the operator, or the setup landing, chose since launch is not overridden.
    if (window.location.hash !== launch.hash || !registry.views.today) return;
    // The host lists in `seen.since` the Interrupt items that arrived since the last acknowledgement.
    if (snapshot.body.seen.since.length > 0) navigate({ kind: "today" });
  }, [snapshot, registry]);

  useEffect(() => {
    if (!snapshot || !watchShown || route.kind !== "today" || sheet === "overlay") return;
    const { cursor } = snapshot;
    const check = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      if (cursor <= (snapshot.body.seen.cursor ?? 0) || cursor <= acknowledged) return;
      acknowledged = cursor;
      sendAcknowledge(cursor);
    };
    check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [snapshot, watchShown, route, sheet]);
}

/** The current route, kept in the location hash so a reload returns to the same place. */
export function useNavigation(registry: Registry): Navigation {
  restoreLastPlace(registry);
  const hash = useSyncExternalStore(subscribe, readHash, readHash);
  const presentation = useSyncExternalStore(subscribe, readPresentation, readPresentation);
  const route = useMemo(() => resolveRoute(hash, registry), [hash, registry]);
  const sheet = registry.sheet ? presentation : "closed";
  const toggleSheet = useCallback(() => {
    if (!registry.sheet) return;
    if (readPresentation() === "closed") openSheet();
    else closeSheet();
  }, [registry.sheet]);
  useLanding(route, sheet, registry);
  return { route, sheet, navigate, toggleSheet, pinSheet, unpinSheet, closeSheet };
}
