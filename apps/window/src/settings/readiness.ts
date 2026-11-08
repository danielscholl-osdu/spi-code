// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SetupState } from "@spi-code/contracts";

export type ReadinessDot = "attention" | "failure";

/** Red when a tool failed, amber when one needs the operator; none while ready, installing or unchecked. */
export function readinessDot(setup: SetupState | null | undefined): ReadinessDot | null {
  if (!setup) return null;
  if (setup.tools.some((tool) => tool.state === "failed")) return "failure";
  if (setup.tools.some((tool) => tool.state !== "ready" && tool.state !== "installing"))
    return "attention";
  return null;
}

export const READINESS_DOT_LABEL: Record<ReadinessDot, string> = {
  attention: "A tool needs attention",
  failure: "A tool failed",
};
