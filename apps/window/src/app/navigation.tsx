// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, parseMessage, type Station } from "@spi-code/contracts";
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
import {
  FORMING_RELEASES_ANCHOR,
  type ReleasesSection,
  SHARED_COMPONENTS_ANCHOR,
} from "../views/releases/anchors.js";

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
  | { kind: "releases"; section?: ReleasesSection }
  | { kind: "security" }
  | { kind: "service"; id: string }
  | { kind: "release"; month: string };

/** What Evidence was opened for: a Today item, or a Today line with each of its members. */
export type EvidenceSelection = { kind: "item" | "line"; id: string };

/** The page Evidence was opened from, and what was open there; with no selection, the whole sweep. */
export type EvidenceRoute = {
  kind: "evidence";
  from?: { kind: "today" } | PlaceRoute;
  selection?: EvidenceSelection;
};

/** What the centre can hold. */
export type Route = { kind: "today" } | PlaceRoute | EvidenceRoute;

export type RouteKind = Route["kind"];
export type RouteOf<K extends RouteKind> = Extract<Route, { kind: K }>;

/** The Line sheet is not a route: it opens over the centre and closes back to it. */
export const LINE = { kind: "line" } as const;
export type LineColumn = Exclude<Station["id"], "lane">;
export type LineSheetOptions = { readonly column?: LineColumn };
export type Destination = Route | (typeof LINE & LineSheetOptions);
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
  /** Drawn at the end of the sidebar footer on every route and beside either sheet. */
  readonly strip?: (() => ReactNode) | undefined;
  /** Where an unknown or unregistered hash lands; it must be registered. */
  readonly fallback: Route;
};

const SERVICE_ID = /^[a-z0-9][a-z0-9-]*$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PLAIN = new Set<string>([
  "today",
  "upstream",
  "environment",
  "engineering-system",
  "releases",
  "security",
]);
/** Hashes from before the places, still parsed so saved locations keep working. */
const ALIASES: Record<string, Route> = { template: { kind: "engineering-system" } };

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

const SELECTION = /^(item|line)~(.+)$/;

/** `#evidence?from=today&sel=item~gate2:storage`: a `from` that is not a page is dropped. */
function parseEvidence(query: string): EvidenceRoute {
  const params = new URLSearchParams(query);
  const from = parseRoute(params.get("from") ?? "");
  const selection = SELECTION.exec(params.get("sel") ?? "");
  return {
    kind: "evidence",
    ...(from && from.kind !== "evidence" ? { from } : {}),
    ...(selection?.[1] && selection[2]
      ? { selection: { kind: selection[1] as EvidenceSelection["kind"], id: selection[2] } }
      : {}),
  };
}

