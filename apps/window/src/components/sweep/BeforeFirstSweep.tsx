// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress } from "@spi-code/contracts";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { type PlaceRoute, routeLabel } from "../../app/navigation.js";
import { PaneTitle } from "../../app/title-row.js";
import { watchStore } from "../../store/watch.js";
import "../place/place.css";

/** The sweep source a place waits on before it can open. */
const PLACE_SOURCES: Readonly<Record<PlaceRoute["kind"], string>> = {
  upstream: "upstream",
  environment: "lifecycle",
  "engineering-system": "template",
  releases: "releases",
  security: "security",
  service: "fleet",
  release: "releases",
};

export function ordinal(n: number): string {
  const ones = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** A place's one line before the first snapshot, with where its source falls in the sweep. */
export function placeLine(route: PlaceRoute, progress: SweepProgress | null): string {
  const label = routeLabel(route);
  const index = progress?.sources.findIndex(({ source }) => source === PLACE_SOURCES[route.kind]);
  return progress && index !== undefined && index >= 0
    ? `${label} opens after the first sweep. It is read ${ordinal(index + 1)} of ${progress.sources.length}.`
    : `${label} opens after the first sweep.`;
}

/** Holds a place to its header and one line until the first snapshot lands. */
export function BeforeFirstSweep({
  route,
  store = watchStore,
  children,
}: {
  route: PlaceRoute;
  store?: typeof watchStore;
  children: ReactNode;
}) {
  const waiting = useStore(store, (state) => state.snapshot === null);
  const progress = useStore(store, (state) => state.progress);
  if (!waiting) return children;
  return (
    <section className="place" aria-label={routeLabel(route)} data-before-sweep="">
      <PaneTitle>
        <h1 data-place>{routeLabel(route)}</h1>
      </PaneTitle>
      <p className="place-before-sweep">{placeLine(route, progress)}</p>
    </section>
  );
}
