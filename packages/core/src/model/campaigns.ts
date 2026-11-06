// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { plural } from "../util.js";
import type { Model } from "./index.js";
import type { UpstreamModel } from "./upstream.js";

export interface DetectedCampaign {
  id: string;
  kind: "toolchain" | "security";
  fact: string;
  forks: string[];
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

export function toolchainCampaigns(
  upstream: Pick<UpstreamModel, "moves" | "held">,
): DetectedCampaign[] {
  const held = new Set(upstream.held.map((fork) => fork.service));
  return grouped(
    "toolchain",
    upstream.moves.flatMap(({ value, forks }) =>
      forks.filter((fork) => !held.has(fork)).map((fork) => ({ fact: value, fork })),
    ),
  );
}

export function detectCampaigns(
  model: Pick<Model, "upstream" | "repositories">,
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
  return [...toolchainCampaigns(model.upstream), ...grouped("security", security)];
}

export function campaignItemText(campaign: DetectedCampaign): string {
  return `Detected: ${campaign.fact} on ${plural(campaign.forks.length, "fork")}`;
}
