// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export interface EnvironmentPaths {
  readonly factsFile?: string;
  readonly servicesFile?: string;
  readonly rolloutFile?: string;
  readonly lanesOverride?: number;
}

export function environmentFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EnvironmentPaths {
  const lanes = Number(env.RIB_SPI_LANES);
  return Object.freeze({
    factsFile: env.RIB_SPI_FACTS_FILE || undefined,
    servicesFile: env.RIB_SPI_SERVICES_FILE || undefined,
    rolloutFile: env.RIB_SPI_ROLLOUT_FILE || undefined,
    lanesOverride: Number.isInteger(lanes) && lanes > 0 ? lanes : undefined,
  });
}
