// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Tone, ViewSnapshot } from "@spi-code/contracts";

const DEPLOYABLE = { ok: "yes", warn: "no", bad: "no", neutral: "unknown" } as const;

type RunningChange = { tone?: Tone; sub?: string; figure?: string };

/** The environment's Running fact changed, with the deployable state core writes beside that tone. */
export function setRunning<T extends Pick<ViewSnapshot, "briefing">>(
  body: T,
  change: RunningChange,
): T {
  const { environment } = body.briefing;
  const running = environment.facts.find(({ label }) => label === "Running");
  if (!running) throw new Error("The snapshot carries no Running fact");
  Object.assign(running, change);
  if (change.tone) environment.deployable = DEPLOYABLE[change.tone];
  return body;
}

/** The environment with no Running fact, as when core wrote none. */
export function dropRunning<T extends Pick<ViewSnapshot, "briefing">>(body: T): T {
  const { environment } = body.briefing;
  environment.facts = environment.facts.filter(({ label }) => label !== "Running");
  return body;
}
