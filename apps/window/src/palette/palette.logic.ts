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

import type { Briefing, ViewSnapshot } from "@spi-code/contracts";
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
import { scopeLabel } from "../threads/scopes.js";
import type { ThreadSummary } from "../threads/store.js";
import { TABS } from "../views/service/tabs.js";
import { causeReading } from "../views/today/CanWait.js";
import { drawnCauses } from "../views/today/Table.js";
import { foldSearchQuery, rankSearchGroups, scoreSearchTerms } from "./search.js";

export type PaletteTarget =
  | { kind: "route"; route: Route }
  | { kind: "line"; id: string }
  | { kind: "cause"; id: string }
  | { kind: "ask"; text: string }
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
  value:
    | "go-to"
    | "services"
    | "threads"
    | "blocked"
    | "waiting"
    | "can-wait"
    | "ask"
    | `on:${string}`;
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

function serviceChildren(
  body: ViewSnapshot,
  id: string,
  threads: readonly ThreadSummary[] | null,
): PaletteGroup | undefined {
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
      count: tab.count({ id, home: service.home, snapshot: body, threads }),
      target: { kind: "route", route: { kind: "service", id, tab: tab.id } },
    });
  }
  return { value: `on:${id}`, label: `On ${id}`, items };
}

/** Every thread the host lists, by title, with its scope muted at the right. */
function threadGroup(threads: readonly ThreadSummary[]): PaletteGroup {
  return {
    value: "threads",
    label: "Threads",
    items: threads
      .filter(({ status }) => status !== "Can't be read")
      .map(({ id, thread, status }) => ({
        value: `thread:${id}`,
        label: thread.title ?? "Untitled thread",
        kind: scopeLabel(thread.scope),
        keywords: [status],
        target: { kind: "route", route: { kind: "thread", id } },
      })),
  };
}

/** The row ↵ on a sentence asks Copilot with: a draft holding it, in the scope ⌘N would pick. */
export function askGroup(query: string, scope: string): PaletteGroup | undefined {
  const text = query.trim();
  if (!text) return undefined;
  return {
    value: "ask",
    label: "Ask",
    items: [
      {
        value: "ask",
        label: "Ask Copilot",
        kind: scopeLabel(scope),
        keywords: [],
        target: { kind: "ask", text },
      },
    ],
  };
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
  const causes = briefing && drawnCauses(briefing);
  groups.push({
    value: "can-wait",
    label: "Can wait",
    items: (causes?.rows ?? []).map((cause) => ({
      value: `cause:${cause.id}`,
      label: `${causeReading(cause, causes?.notRead[cause.kind] ?? []).subject} · ${plainTitle(cause.headline)}`,
      kind: "",
      keywords: cause.forks.map(({ fork }) => fork),
      target: { kind: "cause", id: cause.id },
    })),
  });
  return groups;
}

/**
 * Go to, Services, Threads, then Today's Blocked, Waiting on you and Can wait, from the registered
 * routes, the snapshot and the host's threads; empty groups and routes with no registered view are
 * left out.
 */
export function buildPaletteGroups(
  body: ViewSnapshot | SnapshotBody | undefined,
  registry: Registry = DEFAULT_REGISTRY,
  threads: readonly ThreadSummary[] | null = null,
): PaletteGroup[] {
  const reachable = (route: Route) => isReachable(route, registry);
  const services = treeServices(body?.tree)
    .map((id) => ({ kind: "service", id }) as const)
    .filter(reachable)
    .map((route) => {
      const item = routeItem(route, "service");
      const children =
        body && "sweptAt" in body ? serviceChildren(body, route.id, threads) : undefined;
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
    ...(reachable({ kind: "thread", id: "new" }) ? [threadGroup(threads ?? [])] : []),
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