/** Reads a location hash (`#service/legal`, `release/2026-10`); undefined when it names no route. */
export function parseRoute(hash: string): Route | undefined {
  const path = hash.replace(/^#\/?/, "");
  if (path === "evidence" || path.startsWith("evidence?"))
    return parseEvidence(path.slice("evidence".length));
  const slash = path.indexOf("/");
  const head = slash < 0 ? path : path.slice(0, slash);
  const rest = slash < 0 ? undefined : decode(path.slice(slash + 1));
  if (Object.hasOwn(ALIASES, head)) return rest === undefined ? ALIASES[head] : undefined;
  if (
    head === "releases" &&
    (rest === FORMING_RELEASES_ANCHOR || rest === SHARED_COMPONENTS_ANCHOR)
  )
    return { kind: "releases", section: rest };
  if (PLAIN.has(head)) return rest === undefined ? ({ kind: head } as Route) : undefined;
  switch (head) {
    case "service":
      return rest !== undefined && SERVICE_ID.test(rest)
        ? { kind: "service", id: rest }
        : undefined;
    case "release":
      return rest !== undefined && MONTH.test(rest) ? { kind: "release", month: rest } : undefined;
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
    case "releases":
      return route.section ? `#releases/${route.section}` : "#releases";
    case "evidence": {
      const params = new URLSearchParams();
      if (route.from) params.set("from", routeHash(route.from).slice(1));
      if (route.selection) params.set("sel", `${route.selection.kind}~${route.selection.id}`);
      const query = params.toString();
      return query ? `#evidence?${query}` : "#evidence";
    }
    default:
      return `#${route.kind}`;
  }
}

/** The place a route names in the document title, sidebar and Find. */
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
    case "evidence":
      return "Evidence";
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
let sheetRequest: { id: number; column: LineColumn | undefined } = {
  id: 0,
  column: undefined,
};
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

function readSheetRequest() {
  return sheetRequest;
}

/** The latest explicit opening, so a sheet already on screen can reset its filters. */
export function useLineSheetRequest() {
  return useSyncExternalStore(subscribe, readSheetRequest, readSheetRequest);
}

/** Opens with fresh filters over the centre; a pinned sheet stays pinned. */
export function openSheet(options: LineSheetOptions = {}) {
  sheetRequest = { id: sheetRequest.id + 1, column: options.column };
  if (!pinned) sheetOrigin = window.location.hash;
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
  if (destination.kind === "line") return openSheet(destination);
  const hash = routeHash(destination);
  const wasOpen = sheetOrigin !== null;
  sheetOrigin = null;
  if (window.location.hash !== hash) window.location.hash = hash;
  else if (!wasOpen) return;
  emit();
}

/** What is open on a page (a Today row or a place's popover), by the hash it is open under. */
let opened: { hash: string; selection: EvidenceSelection } | null = null;

function readOpened() {
  return opened;
}

/** Called by a page when a row or popover opens or closes, so the Swept capsule follows it. */
export function setOpenSelection(selection: EvidenceSelection | null) {
  const next = selection ? { hash: window.location.hash, selection } : null;
  if (opened?.hash === next?.hash && opened?.selection === next?.selection) return;
  opened = next;
  emit();
}

/** What is open on the page showing now; null when nothing is. */
export function openSelection(): EvidenceSelection | null {
  return opened !== null && opened.hash === window.location.hash ? opened.selection : null;
}

/** What is open on the page showing now, for the page to reopen after Evidence closes. */
export function useOpenSelection(): EvidenceSelection | null {
  const current = useSyncExternalStore(subscribe, readOpened, readOpened);
  const hash = useSyncExternalStore(subscribe, readHash, readHash);
  return current !== null && current.hash === hash ? current.selection : null;
}

/**
 * Opens Evidence for a selection, or for what is open on the current page, or the whole sweep
 * when nothing is. From Evidence itself it keeps the page Evidence was opened from.
 */
export function openEvidence(selection: EvidenceSelection | null = openSelection()) {
  const current = parseRoute(window.location.hash);
  const from = current?.kind === "evidence" ? current.from : current;
  navigate({
    kind: "evidence",
    ...(from ? { from } : {}),
    ...(selection ? { selection } : {}),
  });
}

/** Back to the page Evidence came from, with its selection open again. */
export function leaveEvidence(route: EvidenceRoute) {
  const back = route.from ?? { kind: "today" };
  navigate(back);
  if (route.selection) {
    opened = { hash: routeHash(back), selection: route.selection };
    emit();
  }
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
/** The newest cursor Today showed in the foreground, acknowledged when the operator looks away. */
let shown = 0;

/** A new launch: the next mount restores the last place and decides the landing again. */
export function relaunch() {
  launch = null;
  acknowledged = 0;
  shown = 0;
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
    if (route && isReachable(route, registry)) {
      hash = routeHash(route);
      window.history.replaceState(window.history.state, "", hash);
    }
  }
  launch = { hash, decided: false };
}

function saveLastPlace(route: Route) {
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

function acknowledgeShown() {
  if (shown <= acknowledged) return;
  acknowledged = shown;
  sendAcknowledge(shown);
}

/** The ping id that tells desktop main the acknowledgement is through; its leave.ts holds the same. */
const LEAVE_ID = "window-leave";

/** The app is going away: acknowledge what Today showed, then ping so the host's pong confirms it. */
function leave() {
  acknowledgeShown();
  const parsed = parseMessage({
    version: PROTOCOL_VERSION,
    id: LEAVE_ID,
    kind: "request",
    type: "ping",
    payload: {},
  });
  if (!parsed.ok) throw new Error("Invalid leave ping");
  window.spi?.postMessage(parsed.message);
}

/**
 * Opens on Today when an Interrupt item arrived since the last acknowledgement, otherwise
 * on the last place. The baseline holds while Today stays in the foreground: the newest
 * snapshot it showed is acknowledged when the operator leaves Today, the window goes to the
 * background or reloads, or the app quits.
 */
function useLanding(route: Route, sheet: SheetPresentation, registry: Registry) {
  const snapshot = useStore(watchStore, (state) => state.snapshot);
  // The Watch gate holds Today's items while Watch is not ready, so nothing was seen.
  const watchShown = useStore(watchStore, (state) => !state.setup || state.setup.watchReady);

  useEffect(() => saveLastPlace(route), [route]);

  useEffect(() => {
    if (!snapshot || !launch || launch.decided) return;
    launch.decided = true;
    // A place the operator chose since launch is not overridden.
    if (window.location.hash !== launch.hash || !registry.views.today) return;
    // The host lists in `seen.since` the Interrupt items that arrived since the last acknowledgement.
    if (snapshot.body.seen.since.length > 0) navigate({ kind: "today" });
  }, [snapshot, registry]);

  useEffect(() => {
    if (!snapshot || !watchShown || route.kind !== "today" || sheet === "overlay") return;
    const { cursor } = snapshot;
    const mark = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      if (cursor <= (snapshot.body.seen.cursor ?? 0)) return;
      shown = Math.max(shown, cursor);
    };
    mark();
    window.addEventListener("focus", mark);
    document.addEventListener("visibilitychange", mark);
    return () => {
      window.removeEventListener("focus", mark);
      document.removeEventListener("visibilitychange", mark);
    };
  }, [snapshot, watchShown, route, sheet]);

  useEffect(() => window.spi?.onLeave?.(leave), []);

  const onToday = route.kind === "today";
  useEffect(() => {
    if (!onToday) return;
    const hidden = () => {
      if (document.visibilityState !== "visible") acknowledgeShown();
    };
    window.addEventListener("blur", acknowledgeShown);
    window.addEventListener("pagehide", acknowledgeShown);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", acknowledgeShown);
      window.removeEventListener("pagehide", acknowledgeShown);
      document.removeEventListener("visibilitychange", hidden);
      acknowledgeShown();
    };
  }, [onToday]);
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
