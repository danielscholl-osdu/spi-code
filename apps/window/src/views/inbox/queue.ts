// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Briefing, FocusItem } from "@spi-code/contracts";
import type { Route } from "../../app/routes.js";

export type QueueEntry = { item: FocusItem; pointer: string };
export type QueueGroup = { rung: FocusItem["rung"]; label: string; entries: QueueEntry[] };

const GROUPS = [
  { rung: 0, label: "Now" },
  { rung: 1, label: "Next" },
  { rung: 2, label: "Later" },
] as const;

const SERVICE_PREFIX = "service:";

/** The briefing's focus in Now (P0), Next (P1) and Later (P2), in briefing order; empty groups are left out. */
export function queueGroups(briefing: Pick<Briefing, "focus">): QueueGroup[] {
  const entries = briefing.focus.map((item, index) => ({
    item,
    pointer: `/briefing/focus/${index}`,
  }));
  return GROUPS.map(({ rung, label }) => ({
    rung,
    label,
    entries: entries.filter(({ item }) => item.rung === rung),
  })).filter(({ entries }) => entries.length > 0);
}

/**
 * The Inbox's one combined total (AU-09): every P0 and P1 item the briefing carries, folded or
 * not, plus pending cards, of which there are none until approvals exist.
 */
export function inboxCount(briefing: Pick<Briefing, "focus" | "rest">): number {
  return [...briefing.focus, ...briefing.rest].filter(({ rung }) => rung <= 1).length;
}

/** The services a sweep's tree names, in its order. */
export function treeServices(tree: readonly { id: string }[] | undefined): string[] {
  return (tree ?? [])
    .filter(({ id }) => id.startsWith(SERVICE_PREFIX))
    .map(({ id }) => id.slice(SERVICE_PREFIX.length));
}

/**
 * The thing's page a queue item's scope names. The fleet, a list of forks or a repository that is
 * not a thing has no page.
 */
export function scopeRoute(scope: string, services: readonly string[]): Route | undefined {
  if (scope === "Environment" || scope === "osdu-spi-stack") return { kind: "environment" };
  if (scope === "osdu-spi") return { kind: "template" };
  if (services.includes(scope)) return { kind: "service", id: scope };
  return undefined;
}
