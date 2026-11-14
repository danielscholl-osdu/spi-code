// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import { type Route, routeLabel } from "./routes.js";

/** Names the window after the route. */
export function useDocumentTitle(route: Route) {
  useEffect(() => {
    document.title = `SPI Code · ${routeLabel(route)}`;
  }, [route]);
}
