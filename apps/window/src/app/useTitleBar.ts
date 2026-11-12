// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect, useLayoutEffect, useRef } from "react";
import { type Route, routeLabel } from "./routes.js";

/** Names the window after the route and publishes the top row's height as `--topbar-height`. */
export function useTitleBar(route: Route) {
  const titleBar = useRef<HTMLElement>(null);
  useEffect(() => {
    document.title = `SPI Code · ${routeLabel(route)}`;
  }, [route]);
  useLayoutEffect(() => {
    const title = titleBar.current;
    const shell = title?.parentElement;
    if (!title || !shell) return;
    const measure = () => {
      shell.style.setProperty("--topbar-height", `${title.getBoundingClientRect().height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(title, { box: "border-box" });
    return () => observer.disconnect();
  }, []);
  return titleBar;
}
