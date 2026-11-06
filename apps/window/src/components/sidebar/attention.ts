// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { FocusItem, ViewSnapshot } from "@spi-code/contracts";
import { queueGroups, scopeRoute, treeServices } from "../../views/inbox/queue.js";

type SidebarAttention = {
  dot: "p0" | "p1" | "p2" | "unread" | undefined;
  word: string | undefined;
};

function inScope(item: FocusItem, id: string, services: readonly string[]): boolean {
  const route = scopeRoute(item.scope, services);
  if (id.startsWith("service:")) {
    const service = id.slice("service:".length);
    return (
      (route?.kind === "service" && route.id === service) ||
      (item.cls === "PORT" && item.ids.includes(`port:${service}`))
    );
  }
  return route?.kind === id || (id === "template" && item.cls === "ROLLOUT");
}

export function sidebarAttention(
  body: ViewSnapshot | undefined,
  previous: ReadonlyMap<string, SidebarAttention> = new Map(),
): Map<string, SidebarAttention> {
  if (!body) return new Map();
  const { briefing } = body;
  const services = treeServices(body.tree);
  const queue = queueGroups({ focus: [...briefing.focus, ...briefing.rest] }).flatMap(
    ({ entries }) => entries,
  );
  const facts = new Map([
    ["template", briefing.facts.find(({ label }) => label.startsWith("Template"))?.figure],
    ["environment", briefing.facts.find(({ label }) => label === "Environment")?.figure],
    ["releases", body.releases.lines[0]?.name],
  ]);
  return new Map(
    body.tree
      .filter(({ id }) => facts.has(id) || id.startsWith("service:"))
      .map(({ id, status }): [string, SidebarAttention] => {
        // A read failure is evidence, not a new priority.
        const retained = previous.get(id);
        if (status === "failed" && retained) return [id, retained];
        const item = queue.find(({ item }) => inScope(item, id, services))?.item;
        const dot = item ? (`p${item.rung}` as const) : status === "unread" ? "unread" : undefined;
        const word = facts.has(id)
          ? facts.get(id)
          : item
            ? item.cls === "BUILD"
              ? "build red"
              : item.cls.toLowerCase()
            : undefined;
        return [
          id,
          {
            dot,
            word: word === "·" ? undefined : (word ?? (dot === "unread" ? "unread" : undefined)),
          },
        ];
      }),
  );
}
