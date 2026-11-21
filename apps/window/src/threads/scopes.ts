// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Route } from "../app/navigation.js";
import { treeServices } from "../app/queue.js";
import type { IconName } from "../components/icons/Icon.js";

export const PROGRAM = "program";

/** The scopes that are a place rather than a fork, in sidebar order, with the place they read. */
export const PLACE_SCOPES = [
  { id: "environment", label: "Environment", icon: "server", route: { kind: "environment" } },
  { id: "template", label: "Template", icon: "layers", route: { kind: "engineering-system" } },
] as const satisfies readonly { id: string; label: string; icon: IconName; route: Route }[];

const place = (scope: string) => PLACE_SCOPES.find(({ id }) => id === scope);

export const scopeLabel = (scope: string): string =>
  scope === PROGRAM ? "Program" : (place(scope)?.label ?? scope);

export const scopeIcon = (scope: string): IconName =>
  scope === PROGRAM ? "sun" : (place(scope)?.icon ?? "box");

/** Whether a thread can start in the scope: a fork the sweep lists, a place scope or the program. */
export function canStartIn(scope: string, tree: readonly { id: string }[] | undefined): boolean {
  return scope === PROGRAM || place(scope) !== undefined || treeServices(tree).includes(scope);
}

/** Find's ask scope for a page: the open service, Template or Environment; otherwise Program. */
export function scopeOfRoute(route: Route | undefined): string {
  if (route?.kind === "service") return route.id;
  return PLACE_SCOPES.find((entry) => entry.route.kind === route?.kind)?.id ?? PROGRAM;
}
