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

import type { Briefing, CanWaitCause, CanWaitCauses, ViewSnapshot } from "@spi-code/contracts";
import { treeServices } from "../app/queue.js";
import {
  DEFAULT_REGISTRY,
  isReachable,
  PLACES,
  type Registry,
  type Route,
  routeLabel,
} from "../app/routes.js";
import { pinOf } from "../store/pins.js";
import { plainTitle } from "../text.js";
import { TABS } from "../views/service/tabs.js";
import { forksWord } from "../views/today/fleet.js";
import { foldSearchQuery, rankSearchGroups, scoreSearchTerms } from "./search.js";

export type PaletteTarget =
  | { kind: "route"; route: Route }
  | { kind: "line"; id: string }
  | { kind: "cause"; id: string }
  | { kind: "settings" };

export type PaletteItem = {
  value: string;
  label: string;
  /** The muted text at the row's right edge. */
  kind: string;
  /** Extra words the query may match besides the label. */
  keywords: readonly string[];
  external?: string;
  count?: number | null;
  children?: PaletteGroup;
  target: PaletteTarget;
  /** What ⌘↩ pins besides opening it; Today, Settings and Today's rows pin nothing. */
  pin?: string;
};

export type PaletteGroup = {
  value: "go-to" | "services" | "blocked" | "waiting" | "can-wait" | `on:${string}`;
  label: string;
  items: PaletteItem[];
};

const TODAY: Route = { kind: "today" };
/** Settings is a dialog, not a place: Find opens it on Readiness, where Setup now lives. */
const SETTINGS: PaletteItem = {
  value: "settings",
  label: "Settings",
  kind: "Readiness",
  keywords: ["Setup", "Appearance"],
  target: { kind: "settings" },
};

type SnapshotBody = {
  briefing: Pick<Briefing, "lines" | "today">;
  tree?: readonly { id: string }[] | undefined;
};

function routeItem(route: Route, kind: string, keywords: readonly string[] = []): PaletteItem {
  const label = routeLabel(route);
  const id = route.kind === "service" ? route.id : "";
  const pin = pinOf(route);
  return {
    value: `route:${route.kind}${id ? `:${id}` : ""}`,
    label,
    kind,
    keywords,
    target: { kind: "route", route },
    ...(pin ? { pin } : {}),
  };
}

function serviceChildren(body: ViewSnapshot, id: string): PaletteGroup | undefined {
  const service = body.services?.find((entry) => entry.service === id);
  if (!service?.home) return undefined;
  const items: PaletteItem[] = [];
  for (const [tab, label, rows] of [
    ["pulls", "PR", service.work?.pulls.rows.filter(({ state }) => state === "open")],
    [
      "issues",
      "Issue",
      service.work?.issues.rows.filter(({ state, tracks }) => state === "open" && !tracks),
    ],
  ] as const) {
    for (const row of rows ?? []) {
      items.push({
        value: `on:${id}:${tab}:${row.number}`,
        label: `${label} #${row.number} · ${row.title}`,
        kind: "",
        keywords: [id],
        external: row.url,
        target: { kind: "route", route: { kind: "service", id, tab, row: String(row.number) } },
      });
    }
  }
  for (const tab of TABS) {
    if (!tab.count) continue;
    items.push({
      value: `on:${id}:${tab.id}`,
      label: tab.label,
      kind: "",
      keywords: [id],
      count: tab.count({ id, home: service.home, snapshot: body }),
      target: { kind: "route", route: { kind: "service", id, tab: tab.id } },
    });
  }
  return { value: `on:${id}`, label: `On ${id}`, items };
}

const NO_GAPS: CanWaitCauses["notRead"] = {
  release: [],
  dependabot: [],
  other: [],
  issue: [],
  alert: [],
};

