// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ForkRuns } from "../facts.js";
import type { UpFork } from "./upstream.js";

const HOUR = 3_600_000;
const GRACE = 15 * 60_000;

export function cascadeMonitor(fork: UpFork, runs: ForkRuns | undefined, now: Date) {
  if (fork.phase !== "merged" || !fork.syncMerged || !runs) return undefined;
  const merge = Date.parse(fork.syncMerged.at);
  if (!Number.isFinite(merge) || merge > now.getTime()) return undefined;
  if (runs.cascade.some((run) => Date.parse(run.createdAt) >= merge)) return undefined;
  const monitor = (Math.floor(merge / HOUR) + 1) * HOUR;
  const deadline = monitor + GRACE;
  const overdue = now.getTime() >= deadline;
  if (runs.cascadeReadAt === null ||
      (runs.cascadeReadAt !== undefined && !(Date.parse(runs.cascadeReadAt) >= (overdue ? deadline : merge))))
    return undefined;
  return {
    merge: fork.syncMerged,
    at: new Date(monitor).toISOString(),
    deadline: new Date(deadline).toISOString(),
    overdue,
  };
}
