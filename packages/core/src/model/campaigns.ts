// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { plural } from "../util.js";
import type { Model } from "./index.js";
import type { RadarModel } from "./radar.js";
import { toolchainScopes } from "./toolchain.js";

export interface DetectedCampaign {
  id: string;
  kind: "toolchain" | "security";
  fact: string;
  forks: string[];
  possible?: string[];
}

function grouped(
  kind: DetectedCampaign["kind"],
  facts: readonly { fact: string; fork: string }[],
): DetectedCampaign[] {
  const members = new Map<string, Set<string>>();
  for (const { fact, fork } of facts) {
    const forks = members.get(fact) ?? new Set<string>();
    forks.add(fork);
    members.set(fact, forks);
  }
  return [...members]
    .filter(([, forks]) => forks.size >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fact, forks]) => ({
      id: `campaign:${kind}:${encodeURIComponent(fact)}`,
      kind,
      fact,
      forks: [...forks].sort(),
    }));
}

export function toolchainCampaigns(radar: RadarModel): DetectedCampaign[] {
  return toolchainScopes(radar)
    .filter((scope) => scope.certain.length + scope.possible.length >= 2)
    .sort((a, b) => a.value.localeCompare(b.value))
    .map((scope) => ({
      id: `campaign:toolchain:${encodeURIComponent(scope.value)}`,
      kind: "toolchain",
      fact: scope.value,
      forks: [...scope.certain, ...scope.possible].map(({ fork }) => fork).sort(),
      ...(scope.possible.length > 0 ? { possible: scope.possible.map(({ fork }) => fork).sort() } : {}),
    }));
}

export function detectCampaigns(
  model: Pick<Model, "radar" | "repositories">,
): DetectedCampaign[] {
  const security = model.repositories.rows
    .filter((row) => row.group === "fork")
    .flatMap((row) =>
      row.alerts
        .filter(
          (alert) =>
            alert.source === "code" && alert.owner !== "upstream" && alert.tool && alert.rule,
        )
        .map((alert) => ({ fact: `${alert.tool}: ${alert.rule}`, fork: row.name })),
    );
  return [...toolchainCampaigns(model.radar), ...grouped("security", security)];
}

export function campaignItemText(campaign: { fact: string; forks: readonly string[]; possible?: readonly string[] | undefined }): string {
  const possible = campaign.possible?.length ?? 0;
  return `Detected: ${campaign.fact} on ${plural(campaign.forks.length - possible, "fork")}${possible > 0 ? `; possible on ${plural(possible, "fork")}` : ""}`;
}