/** What Today's Can wait row names in its fork column. */
function causeSubject(cause: CanWaitCause, notRead: CanWaitCauses["notRead"]): string {
  const forks = cause.forks.filter(({ group, notRead }) => group === "fork" && !notRead);
  const [one] = forks;
  if (forks.length === 1 && one) return one.fork;
  if (cause.forks.length > 0 && cause.forks.every(({ group }) => group === "program"))
    return cause.forks.length === 1
      ? (cause.forks[0]?.fork ?? "")
      : `${cause.forks.length} repositories`;
  const gap =
    notRead[cause.kind].length > 0 ||
    cause.forks.some(({ group }) => group === undefined || group === "unknown");
  return forks.length || !gap ? forksWord(forks.length) : "Not read";
}

/** Today's Blocked, Waiting on you and Can wait rows, in Today's order and words. */
function todayGroups(briefing: SnapshotBody["briefing"] | undefined): PaletteGroup[] {
  const lines = briefing?.lines ?? [];
  const sections = [
    { value: "blocked", label: "Blocked" },
    { value: "waiting", label: "Waiting on you" },
  ] as const;
  const groups: PaletteGroup[] = sections.map(({ value, label }) => ({
    value,
    label,
    items: lines
      .filter(({ section }) => section === value)
      .map((line) => ({
        value: `line:${line.id}`,
        label: `${line.subject} · ${plainTitle(line.headline)}`,
        kind: "",
        keywords: [...new Set(line.members.map(({ fork }) => fork))],
        target: { kind: "line", id: line.id },
      })),
  }));
  const causes = briefing?.today?.causes;
  groups.push({
    value: "can-wait",
    label: "Can wait",
    items: (causes?.rows ?? []).map((cause) => ({
      value: `cause:${cause.id}`,
      label: `${causeSubject(cause, causes?.notRead ?? NO_GAPS)} · ${plainTitle(cause.headline)}`,
      kind: "",
      keywords: cause.forks.map(({ fork }) => fork),
      target: { kind: "cause", id: cause.id },
    })),
  });
  return groups;
}

/**
 * Go to, Services, then Today's Blocked, Waiting on you and Can wait, from the registered routes
 * and the snapshot; empty groups and routes with no registered view are left out.
 */
export function buildPaletteGroups(
  body: ViewSnapshot | SnapshotBody | undefined,
  registry: Registry = DEFAULT_REGISTRY,
): PaletteGroup[] {
  const reachable = (route: Route) => isReachable(route, registry);
  const services = treeServices(body?.tree)
    .map((id) => ({ kind: "service", id }) as const)
    .filter(reachable)
    .map((route) => {
      const item = routeItem(route, "service");
      const children = body && "sweptAt" in body ? serviceChildren(body, route.id) : undefined;
      return children ? { ...item, children } : item;
    });
  const groups: PaletteGroup[] = [
    {
      value: "go-to",
      label: "Go to",
      items: [
        ...(reachable(TODAY) ? [routeItem(TODAY, "page")] : []),
        ...PLACES.filter(reachable).map((route) => routeItem(route, "page")),
        SETTINGS,
      ],
    },
    { value: "services", label: "Services", items: services },
    ...(reachable(TODAY) ? todayGroups(body?.briefing) : []),
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
  const score = (item: PaletteItem) => {
    if (item.external && /^#\d+$/.test(normalized) && !item.label.includes(` ${normalized} ·`))
      return null;
    return scoreSearchTerms(normalized, [item.label, item.kind, ...item.keywords]);
  };
  const ranked = rankSearchGroups(
    groups.map((group) => ({ group, items: group.items })),
    score,
  );
  const children = (groups.find(({ value }) => value === "services")?.items ?? []).flatMap(
    (item) => {
      const group = item.children;
      if (!group) return [];
      const rows = score(item) ? group.items : group.items.filter(score);
      return rows.length ? [{ ...group, items: rows }] : [];
    },
  );
  const results = ranked.map(({ group, items }) => ({ ...group, items: [...items] }));
  const services = results.findIndex(({ value }) => value === "services");
  const exact = foldSearchQuery(results[0]?.items[0]?.label ?? "") === normalized;
  results.splice(services < 0 && exact ? 1 : services + 1, 0, ...children);
  return results;
}
