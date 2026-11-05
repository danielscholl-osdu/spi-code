// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PermissionHandler, SessionConfig } from "@github/copilot-sdk";

// Ported from Keelson's permission-gate.ts without its built-in allow/pass-through paths.
export function buildSessionToolFilter(
  projectedCustomToolNames: readonly string[],
): Pick<SessionConfig, "availableTools"> & { availableTools: string[] } {
  return { availableTools: projectedCustomToolNames.map((name) => `custom:${name}`) };
}

export function buildPermissionGate(): PermissionHandler {
  return () => ({
    kind: "reject",
    feedback: "SPI Code refuses every runtime permission request; use a gated SPI tool.",
  });
}
