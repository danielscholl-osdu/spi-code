// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { type UIEvent, useLayoutEffect, useRef } from "react";
import { selectionStore } from "../panels/index.js";
import { routeSelectionIds } from "../panels/selection-rows.js";
import { type Route, routeHash } from "./routes.js";

/** Keeps the centre body's scroll position per route. */
export function useRouteScroll(route: Route, snapshot: ViewSnapshot | undefined) {
  const middle = useRef<HTMLDivElement>(null);
  const position = useRef({ route: routeHash(route), top: 0 });
  useLayoutEffect(() => {
    const frame = middle.current?.querySelector<HTMLElement>(
      ':scope > :not([role="alert"], .place-header, [role="status"], button)',
    );
    if (!frame) return;
    const key = routeHash(route);
    const top = selectionStore
      .getState()
      .visit(
        key,
        [
          ...(snapshot ? routeSelectionIds(snapshot, route) : []),
          ...Array.from(frame.querySelectorAll<HTMLElement>("[data-selection-id]")).flatMap(
            (element) => (element.dataset.selectionId ? [element.dataset.selectionId] : []),
          ),
        ],
        position.current.route === key ? frame.scrollTop : position.current.top,
      );
    frame.scrollTop = top;
    position.current = { route: key, top };
  }, [route, snapshot]);
  const onScrollCapture = (event: UIEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.parentElement === event.currentTarget)
      position.current.top = event.target.scrollTop;
  };
  return { middle, onScrollCapture };
}
