// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { readRecordSchema } from "./sweep/record.js";

export const serviceRun = z.object({
  id: z.int().positive(),
  workflowId: z.int().positive(),
  name: z.string().trim().min(1),
  path: z.string().min(1).optional(),
  attempt: z.int().positive(),
  status: z.string().min(1),
  conclusion: z.string().optional(),
  createdAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  url: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }),
});

const failure = z.object({
  run: serviceRun,
  job: z.string().optional(),
  step: z.string().optional(),
});

export const serviceRunsFactSchema = z.object({
  history: z.object({
    cut: z.boolean(),
    runs: z.array(serviceRun),
    failures: z.array(failure),
  }).optional(),
  read: readRecordSchema,
  jobs: z.array(readRecordSchema),
});

export type ServiceRun = z.infer<typeof serviceRun>;
export type ServiceRunsFact = z.infer<typeof serviceRunsFactSchema>;

export function readRunHistory(fact: ServiceRunsFact | undefined) {
  return fact?.read.failure === undefined ? fact?.history : undefined;
}

export function workflowPath(path: string | undefined): string | undefined {
  return path?.split("@", 1)[0] || undefined;
}

export function workflowGroups(runs: readonly ServiceRun[]) {
  const groups = new Map<number, ServiceRun[]>();
  for (const run of runs) {
    const group = groups.get(run.workflowId);
    if (group) group.push(run);
    else groups.set(run.workflowId, [run]);
  }
  return [...groups.values()];
}
