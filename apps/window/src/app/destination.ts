// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { openFreshness } from "../components/sweep/reveal.js";
import { watchStore } from "../store/watch.js";

/** The closed set of places desktop main can send the window to, as preload.cjs passes them. */
export type WindowDestination = { to: "evidence" };

export function parseDestination(input: unknown): WindowDestination | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "to") return undefined;
  return (input as { to: unknown }).to === "evidence" ? { to: "evidence" } : undefined;
}

/** The tray's View sweep: the sweep's Evidence, or the first sweep's list before any snapshot. */
export function openDestination(input: unknown) {
  const destination = parseDestination(input);
  if (destination?.to === "evidence") openFreshness(watchStore.getState().snapshot);
}
