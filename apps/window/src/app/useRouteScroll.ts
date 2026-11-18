// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { type UIEvent, useLayoutEffect, useRef } from "react";
import { type Route, routeHash } from "./routes.js";

/** A service page keeps one position per tab, whichever row is open on it. */
const scrollKey = (route: Route) =>
  routeHash(
    route.kind === "service"
      ? { kind: "service", id: route.id, ...(route.tab ? { tab: route.tab } : {}) }
      : route,
  );

/** Keeps the centre body's scroll position per route. */
export function useRouteScroll(route: Route, snapshot: ViewSnapshot | undefined) {
  const middle = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const position = useRef({ route: scrollKey(route), top: 0 });
  useLayoutEffect(() => {
    if (!snapshot) return;
    const frame = middle.current?.querySelector<HTMLElement>(
      ':scope > :not([role="alert"], .place-header, [role="status"], button)',
    );
    if (!frame) return;
    const key = scrollKey(route);
    if (position.current.route !== key)
      positions.current.set(position.current.route, position.current.top);
    const top =
      position.current.route === key ? frame.scrollTop : (positions.current.get(key) ?? 0);
    frame.scrollTop = top;
    position.current = { route: key, top };
  }, [route, snapshot]);
  const onScrollCapture = (event: UIEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.parentElement === event.currentTarget)
      position.current.top = event.target.scrollTop;
  };
  return { middle, onScrollCapture };
}
