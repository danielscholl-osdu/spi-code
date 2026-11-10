// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RadarModel, Verdict } from "./radar.js";

export interface ToolchainScope {
  value: string;
  certain: { fork: string; verdict: Verdict }[];
  possible: { fork: string; verdict: Verdict }[];
}

export function toolchainScopes(radar: RadarModel): ToolchainScope[] {
  const scopes = new Map<string, ToolchainScope>();
  for (const [fork, service] of Object.entries(radar.services)) {
    for (const certainty of ["certain", "possible"] as const) {
      for (const verdict of service[certainty]) {
        if (verdict.bucket !== "Toolchain" || !verdict.value) continue;
        const scope = scopes.get(verdict.value) ?? { value: verdict.value, certain: [], possible: [] };
        if (!scope[certainty].some((member) => member.fork === fork)) {
          scope[certainty].push({ fork, verdict });
        }
        scopes.set(verdict.value, scope);
      }
    }
  }
  return [...scopes.values()].map((scope) => ({
    ...scope,
    possible: scope.possible.filter((member) => !scope.certain.some((certain) => certain.fork === member.fork)),
  }));
}
