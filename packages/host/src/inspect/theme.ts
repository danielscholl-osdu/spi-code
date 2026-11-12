// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type AreaEnvelope,
  type Briefing,
  type InspectResult,
  InspectResultSchema,
} from "@spi-code/contracts";
import { webUrl } from "./shared.js";

type Theme = Briefing["themes"][number];

const THEME_CLASS: Readonly<Record<Theme["kind"], InspectResult["class"]>> = {
  halt: "HALT",
  toolchain: "TOOLCHAIN",
  port: "PORT",
  rollout: "ROLLOUT",
  deadline: "GATE",
};

/** A Horizon theme and its queue item, told from the persisted briefing. */
export function themeResult(
  id: string,
  theme: Theme,
  areas: readonly AreaEnvelope[],
  item: Briefing["focus"][number] | undefined,
): InspectResult {
  const fork = (state: string) => (f: Theme["certain"][number]) => ({
    text: f.fork,
    state: `${state} · ${f.state}`,
    ...(f.inspect ? { inspect: f.inspect } : webUrl(f.url)),
  });
  return InspectResultSchema.parse({
    id,
    title: theme.title,
    class: THEME_CLASS[theme.kind],
    cause: theme.title,
    effect: theme.sub,
    next: theme.next,
    why: theme.when ?? "",
    evidence: [],
    related: [
      ...theme.certain.map(fork("certain")),
      ...theme.possible.map(fork("possible")),
      ...theme.exposed.map((name) => ({ text: name, state: "exposed" })),
      ...(item ? [{ text: item.title, state: item.cls, inspect: item.id }] : []),
    ],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}
