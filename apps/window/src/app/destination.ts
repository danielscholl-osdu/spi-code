// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { IdentifierSchema } from "@spi-code/contracts";
import { openFreshness } from "../components/sweep/reveal.js";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { navigate } from "./navigation.js";

/** The closed set of places desktop main can send the window to, as preload.cjs passes them. */
export type WindowDestination = { to: "evidence" } | { to: "today"; item: string };

export function parseDestination(input: unknown): WindowDestination | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const keys = Object.keys(input);
  if (
    keys.length === 2 &&
    keys.includes("to") &&
    keys.includes("item") &&
    "to" in input &&
    input.to === "today" &&
    "item" in input
  ) {
    const item = IdentifierSchema.max(256).safeParse(input.item);
    if (
      item.success &&
      item.data.trim().length > 0 &&
      !["__proto__", "constructor", "prototype"].includes(item.data) &&
      !/(?:^|[:/\\])\.\.(?:[/\\]|$)/.test(item.data) &&
      !/^(?:[./~\\]|[a-z]:\/|(?:https?|file|data|javascript|vbscript|mailto):)|\\|:\/\/|[\p{Cc}\u2028\u2029]/iu.test(
        item.data,
      ) &&
      (!item.data.includes("/") || /^[a-z][a-z0-9-]*:/i.test(item.data))
    )
      return { to: "today", item: item.data };
    return undefined;
  }
  if (keys.length !== 1 || keys[0] !== "to") return undefined;
  return (input as { to: unknown }).to === "evidence" ? { to: "evidence" } : undefined;
}

/** Native tray and notification clicks use the same validated route as the preload. */
export function openDestination(input: unknown) {
  const destination = parseDestination(input);
  if (destination?.to === "evidence") openFreshness(watchStore.getState().snapshot);
  else if (destination?.to === "today") {
    navigate({ kind: "today" });
    selectionStore.getState().select(destination.item);
  }
}
