// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import type { Briefing } from "@spi-code/contracts";
import { treeServices } from "../app/queue.js";
import {
  DEFAULT_REGISTRY,
  isReachable,
  PLACES,
  type Registry,
  type Route,
  routeLabel,
} from "../app/routes.js";
import { plainTitle } from "../text.js";
import { foldSearchQuery, rankSearchGroups, scoreSearchTerms } from "./search.js";

export type PaletteTarget =
  | { kind: "route"; route: Route }
  | { kind: "queue"; id: string }
  | { kind: "settings" };

export type PaletteItem = {
  value: string;
  label: string;
  /** The muted text at the row's right edge. */
  kind: string;
  /** Extra words the query may match besides the label. */
  keywords: readonly string[];
  priority?: 0 | 1 | 2;
  target: PaletteTarget;
};

export type PaletteGroup = {
  value: "go-to" | "services" | "queue";
  label: string;
  items: PaletteItem[];
};

const GO_TO: readonly Route[] = [{ kind: "today" }, ...PLACES];
/** Settings is a dialog, not a place: Find opens it on Readiness, where Setup now lives. */
const SETTINGS: PaletteItem = {
  value: "settings",
  label: "Settings",
  kind: "Readiness",
  keywords: ["Setup", "Appearance"],
  target: { kind: "settings" },
};

type SnapshotBody = {
  briefing: Pick<Briefing, "focus" | "rest">;
  tree?: readonly { id: string }[] | undefined;
};

function routeItem(route: Route, kind: string, keywords: readonly string[] = []): PaletteItem {
  const label = routeLabel(route);
  const id = route.kind === "service" ? route.id : "";
  return {
    value: `route:${route.kind}${id ? `:${id}` : ""}`,
    label,
    kind,
    keywords,
    target: { kind: "route", route },
  };
}

/**
 * Go to, Services and Queue, from the registered routes and the snapshot; empty groups and
 * routes with no registered view are left out.
 */
export function buildPaletteGroups(
  body: SnapshotBody | undefined,
  registry: Registry = DEFAULT_REGISTRY,
): PaletteGroup[] {
  const reachable = (route: Route) => isReachable(route, registry);
  const services = treeServices(body?.tree)
    .map((id): Route => ({ kind: "service", id }))
    .filter(reachable)
    .map((route) => routeItem(route, "service"));
  const queue = [...(body?.briefing.focus ?? []), ...(body?.briefing.rest ?? [])].map(
    (item): PaletteItem => ({
      value: `queue:${item.id}`,
      label: `${item.scope} · ${plainTitle(item.title)}`,
      kind: `P${item.rung}`,
      keywords: [item.cls],
      priority: item.rung,
      target: { kind: "queue", id: item.id },
    }),
  );
  const groups: PaletteGroup[] = [
    {
      value: "go-to",
      label: "Go to",
      items: [...GO_TO.filter(reachable).map((route) => routeItem(route, "page")), SETTINGS],
    },
    { value: "services", label: "Services", items: services },
    { value: "queue", label: "Queue", items: queue },
  ];
  return groups.filter(({ items }) => items.length > 0);
}

/** The groups whose rows match every word of the query, best matches first. */
export function filterPaletteGroups(
  groups: readonly PaletteGroup[],
  query: string,
): PaletteGroup[] {
  const normalized = foldSearchQuery(query);
  if (normalized.length === 0) return [...groups];
  return rankSearchGroups(
    groups.map((group) => ({ group, items: group.items })),
    (item) => scoreSearchTerms(normalized, [item.label, item.kind, ...item.keywords]),
  ).map(({ group, items }) => ({ ...group, items: [...items] }));
}
