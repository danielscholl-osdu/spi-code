// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SetupState } from "@spi-code/contracts";

export const OPEN_READINESS_EVENT = "spi-code:open-readiness";

export function openReadiness() {
  window.dispatchEvent(new Event(OPEN_READINESS_EVENT));
}

export function watchNeeds(setup: SetupState): string {
  const tools = setup.tools
    .filter((tool) => tool.state !== "ready")
    .map(({ tool }) => (tool === "copilot" ? "Copilot" : tool));
  return tools.length
    ? `Watch needs ${new Intl.ListFormat("en", { type: "conjunction" }).format(tools)}.`
    : (setup.disabledReason ?? "Watch is ready");
}

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

export type ReadinessLight = "ready" | ReadinessDot;

/** The footer's light: the nav dot, or green once every tool is ready; none before the first check. */
export function readinessLight(setup: SetupState | null | undefined): ReadinessLight | null {
  const dot = readinessDot(setup);
  if (dot || !setup) return dot;
  return setup.tools.every((tool) => tool.state === "ready") ? "ready" : null;
}

export const READINESS_LIGHT_LABEL: Record<ReadinessLight, string> = {
  ready: "Every tool is ready",
  ...READINESS_DOT_LABEL,
};
