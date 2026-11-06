// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { FocusItem, ViewSnapshot } from "@spi-code/contracts";
import { useState } from "react";
import { queueGroups, scopeRoute, treeServices } from "../../views/inbox/queue.js";

export type SidebarAttention = {
  dot: "p0" | "p1" | "p2" | "unread" | undefined;
  word: string | undefined;
};

export function useSidebarAttention(body: ViewSnapshot | undefined): Map<string, SidebarAttention> {
  const [attention, setAttention] = useState(() => ({ body, rows: sidebarAttention(body) }));
  if (attention.body !== body) {
    const rows = sidebarAttention(body, attention.rows);
    setAttention({ body, rows });
    return rows;
  }
  return attention.rows;
}

const CLASS_WORDS: Record<FocusItem["cls"], string> = {
  ENV: "environment",
  ACCESS: "access",
  TEST: "tests red",
  HALT: "halt",
  TOOLCHAIN: "toolchain",
  CONFLICT: "conflict",
  POLICY: "policy",
  INFRA: "infra",
  BUILD: "build red",
  UNREAD: "unread",
  PORT: "port",
  SECURITY: "security",
  ROLLOUT: "rollout",
  INCIDENT: "incident",
  GATE: "gate",
  READY: "ready",
};

export function inScope(item: FocusItem, id: string, services: readonly string[]): boolean {
  const route = scopeRoute(item.scope, services);
  if (id.startsWith("service:")) {
    const service = id.slice("service:".length);
    return (
      (route?.kind === "service" && route.id === service) ||
      (item.cls === "PORT" && item.ids.includes(`port:${service}`))
    );
  }
  if (id === "template") return route?.kind === "engineering-system" || item.cls === "ROLLOUT";
  return route?.kind === id;
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
        const tag = briefing.flow.rows.find(({ fork }) => id === `service:${fork}`)?.tag.trim();
        const word = facts.has(id)
          ? facts.get(id)
          : item
            ? CLASS_WORDS[item.cls]
            : tag && tag !== "·"
              ? tag
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
